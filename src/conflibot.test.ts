import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Conflibot } from "./conflibot";

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@test.invalid", ...args],
    { cwd, encoding: "utf8" },
  );
}

function lines(...overrides: [number, string][]): string {
  const content = Array.from({ length: 12 }, (_, i) => `line${i + 1}`);
  for (const [line, text] of overrides) content[line - 1] = text;
  return content.join("\n") + "\n";
}

// A fixture mirroring what the action sees on a runner: an "upstream"
// repository with refs/pull/<n>/head for three PRs (plus the test merge
// commit refs/pull/1/merge that GitHub would have computed for PR #1),
// and a "runner" clone of it.
//
//   PR #1 (current): changes line 2
//   PR #2: changes lines 2 and 12 -> conflicts with #1
//   PR #3: changes line 4 -> merges cleanly with #1
let dir: string;
let runner: string;
const sha: Record<number, string> = {};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "conflibot-test-"));
  const upstream = join(dir, "upstream");

  git(dir, "init", "-q", "-b", "main", "upstream");
  const commitAll = (message: string): void => {
    git(upstream, "add", ".");
    git(upstream, "commit", "-q", "-m", message);
  };
  const file = join(upstream, "file.txt");

  writeFileSync(file, lines());
  commitAll("base");

  const pr = (number: number, ...overrides: [number, string][]): void => {
    git(upstream, "checkout", "-q", "-b", `pr${number}`, "main");
    writeFileSync(file, lines(...overrides));
    commitAll(`pr${number}`);
    git(upstream, "update-ref", `refs/pull/${number}/head`, "HEAD");
    sha[number] = git(upstream, "rev-parse", "HEAD").trim();
    git(upstream, "checkout", "-q", "main");
  };
  pr(1, [2, "PR1-CHANGE"]);
  pr(2, [2, "PR2-CHANGE"], [12, "PR2-TAIL"]);
  pr(3, [4, "PR3-CHANGE"]);

  // The test merge commit for PR #1: main has not moved, so the merged
  // tree is PR #1's own tree
  const tree = git(upstream, "rev-parse", "refs/pull/1/head^{tree}").trim();
  const mergeCommit = git(
    upstream,
    "commit-tree",
    tree,
    "-p",
    "main",
    "-p",
    "refs/pull/1/head",
    "-m",
    "test merge",
  ).trim();
  git(upstream, "update-ref", "refs/pull/1/merge", mergeCommit);

  runner = join(dir, "runner");
  git(dir, "clone", "-q", upstream, runner);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env["INPUT_GITHUB-TOKEN"] = "dummy";
  delete process.env["INPUT_EXCLUDE"];
  delete process.env["INPUT_FAIL-ON-CONFLICT"];
  delete process.env["INPUT_MAX-RETRIES"];
  delete process.env["INPUT_RETRY-INTERVAL"];
});

describe("detectConflicts", () => {
  const targets = () => [
    { number: 1, headRef: "pr1", headSha: sha[1] },
    { number: 2, headRef: "pr2", headSha: sha[2] },
    { number: 3, headRef: "pr3", headSha: sha[3] },
  ];

  it("reports the conflicting PR, skips itself and clean merges", async () => {
    const conflicts = await new Conflibot(runner).detectConflicts(
      { number: 1, headSha: sha[1] },
      targets(),
    );
    expect(conflicts).toEqual([
      { number: 2, headRef: "pr2", headSha: sha[2], files: ["file.txt"] },
    ]);
  });

  it("applies excluded path patterns", async () => {
    process.env["INPUT_EXCLUDE"] = "*.txt";
    const conflicts = await new Conflibot(runner).detectConflicts(
      { number: 1, headSha: sha[1] },
      targets(),
    );
    expect(conflicts).toEqual([]);
  });

  it("fails loudly when a ref cannot be fetched", async () => {
    await expect(
      new Conflibot(runner).detectConflicts({ number: 999, headSha: "x" }, [
        { number: 999, headRef: "none", headSha: "y" },
      ]),
    ).rejects.toThrow(/git fetch failed/);
  });
});

describe("inputs", () => {
  it("splits exclude into newline-separated patterns", () => {
    process.env["INPUT_EXCLUDE"] = "yarn.lock\n\n**/*.bin\n";
    expect(new Conflibot().excludedPaths).toEqual(["yarn.lock", "**/*.bin"]);
  });

  it("parses fail-on-conflict and retry settings", () => {
    process.env["INPUT_FAIL-ON-CONFLICT"] = "true";
    process.env["INPUT_MAX-RETRIES"] = "10";
    process.env["INPUT_RETRY-INTERVAL"] = "2.5";
    const bot = new Conflibot();
    expect(bot.failOnConflict).toBe(true);
    expect(bot.maxRetries).toBe(10);
    expect(bot.retryInterval).toBe(2.5);
  });

  it("falls back to defaults for missing or invalid values", () => {
    const bot = new Conflibot();
    expect(bot.failOnConflict).toBe(false);
    expect(bot.maxRetries).toBe(5);
    expect(bot.retryInterval).toBe(1);

    process.env["INPUT_MAX-RETRIES"] = "not-a-number";
    expect(new Conflibot().maxRetries).toBe(5);
    process.env["INPUT_MAX-RETRIES"] = "0";
    expect(new Conflibot().maxRetries).toBe(1);
  });
});

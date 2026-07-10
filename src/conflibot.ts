import * as core from "@actions/core";
import * as github from "@actions/github";
import { execFile } from "node:child_process";
import { parseMergeTreeOutput } from "./parse";
import { buildConflictReport, Conflict } from "./report";

type Octokit = ReturnType<typeof github.getOctokit>;

export class Conflibot {
  token: string;
  octokit: Octokit;
  excludedPaths: string[];
  failOnConflict: boolean;
  maxRetries: number;
  retryInterval: number;
  constructor(private readonly cwd: string = process.cwd()) {
    this.token = core.getInput("github-token", { required: true });
    this.octokit = github.getOctokit(this.token);
    this.excludedPaths = core
      .getInput("exclude")
      .split("\n")
      .filter((x) => x !== "");
    this.failOnConflict = core.getInput("fail-on-conflict") === "true";
    const retries = parseInt(core.getInput("max-retries"), 10);
    this.maxRetries = Number.isNaN(retries) ? 5 : Math.max(1, retries);
    const interval = parseFloat(core.getInput("retry-interval"));
    this.retryInterval = Number.isNaN(interval) ? 1 : Math.max(0, interval);
    core.info(`Excluded paths: ${this.excludedPaths}`);
  }

  async setStatus(
    conclusion: "success" | "failure" | "neutral" | undefined = undefined,
    output:
      { title: string; summary: string; text?: string } | undefined = undefined,
  ): Promise<
    ReturnType<
      Octokit["rest"]["checks"]["create"] | Octokit["rest"]["checks"]["update"]
    >
  > {
    const pr = github.context.payload.pull_request;
    if (!pr) throw new Error("The pull request is undefined.");

    const refs = await this.octokit.rest.checks.listForRef({
      ...github.context.repo,
      ref: pr.head.sha,
    });
    const current = refs.data.check_runs.find(
      (check) => check.name == "conflibot/details",
    );
    core.debug(`checks: ${JSON.stringify(refs.data)}`);
    core.debug(`current check: ${JSON.stringify(current)}`);

    const params = {
      ...github.context.repo,
      name: "conflibot/details",
      head_sha: pr.head.sha,
      status: (conclusion ? "completed" : "in_progress") as
        "completed" | "in_progress",
      conclusion,
      output,
    };
    if (current) {
      return this.octokit.rest.checks.update({
        ...params,
        check_run_id: current.id,
      });
    } else {
      return this.octokit.rest.checks.create(params);
    }
  }

  async exit(
    conclusion: "success" | "failure" | "neutral",
    reason: string,
    summary?: string,
  ): Promise<void> {
    core.info(reason);
    await this.setStatus(conclusion, {
      title: reason,
      summary: summary || reason,
      text: reason,
    });
  }

  async run(): Promise<void> {
    try {
      await this.setStatus();
      core.setOutput("conflicts", []);

      const pull = await this.waitForTestMergeCommit(this.maxRetries, {
        owner: github.context.issue.owner,
        repo: github.context.issue.repo,
        pull_number: github.context.issue.number,
      });
      if (!pull.data.mergeable)
        return this.exit("neutral", "PR is not mergeable");

      const pulls = await this.octokit.paginate(this.octokit.rest.pulls.list, {
        ...github.context.repo,
        base: pull.data.base.ref,
        direction: "asc",
      });
      if (pulls.length <= 1)
        return this.exit("success", "No other pulls found.");

      core.info(
        `Simulating merges onto ${pull.data.base.ref} + #${pull.data.number} (${pull.data.head.ref})`,
      );
      const conflicts = await this.detectConflicts(
        { number: pull.data.number, headSha: pull.data.head.sha },
        pulls.map((p) => ({
          number: p.number,
          headRef: p.head.ref,
          headSha: p.head.sha,
        })),
      );

      core.setOutput("conflicts", conflicts);

      if (conflicts.length == 0)
        return this.exit("success", "No potential conflicts found!");

      const report = buildConflictReport(conflicts, github.context.repo);
      await this.setStatus(this.failOnConflict ? "failure" : "neutral", report);
      if (this.failOnConflict) core.setFailed(report.title);
    } catch (error) {
      const detail =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      core.setFailed(detail);
      await this.setStatus("failure", {
        title: "conflibot failed unexpectedly",
        summary: "conflibot failed unexpectedly",
        text: detail,
      }).catch((statusError) => core.error(String(statusError)));
    }
  }

  // Checks every target PR against the current PR's test merge commit
  // and returns the ones that would conflict.
  async detectConflicts(
    current: { number: number; headSha: string },
    targets: { number: number; headRef: string; headSha: string }[],
  ): Promise<Conflict[]> {
    // actions/checkout fetches a single commit by default, but
    // merge-base computation needs history back to where each PR
    // branched off
    const isShallow = (
      await this.git("rev-parse", "--is-shallow-repository")
    ).startsWith("true");
    if (isShallow) await this.git("fetch", "--prune", "--unshallow");

    // refs/pull/<n>/head exists in the base repository even when the
    // PR comes from a fork, and the refspecs are built from PR numbers
    // only, so attacker-controlled branch names never reach git.
    // refs/pull/<n>/merge is the test merge commit GitHub computed for
    // the current PR (guaranteed to exist since mergeable is true).
    await this.git(
      "fetch",
      "origin",
      `+refs/pull/${current.number}/merge:refs/remotes/origin/pr-merge/${current.number}`,
      ...targets.map(
        (p) => `+refs/pull/${p.number}/head:refs/remotes/origin/pr/${p.number}`,
      ),
    );

    const conflicts: Conflict[] = [];
    for (const target of targets) {
      if (current.headSha === target.headSha) {
        core.info(`Skipping #${target.number} (${target.headRef})`);
        continue;
      }
      core.info(`Checking #${target.number} (${target.headRef})`);

      const mergeOutput = await this.mergeTree(
        `origin/pr-merge/${current.number}`,
        `origin/pr/${target.number}`,
      );
      if (mergeOutput === null) continue;

      const conflicted = parseMergeTreeOutput(mergeOutput, this.excludedPaths);
      conflicted.ignored.forEach((file) => core.info(`Ignoring ${file}`));

      if (conflicted.files.length > 0) {
        conflicts.push({
          number: target.number,
          headRef: target.headRef,
          headSha: target.headSha,
          files: conflicted.files,
        });
        core.info(
          `#${target.number} (${target.headRef}) has ${conflicted.files.length} conflict(s)`,
        );
      }
    }
    return conflicts;
  }

  // Runs git with an argument array (no shell) so that branch names and
  // other untrusted strings can never be interpreted as shell syntax.
  private git(...args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        args,
        { cwd: this.cwd, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new Error(`git ${args[0]} failed: ${stderr || error.message}`),
            );
          } else {
            resolve(stdout);
          }
        },
      );
    });
  }

  // Merges two commits in memory with the same strategy a real
  // `git merge` would use (requires git >= 2.38); resolves with null
  // when the merge is clean, or with the NUL-separated list of
  // conflicted files when it is not.
  private mergeTree(ours: string, theirs: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        [
          "merge-tree",
          "--write-tree",
          "--name-only",
          "--no-messages",
          "-z",
          ours,
          theirs,
        ],
        { cwd: this.cwd, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (!error) resolve(null);
          else if (error.code === 1) resolve(stdout);
          else
            reject(
              new Error(`git merge-tree failed: ${stderr || error.message}`),
            );
        },
      );
    });
  }

  private async waitForTestMergeCommit(
    times: number,
    pr: {
      owner: string;
      repo: string;
      pull_number: number;
    },
  ): Promise<Awaited<ReturnType<Octokit["rest"]["pulls"]["get"]>>> {
    return this.octokit.rest.pulls.get(pr).then((result) => {
      if (result.data.mergeable !== null) return result;
      if (times <= 1)
        throw new Error("Timed out while waiting for a test merge commit");
      return new Promise((resolve) =>
        setTimeout(
          () => resolve(this.waitForTestMergeCommit(times - 1, pr)),
          this.retryInterval * 1000,
        ),
      );
    });
  }
}

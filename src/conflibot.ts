import * as core from "@actions/core";
import * as github from "@actions/github";
import { execFile, spawn } from "node:child_process";
import { parsePatchFailures } from "./parse";
import { buildConflictReport, Conflict } from "./report";

type Octokit = ReturnType<typeof github.getOctokit>;

export class Conflibot {
  token: string;
  octokit: Octokit;
  excludedPaths: string[];
  constructor() {
    this.token = core.getInput("github-token", { required: true });
    this.octokit = github.getOctokit(this.token);
    this.excludedPaths = core
      .getInput("exclude")
      .split("\n")
      .filter((x) => x !== "");
    core.info(`Excluded paths: ${this.excludedPaths}`);
  }

  async setStatus(
    conclusion: "success" | "failure" | "neutral" | undefined = undefined,
    output:
      | { title: string; summary: string; text?: string }
      | undefined = undefined,
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
        | "completed"
        | "in_progress",
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

      const pull = await this.waitForTestMergeCommit(5, {
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

      // actions/checkout is optimized to fetch a single commit by default
      const isShallow = (
        await this.git("rev-parse", "--is-shallow-repository")
      ).startsWith("true");
      if (isShallow) await this.git("fetch", "--prune", "--unshallow");

      // refs/pull/<n>/head exists in the base repository even when the
      // PR comes from a fork, and the refspec is built from PR numbers
      // only, so attacker-controlled branch names never reach git.
      const numbers = new Set(pulls.map((p) => p.number));
      numbers.add(pull.data.number);
      await this.git(
        "fetch",
        "origin",
        ...[...numbers].map(
          (n) => `+refs/pull/${n}/head:refs/remotes/origin/pr/${n}`,
        ),
      );

      // actions/checkout checks out the base branch on pull_request_target
      await this.git("checkout", "--detach", `origin/pr/${pull.data.number}`);

      core.info(
        `First, merging ${pull.data.base.ref} into ${pull.data.head.ref}`,
      );
      await this.git(
        "-c",
        "user.name=conflibot",
        "-c",
        "user.email=dummy@conflibot.invalid",
        "merge",
        `origin/${pull.data.base.ref}`,
        "--no-edit",
      );

      const conflicts: Conflict[] = [];
      for (const target of pulls) {
        if (pull.data.head.sha === target.head.sha) {
          core.info(`Skipping #${target.number} (${target.head.ref})`);
          continue;
        }
        core.info(`Checking #${target.number} (${target.head.ref})`);

        const patch = await this.git(
          "format-patch",
          `origin/${pull.data.base.ref}..origin/pr/${target.number}`,
          "--stdout",
        );
        if (patch === "") {
          core.info(`#${target.number} has no commits beyond the base`);
          continue;
        }

        const applyError = await this.applyCheck(patch);
        if (applyError === null) continue;
        // Patch application error expected.  Throw an error if not.
        if (!applyError.includes("patch does not apply")) {
          throw new Error(applyError);
        }

        const failures = parsePatchFailures(applyError, this.excludedPaths);
        failures.ignored.forEach((file) => core.info(`Ignoring ${file}`));

        if (failures.files.length > 0) {
          conflicts.push({
            number: target.number,
            headRef: target.head.ref,
            headSha: target.head.sha,
            files: failures.files,
          });
          core.info(
            `#${target.number} (${target.head.ref}) has ${failures.files.length} conflict(s)`,
          );
        }
      }

      if (conflicts.length == 0)
        return this.exit("success", "No potential conflicts found!");

      const report = buildConflictReport(conflicts, github.context.repo);
      await this.setStatus("neutral", report);
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

  // Runs git with an argument array (no shell) so that branch names and
  // other untrusted strings can never be interpreted as shell syntax.
  private git(...args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        args,
        { maxBuffer: 64 * 1024 * 1024 },
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

  // Resolves with null when the patch applies cleanly, or with git's
  // stderr when it does not.
  private applyCheck(patch: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const child = spawn("git", ["apply", "--check"], {
        stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(null);
        else resolve(stderr);
      });
      // git may exit before consuming all of its stdin; ignore the EPIPE
      child.stdin.on("error", () => undefined);
      child.stdin.end(patch);
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
      if (times == 1) throw "Timed out while waiting for a test merge commit";
      return new Promise((resolve) =>
        setTimeout(
          () => resolve(this.waitForTestMergeCommit(times - 1, pr)),
          1000,
        ),
      );
    });
  }
}

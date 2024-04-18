import * as core from "@actions/core";
import * as github from "@actions/github";
import { exec } from "child_process";
import multimatch from "multimatch";

type Octokit = ReturnType<typeof github.getOctokit>;

class Conflibot {
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

  exit(
    conclusion: "success" | "failure" | "neutral",
    reason: string,
    summary?: string,
  ): void {
    core.info(reason);
    this.setStatus(conclusion, {
      title: reason,
      summary: summary || reason,
      text: reason,
    });
  }

  async run(): Promise<void> {
    const remotes = ["origin"];
    try {
      await this.setStatus();

      const pull = await this.waitForTestMergeCommit(5, {
        owner: github.context.issue.owner,
        repo: github.context.issue.repo,
        pull_number: github.context.issue.number,
      });
      if (!pull.data.mergeable)
        return this.exit("neutral", "PR is not mergable");

      const pulls = await this.octokit.rest.pulls.list({
        ...github.context.repo,
        base: pull.data.base.ref,
        direction: "asc",
      });
      if (pulls.data.length <= 1)
        return this.exit("success", "No other pulls found.");

      // actions/checkout@v2 is optimized to fetch a single commit by default
      const isShallow = (
        await this.system("git rev-parse --is-shallow-repository")
      )[0].startsWith("true");
      if (isShallow) await this.system("git fetch --prune --unshallow");

      // actions/checkout@v2 checks out a merge commit by default
      await this.system(`git checkout ${pull.data.head.ref}`);

      core.info(
        `First, merging ${pull.data.base.ref} into ${pull.data.head.ref}`,
      );
      await this.system(
        `git -c user.name=conflibot -c user.email=dummy@conflibot.invalid merge origin/${pull.data.base.ref} --no-edit`,
      );

      type PullsListResponse = Awaited<
        ReturnType<Octokit["rest"]["pulls"]["list"]>
      >;
      const conflicts: Array<[PullsListResponse["data"][0], Array<string>]> =
        [];
      for (const target of pulls.data) {
        if (pull.data.head.sha === target.head.sha) {
          core.info(`Skipping #${target.number} (${target.head.ref})`);
          continue;
        }
        core.info(`Checking #${target.number} (${target.head.ref})`);
        if (!remotes.includes(target.head.repo.owner.login)) {
          await this.system(
            `git remote add ${target.head.repo.owner.login} ${target.head.repo.url}`,
          );
          await this.system(
            `git fetch ${target.head.repo.owner.login} --all`,
          );
        }
        await this.system(
          `git format-patch origin/${pull.data.base.ref}.. ${target.head.repo.owner.login}/${target.head.ref} --stdout | git apply --check`,
        ).catch((reason: [string, string, string]) => {
          // Patch application error expected.  Throw an error if not.
          if (!reason.toString().includes("patch does not apply")) {
            throw reason[2];
          }

          const patchFails: Array<string> = [];
          for (const match of reason[2].matchAll(
            /error: patch failed: ((.*):\d+)/g,
          )) {
            if (multimatch(match[2], this.excludedPaths).length > 0) {
              core.info(`Ignoring ${match[2]}`);
            } else {
              patchFails.push(match[1]);
            }
            core.debug(JSON.stringify(match));
          }

          const files = [...new Set(patchFails)]; // unique
          if (files.length > 0) {
            conflicts.push([target, files]);
            core.info(
              `#${target.number} (${target.head.ref}) has ${files.length} conflict(s)`,
            );
          }
        });
      }

      if (conflicts.length == 0)
        return this.exit("success", "No potential conflicts found!");

      const text = conflicts
        .map((conflict) => {
          const branch = conflict[0].head.ref;
          const sha = conflict[0].head.sha;
          const baseUrl =
            `https://github.com/${github.context.repo.owner}/` +
            `${github.context.repo.repo}`;

          return (
            `- #${conflict[0].number} ([${branch}](${baseUrl}/tree/${branch}))\n` +
            conflict[1]
              .map((file) => {
                const match = file.match(/^(.*):(\d)$/);
                if (!match) return `  - ${file}`;
                return `  - [${file}](${baseUrl}/blob/${sha}/${match[1]}#L${match[2]})`;
              })
              .join("\n")
          );
        })
        .join("\n");

      const sum = conflicts.map((c) => c[1].length).reduce((p, c) => p + c);
      const summary = `Found ${sum} potential conflict(s) in ${conflicts.length} other PR(s)!`;
      await this.setStatus("neutral", { title: summary, summary, text });
    } catch (error) {
      this.exit("failure", JSON.stringify(error), "Error!");
    }
  }

  private system(command: string): Promise<[string, string]> {
    return new Promise((resolve, reject) => {
      exec(command, (error, stdout, stderr) => {
        error ? reject([error, stdout, stderr]) : resolve([stdout, stderr]);
      });
    });
  }

  private async waitForTestMergeCommit(
    times: number,
    pr: {
      owner: string;
      repo: string;
      pull_number: number;
    },
  ): ReturnType<Octokit["rest"]["pulls"]["get"]> {
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

new Conflibot().run();

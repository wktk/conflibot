import * as core from "@actions/core";
import * as github from "@actions/github";
import { Octokit } from "@octokit/rest";
import { exec } from "child_process";

class Conflibot {
  token: string;
  octokit: github.GitHub;
  constructor() {
    this.token = core.getInput("github-token", { required: true });
    this.octokit = new github.GitHub(this.token);
  }

  async setStatus(
    conclusion: "success" | "failure" | "neutral" | undefined = undefined,
    output:
      | { title: string; summary: string; text?: string }
      | undefined = undefined
  ): Promise<
    Octokit.Response<
      Octokit.ChecksUpdateResponse | Octokit.ChecksCreateResponse
    >
  > {
    const refs = await this.octokit.checks.listForRef({
      ...github.context.repo,
      ref: github.context.ref
    });
    const current = refs.data.check_runs.find(check => check.name == "details");

    const params = {
      ...github.context.repo,
      name: "details",
      head_sha: (github.context.payload
        .pull_request as Octokit.PullsGetResponse).head.sha,
      status: (conclusion ? "completed" : "in_progress") as
        | "completed"
        | "in_progress",
      conclusion,
      output
    };
    if (current) {
      return this.octokit.checks.update({
        ...params,
        check_run_id: current.id
      });
    } else {
      return this.octokit.checks.create(params);
    }
  }

  exit(
    conclusion: "success" | "failure" | "neutral",
    reason: string,
    summary?: string
  ): void {
    core.info(reason);
    this.setStatus(conclusion, {
      title: reason,
      summary: summary || reason,
      text: reason
    });
  }

  async run(): Promise<void> {
    try {
      this.setStatus();

      const pull = await this.waitForTestMergeCommit(5, github.context.issue);
      if (!pull.data.mergeable)
        return this.exit("neutral", "PR is not mergable");

      const pulls = await this.octokit.pulls.list({
        ...github.context.repo,
        base: pull.data.base.ref,
        direction: "asc"
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
        `First, merging ${pull.data.base.ref} into ${pull.data.head.ref}`
      );
      await this.system(`git merge origin/${pull.data.base.ref} --no-edit`);

      const conflicts: Array<[
        Octokit.PullsListResponseItem,
        Array<string>
      ]> = [];
      for (const target of pulls.data) {
        if (pull.data.head.sha === target.head.sha) {
          core.info(`Skipping #${target.number} (${target.head.ref})`);
          continue;
        }
        core.info(`Checking #${target.number} (${target.head.ref})`);

        await this.system(
          `git format-patch origin/${pull.data.base.ref}..origin/${target.head.ref} --stdout | git apply --check`
        ).catch((reason: [string, string, string]) => {
          // Patch application error expected.  Throw an error if not.
          if (!reason.toString().includes("patch does not apply")) {
            throw reason[2];
          }

          const patchFails: Array<string> = [];
          for (const match of reason[2].matchAll(
            /error: patch failed: (.*)/g
          )) {
            patchFails.push(match[1]);
          }

          const files = [...new Set(patchFails)]; // unique
          conflicts.push([target, files]);
          core.info(
            `#${target.number} (${target.head.ref}) has ${files.length} conflict(s)`
          );
        });
      }

      if (conflicts.length == 0)
        return this.exit("success", "No conflicts found!");

      const text = `Found some potential conflicts:\n${conflicts
        .map(
          conflict =>
            `- #${conflict[0].number}\n${conflict[1]
              .map(file => `  - ${file}`)
              .join("\n")}`
        )
        .join("\n")}`;

      const sum = conflicts.map(c => c[1].length).reduce((p, c) => p + c);
      const files = conflicts.length;
      const summary = `Found ${sum} potential conflict(s) in ${files} file(s)!`;
      this.setStatus("neutral", { title: summary, summary, text });
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
      number: number;
    }
  ): Promise<Octokit.Response<Octokit.PullsGetResponse>> {
    return this.octokit.pulls.get(pr).then(result => {
      if (result.data.mergeable !== null) return result;
      if (times == 1) throw "Timed out while waiting for a test merge commit";
      return new Promise(resolve =>
        setTimeout(
          () => resolve(this.waitForTestMergeCommit(times - 1, pr)),
          1000
        )
      );
    });
  }
}

new Conflibot().run();

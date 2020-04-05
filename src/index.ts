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

  async run(): Promise<void> {
    try {
      const { owner, repo, number } = github.context.issue;
      const pull = await this.waitForTestMergeCommit(5, owner, repo, number);
      if (!pull.data.mergeable)
        return core.info("Skipping as the PR is not mergable");

      const pulls = await this.octokit.pulls.list({
        owner,
        repo,
        base: pull.data.base.ref,
        direction: "asc"
      });
      if (pulls.data.length <= 1) return core.info("no pulls found.");

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

      if (conflicts.length == 0) return core.info("No conflicts found!");

      const body = `Found some potential conflicts:\n${conflicts
        .map(
          conflict =>
            `- #${conflict[0].number}\n${conflict[1]
              .map(file => `  - ${file}`)
              .join("\n")}`
        )
        .join("\n")}`;
      this.octokit.issues.createComment({
        owner,
        repo,
        issue_number: number,
        body
      });
    } catch (error) {
      console.error(error);
      core.setFailed("error!");
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
    owner: string,
    repo: string,
    number: number
  ): Promise<Octokit.Response<Octokit.PullsGetResponse>> {
    return this.octokit.pulls
      .get({ owner, repo, pull_number: number })
      .then(result => {
        if (result.data.mergeable !== null) return result;
        if (times == 1) throw "Timed out while waiting for a test merge commit";
        return new Promise(resolve =>
          setTimeout(
            () =>
              resolve(
                this.waitForTestMergeCommit(times - 1, owner, repo, number)
              ),
            1000
          )
        );
      });
  }
}

new Conflibot().run();

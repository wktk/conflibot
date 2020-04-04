import * as core from "@actions/core";
import * as github from "@actions/github";
import { Octokit } from "@octokit/rest";
import { exec } from "child_process";

const system: (command: string) => Promise<[string, string]> = command =>
  new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      error ? reject([error, stdout, stderr]) : resolve([stdout, stderr]);
    });
  });

const token = core.getInput("github-token", { required: true });
const octokit = new github.GitHub(token);

async function waitForTestMergeCommit(
  times: number,
  owner: string,
  repo: string,
  number: number
): Promise<Octokit.Response<Octokit.PullsGetResponse>> {
  return octokit.pulls.get().then(result => {
    if (result.data.mergeable !== null) return result;
    if (times == 1) throw "Timed out while waiting for a test merge commit";
    return new Promise(resolve =>
      setTimeout(
        () => resolve(waitForTestMergeCommit(times - 1, owner, repo, number)),
        1000
      )
    );
  });
}

async function run(): Promise<void> {
  try {
    const { owner, repo, number } = github.context.issue;
    const pull = await waitForTestMergeCommit(5, owner, repo, number);
    if (!pull.data.mergeable)
      return core.info("Skipping as the PR is not mergable");

    const pulls = await octokit.pulls.list({
      owner,
      repo,
      base: pull.data.base.ref,
      direction: "asc"
    });

    await system("git fetch");
    await system(`git checkout ${pull.data.merge_commit_sha}`);

    const conflicts: Array<[Octokit.PullsListResponseItem, Array<string>]> = [];
    for (const target of pulls.data) {
      await system(
        `git format-patch ${pull.data.base.ref}..${target.head.ref} --stdout | git apply --check`
      ).catch(reason => {
        const files: Array<string> = [];
        for (const match of reason[2].matchAll(/error: patch failed: (.*)/g)) {
          files.push(match[1]);
        }
        conflicts.push([target, files]);
        core.debug(
          `#${target.number} (${target.head.ref}) has ${files.length} conflict(s)`
        );
      });
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();

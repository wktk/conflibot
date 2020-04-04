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
  return octokit.pulls
    .get({ owner, repo, pull_number: number })
    .then(result => {
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
    if (pulls.data.length <= 1) return core.info("no pulls found.");

    // actions/checkout@v2 is optimized to fetch a single commit by default
    const isShallow = (
      await system("git rev-parse --is-shallow-repository")
    )[0].startsWith("true");
    if (isShallow) await system("git fetch --prune --unshallow");

    // actions/checkout@v2 checks out a merge commit by default
    await system(`git checkout ${pull.data.head.ref}`);

    core.info(
      `First, merging ${pull.data.base.ref} into ${pull.data.head.ref}`
    );
    await system(`git merge origin/${pull.data.base.ref} --no-edit`);

    const conflicts: Array<[Octokit.PullsListResponseItem, Array<string>]> = [];
    for (const target of pulls.data) {
      if (pull.data.head.sha === target.head.sha) {
        core.info(`Skipping #${target.number} (${target.head.ref})`);
        continue;
      }
      core.info(`Checking #${target.number} (${target.head.ref})`);

      await system(
        `git format-patch origin/${pull.data.base.ref}..origin/${target.head.ref} --stdout | git apply --check`
      ).catch((reason: [string, string, string]) => {
        // Patch application error expected.  Throw an error if not.
        if (!reason.toString().includes("patch does not apply")) {
          throw reason[2];
        }

        const patchFails: Array<string> = [];
        for (const match of reason[2].matchAll(/error: patch failed: (.*)/g)) {
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
    octokit.issues.createComment({ owner, repo, issue_number: number, body });
  } catch (error) {
    console.error(error);
    core.setFailed("error!");
  }
}

run();

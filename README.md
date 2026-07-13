# conflibot

Warn in advance when merging a pull request will cause conflicts in other open pull requests.

For every other open PR with the same base branch, conflibot checks whether it would still merge cleanly after the current PR is merged, and reports the result as a `conflibot/details` check run with links to the conflicting files.

## Configuration

```yaml
name: conflibot
on: pull_request_target

permissions:
  checks: write
  contents: read
  pull-requests: read

jobs:
  conflibot:
    runs-on: ubuntu-slim
    steps:
      - uses: actions/checkout@v7
      - name: Warn about potential conflicts
        uses: wktk/conflibot@v2
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          exclude: |
            yarn.lock
            **/*.bin
```

The `pull_request_target` event is used so the check can be reported with write permissions even for PRs from forks. conflibot only reads PR contents through `refs/pull/*/head` and `refs/pull/*/merge`; it never executes code from the PR, and it never modifies the checked-out working tree.

Conflict detection uses `git merge-tree`, so the runner needs git 2.38 or later (GitHub-hosted runners all qualify; only older self-hosted runners may need a git upgrade).

### Inputs

| Name | Default | Description |
| ---- | ------- | ----------- |
| `github-token` | (required) | GitHub API token with permission to write check runs (usually `secrets.GITHUB_TOKEN`) |
| `exclude` | | Paths to exclude from conflict detection, as **newline-separated** glob patterns |
| `fail-on-conflict` | `false` | Report the check as `failure` and fail the step when potential conflicts are found, instead of reporting a `neutral` check |
| `max-retries` | `5` | How many times to poll for GitHub's test merge commit before giving up |
| `retry-interval` | `1` | Seconds to wait between test merge commit polls |

### Outputs

| Name | Description |
| ---- | ----------- |
| `conflicts` | Potential conflicts as a JSON array of `{number, headRef, headSha, files}` objects, where `files` lists the conflicting file paths; `[]` when none are found |

Follow-up steps can read the output, for example to post a comment or notify a chat tool:

```yaml
      - name: Warn about potential conflicts
        id: conflibot
        uses: wktk/conflibot@v2
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
      - name: Show conflicts
        if: ${{ steps.conflibot.outputs.conflicts != '[]' }}
        run: echo '${{ steps.conflibot.outputs.conflicts }}'
```

## How it works

1. Wait until GitHub finishes computing the test merge commit (`refs/pull/<n>/merge`) for the current PR; skip with a neutral check if the PR is not mergeable.
2. List every other open PR with the same base branch (paginated, so large repositories are fully covered).
3. Fetch `refs/pull/<n>/head` for all of them (works for forks too) and the current PR's test merge commit.
4. For each other PR, run `git merge-tree --write-tree` between the test merge commit and that PR's head — an in-memory merge using the same strategy as a real `git merge`, without touching the working tree. Files that would conflict are reported.

## Upgrading from v1

v2 changes how conflicts are detected and what the runner needs:

- **Runner requirements**: a runner with node24 support and git 2.38
  or later. All current GitHub-hosted runners qualify; only older
  self-hosted runners may need an upgrade.
- **More accurate detection**: conflicts are found with an in-memory
  `git merge-tree` (the same merge a real `git merge` performs)
  instead of testing patch application. Changes that merely touch
  nearby lines are no longer reported as false conflicts, and PRs
  from forks are now checked correctly.
- **Report format**: conflicts are reported per file and link to the
  file in the other PR; v1 linked to individual line numbers, which
  the patch-based detection produced but a real merge does not.
- **No working tree changes**: v1 checked out the PR branch and
  created a merge commit in the job's working copy; v2 leaves the
  checkout untouched, so follow-up steps see the repository exactly
  as `actions/checkout` left it.
- **New options**: `fail-on-conflict`, `max-retries`, and
  `retry-interval` inputs, and a `conflicts` JSON output for
  follow-up steps. Existing workflows keep working without changes
  (other than pointing at `@v2`).

## Development

```console
$ yarn install
$ yarn test        # unit tests (vitest)
$ yarn lint        # eslint
$ yarn typecheck   # tsc --noEmit
$ yarn package     # bundle dist/index.js with ncc
```

Pull requests do not need to include a rebuilt `dist/`: CI bundles
each PR's source and runs the test suite (including a smoke test of
the bundle) against that build, and after the merge the `update-dist`
workflow opens a PR that syncs the rebuilt `dist/` to master. This
also lets Renovate and Dependabot PRs merge automatically once CI is
green.

When cutting a release, tag only after the `update-dist` PR for your
merge has landed; the `verify-release` workflow rebuilds the bundle
for every `v*` tag and fails if the tagged `dist/` does not match its
source.

## Screenshots

![](./misc/checks.png)
![](./misc/details.png)

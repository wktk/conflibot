export interface Conflict {
  number: number;
  headRef: string;
  headSha: string;
  files: string[];
}

export interface Report {
  title: string;
  summary: string;
  text: string;
}

export function buildConflictReport(
  conflicts: Conflict[],
  repo: { owner: string; repo: string },
): Report {
  const baseUrl = `https://github.com/${repo.owner}/${repo.repo}`;

  const text = conflicts
    .map((conflict) => {
      return (
        `- #${conflict.number} ([${conflict.headRef}](${baseUrl}/tree/${conflict.headRef}))\n` +
        conflict.files
          .map((file) => {
            const match = file.match(/^(.*):(\d)$/);
            if (!match) return `  - ${file}`;
            return `  - [${file}](${baseUrl}/blob/${conflict.headSha}/${match[1]}#L${match[2]})`;
          })
          .join("\n")
      );
    })
    .join("\n");

  const sum = conflicts
    .map((c) => c.files.length)
    .reduce((previous, current) => previous + current);
  const summary = `Found ${sum} potential conflict(s) in ${conflicts.length} other PR(s)!`;

  return { title: summary, summary, text };
}

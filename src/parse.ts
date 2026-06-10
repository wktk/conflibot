import multimatch from "multimatch";

export interface ConflictedFiles {
  files: string[];
  ignored: string[];
}

// `git merge-tree --write-tree --name-only --no-messages -z` outputs the
// result tree OID followed by the conflicted file names, all
// NUL-terminated. Drop the OID and apply the excluded path patterns.
export function parseMergeTreeOutput(
  output: string,
  excludedPaths: string[],
): ConflictedFiles {
  const entries = output.split("\0").filter((x) => x !== "");
  const files: string[] = [];
  const ignored: string[] = [];
  for (const file of entries.slice(1)) {
    if (multimatch(file, excludedPaths).length > 0) {
      ignored.push(file);
    } else {
      files.push(file);
    }
  }
  return { files, ignored };
}

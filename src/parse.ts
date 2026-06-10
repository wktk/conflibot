import multimatch from "multimatch";

export interface PatchFailures {
  files: string[];
  ignored: string[];
}

// `git apply --check` reports each rejected hunk as
// "error: patch failed: <file>:<line>"; collect unique <file>:<line>
// entries, dropping files that match the excluded path patterns.
export function parsePatchFailures(
  stderr: string,
  excludedPaths: string[],
): PatchFailures {
  const files: string[] = [];
  const ignored: string[] = [];
  for (const match of stderr.matchAll(/error: patch failed: ((.*):\d+)/g)) {
    if (multimatch(match[2], excludedPaths).length > 0) {
      ignored.push(match[2]);
    } else {
      files.push(match[1]);
    }
  }
  return { files: [...new Set(files)], ignored: [...new Set(ignored)] };
}

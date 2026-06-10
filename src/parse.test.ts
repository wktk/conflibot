import { describe, expect, it } from "vitest";
import { parsePatchFailures } from "./parse";

const stderr = [
  "error: patch failed: src/app.ts:12",
  "error: src/app.ts: patch does not apply",
  "error: patch failed: yarn.lock:1024",
  "error: yarn.lock: patch does not apply",
  "error: patch failed: docs/readme.md:3",
  "error: docs/readme.md: patch does not apply",
].join("\n");

describe("parsePatchFailures", () => {
  it("collects file:line entries from git apply stderr", () => {
    const result = parsePatchFailures(stderr, []);
    expect(result.files).toEqual([
      "src/app.ts:12",
      "yarn.lock:1024",
      "docs/readme.md:3",
    ]);
    expect(result.ignored).toEqual([]);
  });

  it("drops files matching excluded path patterns", () => {
    const result = parsePatchFailures(stderr, ["yarn.lock", "docs/**"]);
    expect(result.files).toEqual(["src/app.ts:12"]);
    expect(result.ignored).toEqual(["yarn.lock", "docs/readme.md"]);
  });

  it("deduplicates repeated failures in the same file", () => {
    const repeated = [
      "error: patch failed: src/app.ts:12",
      "error: patch failed: src/app.ts:12",
    ].join("\n");
    expect(parsePatchFailures(repeated, []).files).toEqual(["src/app.ts:12"]);
  });

  it("returns nothing for unrelated stderr", () => {
    const result = parsePatchFailures("fatal: bad revision 'origin/x'", []);
    expect(result.files).toEqual([]);
    expect(result.ignored).toEqual([]);
  });
});

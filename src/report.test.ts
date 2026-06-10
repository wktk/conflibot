import { describe, expect, it } from "vitest";
import { buildConflictReport } from "./report";

const repo = { owner: "wktk", repo: "conflibot" };

describe("buildConflictReport", () => {
  it("summarizes conflict and file counts", () => {
    const report = buildConflictReport(
      [
        {
          number: 2,
          headRef: "feature-a",
          headSha: "aaa111",
          files: ["src/app.ts:12", "src/util.ts:3"],
        },
        {
          number: 5,
          headRef: "feature-b",
          headSha: "bbb222",
          files: ["src/app.ts:12"],
        },
      ],
      repo,
    );
    expect(report.summary).toBe(
      "Found 3 potential conflict(s) in 2 other PR(s)!",
    );
    expect(report.title).toBe(report.summary);
  });

  it("links each file to the conflicting line, including multi-digit lines", () => {
    const report = buildConflictReport(
      [
        {
          number: 2,
          headRef: "feature-a",
          headSha: "aaa111",
          files: ["src/app.ts:12"],
        },
      ],
      repo,
    );
    expect(report.text).toContain(
      "- #2 ([feature-a](https://github.com/wktk/conflibot/tree/feature-a))",
    );
    expect(report.text).toContain(
      "  - [src/app.ts:12](https://github.com/wktk/conflibot/blob/aaa111/src/app.ts#L12)",
    );
  });

  it("falls back to plain text for entries without a line number", () => {
    const report = buildConflictReport(
      [{ number: 2, headRef: "a", headSha: "aaa", files: ["weird-entry"] }],
      repo,
    );
    expect(report.text).toContain("  - weird-entry");
  });
});

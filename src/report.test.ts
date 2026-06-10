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
          files: ["src/app.ts", "src/util.ts"],
        },
        {
          number: 5,
          headRef: "feature-b",
          headSha: "bbb222",
          files: ["src/app.ts"],
        },
      ],
      repo,
    );
    expect(report.summary).toBe(
      "Found 3 potential conflict(s) in 2 other PR(s)!",
    );
    expect(report.title).toBe(report.summary);
  });

  it("links each PR to its branch and each file to the target's blob", () => {
    const report = buildConflictReport(
      [
        {
          number: 2,
          headRef: "feature-a",
          headSha: "aaa111",
          files: ["src/app.ts"],
        },
      ],
      repo,
    );
    expect(report.text).toContain(
      "- #2 ([feature-a](https://github.com/wktk/conflibot/tree/feature-a))",
    );
    expect(report.text).toContain(
      "  - [src/app.ts](https://github.com/wktk/conflibot/blob/aaa111/src/app.ts)",
    );
  });
});

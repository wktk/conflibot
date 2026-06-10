import { describe, expect, it } from "vitest";
import { parseMergeTreeOutput } from "./parse";

const oid = "393d3320cab4a94651cc9b46472973a6663a5b08";

describe("parseMergeTreeOutput", () => {
  it("drops the result tree OID and collects conflicted files", () => {
    const output = `${oid}\0src/app.ts\0yarn.lock\0docs/readme.md\0`;
    const result = parseMergeTreeOutput(output, []);
    expect(result.files).toEqual(["src/app.ts", "yarn.lock", "docs/readme.md"]);
    expect(result.ignored).toEqual([]);
  });

  it("drops files matching excluded path patterns", () => {
    const output = `${oid}\0src/app.ts\0yarn.lock\0docs/readme.md\0`;
    const result = parseMergeTreeOutput(output, ["yarn.lock", "docs/**"]);
    expect(result.files).toEqual(["src/app.ts"]);
    expect(result.ignored).toEqual(["yarn.lock", "docs/readme.md"]);
  });

  it("returns nothing for a clean merge (OID only)", () => {
    const result = parseMergeTreeOutput(`${oid}\0`, []);
    expect(result.files).toEqual([]);
    expect(result.ignored).toEqual([]);
  });
});

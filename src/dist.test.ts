import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const bundle = fileURLToPath(new URL("../dist/index.js", import.meta.url));

// Loads the bundled action the same way the runner does. Without a
// pull_request payload it must reach our own error handling ("The pull
// request is undefined.") and exit non-zero; failing to even load
// (e.g. a bundling regression after a dependency update) fails here.
describe("dist/index.js", () => {
  it("loads and fails gracefully without a pull request context", async () => {
    // Strip the host's GitHub Actions variables so the bundle sees no
    // event payload regardless of where the test runs
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.startsWith("GITHUB_")) env[key] = value;
    }
    env["INPUT_GITHUB-TOKEN"] = "dummy";

    const result = await new Promise<{
      code: number | string | null;
      output: string;
    }>((resolve, reject) => {
      execFile(process.execPath, [bundle], { env }, (error, stdout, stderr) => {
        if (error && error.code === undefined) reject(error);
        else resolve({ code: error?.code ?? 0, output: stdout + stderr });
      });
    });

    expect(result.output).toContain("The pull request is undefined.");
    expect(result.code).toBe(1);
  });
});

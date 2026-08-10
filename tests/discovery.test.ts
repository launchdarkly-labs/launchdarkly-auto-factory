import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { discoverNewReleaseFlags, type GitHubClient } from "@auto-factory/beacon";

/** Duck-typed fake GitHub client: pr-1 exists at both refs, pr-2 only at current. */
const fakeGh = {
  async listDir(_repo: unknown, _dir: string, ref: string): Promise<string[]> {
    return ref === "old" ? ["pr-1.json"] : ["pr-1.json", "pr-2.json", "notes.txt"];
  },
  async getFileJson(_repo: unknown, path: string): Promise<unknown> {
    if (path.endsWith("pr-2.json")) return { flagKey: "new-flag", scope: "backend" };
    return { flagKey: "old-flag" };
  },
} as unknown as GitHubClient;

describe("discoverNewReleaseFlags", () => {
  it("returns only files new at the current SHA (and only valid JSON release-flags)", async () => {
    const found = await discoverNewReleaseFlags(fakeGh, { owner: "o", name: "r" }, ".release-flags/", "new", "old");
    assert.equal(found.length, 1);
    assert.equal(found[0]?.flagKey, "new-flag");
    assert.equal(found[0]?.scope, "backend");
    assert.equal(found[0]?.sourceFile, ".release-flags/pr-2.json");
  });

  it("treats everything as new when there is no previous SHA", async () => {
    const found = await discoverNewReleaseFlags(fakeGh, { owner: "o", name: "r" }, ".release-flags/", "new", undefined);
    // pr-1 + pr-2 are .json; notes.txt is ignored; pr-1 parses to a valid flag too
    assert.deepEqual(found.map((f) => f.flagKey).sort(), ["new-flag", "old-flag"]);
  });

  // Round seven, finding 5: one malformed manifest must not abort ALL of discovery.
  // getFileJson does a bare JSON.parse (github.ts), so a syntactically invalid file
  // threw out of the whole loop; the handler then 502'd WITHOUT recording the SHA,
  // and every later notification re-diffed the same range into the same throw —
  // permanently blocking every other manifest in the range, with a log that never
  // named the file.
  it("skips a manifest that is not valid JSON and discovers the rest", async () => {
    const gh = {
      async listDir(): Promise<string[]> {
        return ["pr-bad.json", "pr-good.json"];
      },
      async getFileJson(_repo: unknown, path: string): Promise<unknown> {
        // The real input shape: github.ts base64-decodes then JSON.parse's, so a
        // malformed committed file surfaces as exactly a SyntaxError.
        if (path.endsWith("pr-bad.json")) return JSON.parse("{not json");
        return { flagKey: "good-flag", scope: "backend" };
      },
    } as unknown as GitHubClient;
    const found = await discoverNewReleaseFlags(gh, { owner: "o", name: "r" }, ".release-flags/", "new", undefined);
    // The malformed file cannot have a release to protect; the good one must not
    // be held hostage by it.
    assert.deepEqual(found.map((f) => f.flagKey), ["good-flag"]);
  });

  it("still aborts discovery on a TRANSIENT read failure (those must retry via 502)", async () => {
    const gh = {
      async listDir(): Promise<string[]> {
        return ["pr-1.json"];
      },
      async getFileJson(): Promise<unknown> {
        throw new Error("GitHub /repos/o/r/contents failed: HTTP 502 — bad gateway");
      },
    } as unknown as GitHubClient;
    await assert.rejects(
      discoverNewReleaseFlags(gh, { owner: "o", name: "r" }, ".release-flags/", "new", undefined),
      /HTTP 502/,
    );
  });
});

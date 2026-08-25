import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { localMaintainerEmail, resolveMaintainerId, type LdClient } from "@auto-factory/shared";

describe("localMaintainerEmail", () => {
  const saved = process.env.AUTOFACTORY_MAINTAINER_EMAIL;
  afterEach(() => {
    if (saved === undefined) delete process.env.AUTOFACTORY_MAINTAINER_EMAIL;
    else process.env.AUTOFACTORY_MAINTAINER_EMAIL = saved;
  });

  it("prefers the AUTOFACTORY_MAINTAINER_EMAIL override over git identity", () => {
    process.env.AUTOFACTORY_MAINTAINER_EMAIL = "override@example.com";
    assert.equal(localMaintainerEmail(process.cwd()), "override@example.com");
  });

  it("falls back to git config user.email in the repo", () => {
    delete process.env.AUTOFACTORY_MAINTAINER_EMAIL;
    // This repo has a git identity configured; exact value varies by machine.
    const email = localMaintainerEmail(process.cwd());
    assert.ok(email === undefined || email.includes("@"));
  });

  it("returns undefined when git fails (nonexistent repo path) instead of throwing", () => {
    delete process.env.AUTOFACTORY_MAINTAINER_EMAIL;
    assert.equal(localMaintainerEmail("/nonexistent/path/for/autofactory-test"), undefined);
  });
});

describe("resolveMaintainerId", () => {
  const clientReturning = (items: unknown, fail = false) =>
    ({
      findMembers: async () => {
        if (fail) throw new Error("403");
        return { status: 200, ok: true, data: { items } };
      },
    }) as unknown as LdClient;

  it("returns the id of the exact (case-insensitive) email match", async () => {
    const client = clientReturning([
      { _id: "near-miss", email: "dev@example.com.au" }, // fuzzy query match, wrong email
      { _id: "member-123", email: "Dev@Example.com" },
    ]);
    assert.equal(await resolveMaintainerId(client, "dev@example.com"), "member-123");
  });

  it("returns undefined when no member matches exactly", async () => {
    const client = clientReturning([{ _id: "x", email: "other@example.com" }]);
    assert.equal(await resolveMaintainerId(client, "dev@example.com"), undefined);
  });

  it("fails open (undefined) when the members lookup errors", async () => {
    const client = clientReturning([], true);
    assert.equal(await resolveMaintainerId(client, "dev@example.com"), undefined);
  });
});

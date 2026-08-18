import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateProjectKey } from "@auto-factory/shared";

describe("validateProjectKey", () => {
  it("accepts slug-shaped keys", () => {
    for (const key of ["autofactory-demo", "factory-demo-app", "proj_1", "a.b-c", "A1"]) {
      assert.equal(validateProjectKey("LD_APP_PROJECT_KEY", key), key);
    }
  });

  it("rejects a value with a space (the observed .env paste error) and names the var", () => {
    assert.throws(
      () => validateProjectKey("LD_APP_PROJECT_KEY", "factory-demo-appls examples/demo-app"),
      (e: Error) => {
        assert.match(e.message, /LD_APP_PROJECT_KEY/);
        assert.match(e.message, /whitespace/);
        assert.match(e.message, /\.env/);
        return true;
      },
    );
  });

  it("rejects slashes, empty strings, and leading punctuation", () => {
    for (const bad of ["a/b", "", "-starts-with-dash", "key!"]) {
      assert.throws(() => validateProjectKey("LD_PROJECT_KEY", bad), /not a valid LaunchDarkly project key/);
    }
  });
});

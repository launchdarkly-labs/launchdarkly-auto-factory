import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  parseOwnerRepo,
  renderFindCodeRefs,
  renderMcpJson,
  renderWorkflow,
  sdkKeyEnvironment,
  upsertEnv,
} from "@auto-factory/config-bridge";

describe("upsertEnv", () => {
  it("replaces managed keys in place, preserving comments and unknown keys", () => {
    const base = "# comment\nLD_SDK_KEY=\nLD_API_KEY=old\nMY_CUSTOM=keep\n";
    const out = upsertEnv(base, { LD_SDK_KEY: "sdk-new", LD_API_KEY: "api-new" });
    assert.equal(out, "# comment\nLD_SDK_KEY=sdk-new\nLD_API_KEY=api-new\nMY_CUSTOM=keep\n");
  });

  it("appends missing keys under a marker and skips undefined values", () => {
    const out = upsertEnv("A=1\n", { B: "2", C: undefined });
    assert.match(out, /A=1\n\n# --- added by `bridge init` ---\nB=2\n$/);
    assert.ok(!out.includes("C="));
  });

  it("does not touch commented-out keys", () => {
    const out = upsertEnv("# AWS_REGION=us-east-1\n", { AWS_REGION: "eu-west-1" });
    assert.ok(out.includes("# AWS_REGION=us-east-1"));
    assert.ok(out.includes("AWS_REGION=eu-west-1"));
  });

  it("builds a file from empty input", () => {
    assert.equal(upsertEnv("", { A: "1" }), "# --- added by `bridge init` ---\nA=1\n");
  });
});

describe("parseOwnerRepo", () => {
  it("parses SSH and HTTPS remotes, with and without .git", () => {
    assert.deepEqual(parseOwnerRepo("git@github.com:acme/tool.git"), { owner: "acme", repo: "tool" });
    assert.deepEqual(parseOwnerRepo("https://github.com/acme/tool"), { owner: "acme", repo: "tool" });
    assert.deepEqual(parseOwnerRepo("https://github.com/acme/tool.git\n"), { owner: "acme", repo: "tool" });
    assert.equal(parseOwnerRepo("not-a-url"), undefined);
  });
});

describe("renderWorkflow", () => {
  const template = readFileSync("bootstrap/github-action-template/auto-factory.yml", "utf8");

  it("substitutes <owner> for anthropic", () => {
    const out = renderWorkflow(template, { toolOwner: "acme", provider: "anthropic" });
    assert.ok(!out.includes("<owner>"));
    assert.ok(out.includes("uses: acme/launchdarkly-auto-factory/packages/phase1-resource-factory@main"));
    assert.ok(out.includes("anthropic_api_key"));
  });

  it("swaps the Anthropic key for AWS inputs on bedrock", () => {
    const out = renderWorkflow(template, { toolOwner: "acme", provider: "bedrock" });
    assert.ok(!out.match(/^\s*anthropic_api_key:/m));
    assert.ok(out.includes("aws_region:            ${{ vars.AWS_REGION }}"));
    assert.ok(out.includes("aws_access_key_id:     ${{ secrets.AWS_ACCESS_KEY_ID }}"));
    assert.ok(out.includes("aws_secret_access_key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}"));
  });

  it("renders the cursor template without placeholders", () => {
    const cursorTemplate = readFileSync("bootstrap/github-action-template/auto-factory-cursor.yml", "utf8");
    const out = renderWorkflow(cursorTemplate, { toolOwner: "acme", provider: "cursor" });
    assert.ok(!out.includes("<owner>"));
    assert.ok(out.includes("repository: acme/launchdarkly-auto-factory"));
  });
});

describe("renderFindCodeRefs / renderMcpJson", () => {
  it("substitutes the app project key", () => {
    const template = readFileSync("bootstrap/github-action-template/find-code-refs.yml", "utf8");
    const out = renderFindCodeRefs(template, "my-app");
    assert.ok(!out.includes("<your-app-project-key>"));
    assert.ok(out.includes("projKey: my-app"));
  });

  it("substitutes the LD API key into the MCP config", () => {
    const template = readFileSync("bootstrap/cursor-automation/dot-cursor/mcp.json", "utf8");
    const out = renderMcpJson(template, "api-123");
    assert.ok(!out.includes("REPLACE_WITH_LD_API_KEY"));
    assert.equal(JSON.parse(out).mcpServers.LaunchDarkly.args.at(-1), "api-123");
  });
});

describe("sdkKeyEnvironment", () => {
  const envs = [
    { key: "test", apiKey: "sdk-test" },
    { key: "production", apiKey: "sdk-prod" },
  ];

  it("finds the environment a server SDK key belongs to", () => {
    assert.equal(sdkKeyEnvironment("sdk-prod", envs), "production");
    assert.equal(sdkKeyEnvironment("sdk-other-project", envs), undefined);
  });

  it("never matches environments without a visible key", () => {
    assert.equal(sdkKeyEnvironment("", [{ key: "x" }]), undefined);
  });
});

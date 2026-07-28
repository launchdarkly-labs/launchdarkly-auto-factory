import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveGrant } from "@auto-factory/shared";

describe("resolveGrant", () => {
  it("uses edge capabilities when present (source=edge)", () => {
    const r = resolveGrant("anything", ["create_flag", "edit_files"]);
    assert.deepEqual(r.grant, {
      createFlag: true, flagState: false, createMetric: false, editFiles: true, writeManifest: false, stewardManifest: false, queryGraph: false, querySentry: false, readDocs: false, queryRepos: false,
    });
    assert.equal(r.source, "edge");
  });

  it("maps create_metric / write_manifest / steward_manifest from the edge list", () => {
    const r = resolveGrant("anything", ["create_metric", "edit_files", "write_manifest"]);
    assert.deepEqual(r.grant, {
      createFlag: false, flagState: false, createMetric: true, editFiles: true, writeManifest: true, stewardManifest: false, queryGraph: false, querySentry: false, readDocs: false, queryRepos: false,
    });
    const s = resolveGrant("anything", ["steward_manifest"]);
    assert.equal(s.grant.stewardManifest, true);
    assert.equal(s.grant.writeManifest, false);
    assert.equal(s.grant.editFiles, false);
  });

  it("maps query_sentry from the edge list", () => {
    const r = resolveGrant("anything", ["query_sentry", "create_metric"]);
    assert.equal(r.grant.querySentry, true);
    assert.equal(r.grant.createMetric, true);
  });

  it("maps flag_state from the edge list", () => {
    const r = resolveGrant("anything", ["flag_state"]);
    assert.equal(r.grant.flagState, true);
    assert.equal(r.grant.createFlag, false);
    assert.equal(r.source, "edge");
  });

  it("an empty edge list grants nothing (still source=edge, overrides fallback)", () => {
    const r = resolveGrant("autofactory-flag-implementer", []);
    assert.deepEqual(r.grant, {
      createFlag: false, flagState: false, createMetric: false, editFiles: false, writeManifest: false, stewardManifest: false, queryGraph: false, querySentry: false, readDocs: false, queryRepos: false,
    });
    assert.equal(r.source, "edge");
  });

  it("falls back to NODE_CAPABILITIES by config key when no edge list (source=fallback)", () => {
    const impl = resolveGrant("autofactory-flag-implementer", undefined);
    assert.equal(impl.source, "fallback");
    assert.equal(impl.grant.createFlag, true);
    assert.equal(impl.grant.flagState, true);
    assert.equal(impl.grant.editFiles, true);
    assert.equal(impl.grant.writeManifest, true);

    const testing = resolveGrant("autofactory-flag-testing", undefined);
    assert.equal(testing.grant.editFiles, true);
    assert.equal(testing.grant.createFlag, false);

    const metrics = resolveGrant("autofactory-metrics-author", undefined);
    assert.equal(metrics.grant.createMetric, true);
    assert.equal(metrics.grant.writeManifest, true);
    assert.equal(metrics.grant.querySentry, true);
  });

  it("research (ROOT — no inbound edge) gets narrow write_manifest via fallback", () => {
    const r = resolveGrant("autofactory-research-planner", undefined);
    assert.equal(r.source, "fallback");
    assert.equal(r.grant.writeManifest, true);
    assert.equal(r.grant.editFiles, false);
    assert.equal(r.grant.createFlag, false);
    // queryGraph rides the fallback too (ROOT can't receive edge grants); the
    // tool still only appears when a graph was composed for the run (KG flag).
    assert.equal(r.grant.queryGraph, true);
    // Same for queryRepos: granted here, offered only when relatedRepos are
    // registered and a GitHub token is present.
    assert.equal(r.grant.queryRepos, true);
    // flagState: the planner's targeting evidence for the flag_action decision.
    assert.equal(r.grant.flagState, true);
  });

  it("the steward gets steward_manifest via fallback", () => {
    const r = resolveGrant("autofactory-manifest-steward", undefined);
    assert.equal(r.source, "fallback");
    assert.equal(r.grant.stewardManifest, true);
    assert.equal(r.grant.editFiles, false);
  });

  it("read-only (source=none) for an unknown key with no edge list", () => {
    const r = resolveGrant("some-unknown-agent", undefined);
    assert.deepEqual(r.grant, { createFlag: false, createMetric: false, editFiles: false });
    assert.equal(r.source, "none");
  });
});

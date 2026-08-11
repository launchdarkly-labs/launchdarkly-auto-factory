import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { CONTENT_REJECTION_STATUSES, PATCH_FAILURE_TAXONOMY, PATCH_SITES } from "@auto-factory/beacon";

// ---------------------------------------------------------------------------------------------
// THE PROCESS FINDING, MADE MECHANICAL — and this file is deliberately the only one exempt from
// the lint it contains.
//
// The status→outcome taxonomy was restated in FOUR places: the classifier in `trigger.ts`, the
// catch in `server.ts`, `packages/beacon/README.md` and `docs/loop-seam.md`. Eleven prose
// corrections on this branch each fixed THREE of the four, and the missed copy was reliably the one
// an auditor reads first — the last instance missed a wrong claim seven lines above the test being
// edited, in the same file, in the same diff. A FIFTH copy was then found in `tests/`, drifted:
// comments there still called a status per-manifest after its row had been corrected to `unknown`.
//
// So there is one home, `PATCH_FAILURE_TAXONOMY`, the behaviour is DERIVED from it, and the tests
// below check both that derivation and that no other file restates the argument. They live in their
// own file because the checks cannot be subject to themselves: naming the banned vocabulary is how
// a vocabulary lint is written. That is a real hole — a sixth copy could be pasted HERE and nothing
// would object — accepted because it is the one file whose whole purpose is the check, so a copy
// added here sits directly above the assertion contradicting it.
// ---------------------------------------------------------------------------------------------
describe("the taxonomy has exactly one home", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const HOME = "packages/beacon/src/trigger.ts";

  it("the held allowlist is DERIVED from the taxonomy, not written a second time", () => {
    // PREVENTS the classic drift: an argument corrected in prose while the set it justifies is not,
    // or vice versa. `CONTENT_REJECTION_STATUSES` is built from the rows whose outcome is `held`, so
    // there is no second list to forget. Membership is pinned as well, because a row silently
    // flipped to `throws` stops being `held` and starts starving siblings (that regression really
    // happened, to 422).
    const held = [...PATCH_FAILURE_TAXONOMY].filter(([, c]) => c.outcome === "held").map(([s]) => s);
    assert.deepEqual([...CONTENT_REJECTION_STATUSES].sort(), held.sort());
    assert.deepEqual([...CONTENT_REJECTION_STATUSES].sort(), [400, 422]);
    for (const status of CONTENT_REJECTION_STATUSES) {
      const row = PATCH_FAILURE_TAXONOMY.get(status);
      assert.equal(row?.wrote, "no", `a held status must PROVE nothing was written (${status})`);
    }
  });

  it("every throwing row is transient or wider than one manifest — except the recorded 403 gap", () => {
    // THE INVARIANT THE WHOLE SLOT DESIGN RESTS ON. A throw claims the flag's action slot; that costs
    // a sibling a DELAY unless the throw recurs identically for one manifest, in which case the claim
    // is permanent and the sibling's release is lost. So every throwing row must be transient, or
    // wider than one manifest.
    //
    // ASSERTED POSITIVELY, and the first version was not. It excluded rows whose blast radius was
    // literally `"per-manifest"`, which is not the same rule: `blastRadius: "unknown"` is neither
    // transient nor wider than one manifest, and a type-valid row set that way passed a test whose
    // own comment (two lines up) said it should not. A row nobody has managed to scope is exactly
    // the row this invariant exists to notice.
    //
    // `recurs: "either"` counts as NOT transient here, deliberately: a status that MIGHT recur for one
    // manifest has to be shown wider than one manifest before a throw is safe.
    for (const [status, c] of PATCH_FAILURE_TAXONOMY) {
      if (c.outcome !== "throws" || status === 403) continue;
      assert.ok(
        c.recurs === "transient" || c.blastRadius === "per-flag-or-environment",
        `${status} throws, so it must be transient or wider than one manifest — got ` +
          `recurs=${c.recurs}, blastRadius=${c.blastRadius}. An unscoped deterministic throw claims ` +
          `the flag's slot on every deploy and starves the sibling that could release.`,
      );
    }

    // 403 is the ONE exception, and it is a GAP HONESTLY RECORDED rather than a solved case. This
    // test exists because the previous revision carried a PROOF that no per-manifest 403 was
    // possible, resting on guarded-vs-progressive — the wrong split. If someone re-asserts that
    // proof by widening this row, the deepEqual below fails.
    const starving = [...PATCH_FAILURE_TAXONOMY]
      .filter(([, c]) => c.outcome === "throws" && c.recurs === "deterministic" && c.blastRadius === "per-manifest")
      .map(([status]) => status);
    assert.deepEqual(starving, [403], "THE DISCRIMINATOR: exactly one known starving shape, and it is written down");
    const row = PATCH_FAILURE_TAXONOMY.get(403);
    assert.match(String(row?.why), /GAP/, "and the row says it is a gap");
    assert.match(String(row?.why), /updatePrerequisites/, "naming the role action that makes it reachable");
    assert.match(String(row?.why), /starve/i, "and what it costs");

    // WHY THE 400 ROW IS NOT IN THE LOOP ABOVE, stated rather than left to be inferred: it is skipped
    // because its outcome is `held`, so it never reaches the catch that claims the slot — NOT because
    // its shape would pass. Its shape would not: it is `recurs: "either"` with an `unknown` blast
    // radius, which is precisely the combination the loop rejects. Pinning that here means a future
    // change of its outcome to `throws` cannot quietly inherit the exemption.
    const four00 = PATCH_FAILURE_TAXONOMY.get(400);
    assert.equal(four00?.outcome, "held", "the 400 row's exemption above is its OUTCOME, not its shape");
    assert.equal(four00?.recurs, "either", "and its shape would not have passed: not transient…");
    assert.equal(four00?.blastRadius, "unknown", "…and not wider than one manifest either");
  });

  it("the slot claim on a non-writing outcome is DERIVED from the patch, at exactly one site", () => {
    // THE NARROWED §6 INVARIANT, pinned at the mechanism. §6 says a manifest that writes nothing must
    // not take the flag's action slot; the owner narrowed it to "…except where the refusal cannot be
    // specific to one manifest, in which case no sibling may act either". A narrowing that lives in
    // prose is one nobody can audit, so `heldOnContentRefusal` derives the claim from
    // `PatchSite.carriesManifestContent` — and this test is what stops the exception spreading.
    //
    // The behavioural arms are in `ledgerLineage.test.ts`: the divergent-target `immediate` test for
    // the exception, and the refused release-start and prerequisites tests for the rule. This one pins
    // the SHAPE — that exactly one patch is in each state, so a second exception cannot be added
    // without a test failing and a reviewer asking whose decision it was.
    const sites = Object.values(PATCH_SITES);
    assert.equal(sites.length, 3, "three patches, which was itself a drifting count once");
    assert.deepEqual(
      sites.filter((s) => !s.carriesManifestContent).map((s) => s.id),
      ["immediate"],
      "THE DISCRIMINATOR: exactly one patch carries no manifest content, and it is the immediate one",
    );
    assert.deepEqual(
      sites.filter((s) => s.carriesManifestContent).map((s) => s.id).sort(),
      ["prerequisites", "release-start"],
      "and the other two do, so a refusal of either can be about one manifest — slot stays free",
    );
  });

  // -------------------------------------------------------------------------------------------
  // WHAT THE TWO LINTS BELOW ACTUALLY GUARANTEE, stated honestly because the previous version of
  // this comment claimed they make a second copy "UNREPRESENTABLE". THEY DO NOT, and cannot: they
  // are text filters, so they catch a copy that reuses the argument's WORDS. A reviewer wrote this
  // past them, with every falsehood intact and none of the vocabulary —
  //
  //   "When LaunchDarkly turns us away because it is too busy, or because somebody else is editing
  //    the same flag at that exact moment, Beacon answers exactly as it does for a body LaunchDarkly
  //    cannot accept … A permissions denial can never single out one file among several for the same
  //    flag, because LaunchDarkly's permission model draws no distinction between a metric-monitored
  //    ramp and a plain percentage ramp."
  //
  // No regex reaches that. So what these guard is the realistic failure mode rather than the
  // adversarial one: a copy made by PASTING or by editing an existing paraphrase keeps the
  // vocabulary, and that is precisely how all eleven prior corrections went wrong — the prose was
  // inherited, not reinvented. Deliberate paraphrase by someone who knows the lint exists is caught
  // by review, and there is no mechanism here that replaces it.
  //
  // Two tiers, because two different mistakes are being prevented:
  //
  //  TIER A — the argument's own vocabulary, banned in every doc and every source but the home. The
  //    first version banned nine NUMERALS in three hardcoded files, and a numeral-free paraphrase
  //    went straight through. Scope is broad because a copy in a NEW file is what a hardcoded list
  //    cannot see, and it now includes `tests/`, where the fifth copy was found.
  //  TIER B — statuses and LaunchDarkly's status NAMES, for the three files that sit next to the
  //    argument and keep re-growing it. Limited to statuses Beacon never answers with: 400/401/422
  //    come out of this repo's own express handlers, so a numeral there cannot tell a claim about
  //    LaunchDarkly from a note about Beacon's HTTP contract, and accusing the latter is how a lint
  //    earns its own deletion.
  // -------------------------------------------------------------------------------------------

  /**
   * Prose UNITS: a paragraph in markdown; a CONTIGUOUS COMMENT BLOCK, a block comment or a string
   * literal in TypeScript.
   *
   * BLOCKS, NOT LINES, and that was a real hole in both tiers. Line-filtering let
   * `foo(); // a status is transient` escape entirely, and Tier B's sentence split (on `[.!?\n]`)
   * treated every wrapped comment as separate sentences — so a name on one line and its verdict on
   * the next never met, which at this file's ~110-column wrapping is the normal case rather than the
   * exception.
   *
   * STRING LITERALS ARE TAKEN FROM COMMENT-STRIPPED SOURCE, which matters more than it sounds: prose
   * is full of apostrophes, so matching `'…'` across a raw file makes every "pr-41's … don't" pair a
   * fake literal spanning arbitrary text. That produced a dozen phantom findings whose quoted context
   * was gibberish — and a lint whose evidence is gibberish is one nobody believes.
   */
  const proseUnits = (rel: string, raw: string): string[] => {
    // Fenced code in markdown is a transcript, not a claim.
    if (rel.endsWith(".md")) return raw.replace(/```[\s\S]*?```/g, "").split(/\n\s*\n/);
    const units: string[] = [];
    let block: string[] = [];
    for (const line of raw.split("\n")) {
      const m = /\/\/(.*)$/.exec(line);
      if (m) {
        block.push(m[1] ?? "");
        continue;
      }
      if (block.length) units.push(block.join(" "));
      block = [];
    }
    if (block.length) units.push(block.join(" "));
    units.push(...(raw.match(/\/\*[\s\S]*?\*\//g) ?? []));
    // `[^:]` before `//` so a URL inside a string is not mistaken for a comment.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    units.push(...(code.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g) ?? []));
    return units;
  };

  /**
   * Is this paragraph talking about LaunchDarkly's refusals at all?
   *
   * REQUIRED BEFORE TIER A FIRES, because `per-manifest` and `starves` are NOT the taxonomy's
   * private vocabulary — they are the vocabulary of §6's first invariant, the one that says the
   * ledger's unit of work is a manifest's address while the unit of action is a flag. A commit on
   * this branch is literally titled "the ledger's questions are per-manifest, the slot is not". So
   * `// the ledger key is per-manifest by design; a per-flag key starves nothing` is accurate,
   * innocent prose that the first version of Tier A failed — telling the maintainer to move a
   * comment about ledger keys into a table about HTTP statuses. That is how a lint gets deleted.
   */
  const TAXONOMY_SIGNAL = /\b(400|401|403|404|405|408|409|422|429)\b|launchdarkly|\bLD\b|refus/i;

  it("TIER A: no file but the home states any part of the argument", () => {
    // THE EXEMPTIONS, both deliberate:
    //  - `docs/loopback-handoff.md` is this branch's working notes and the document that RAISED the
    //    four-copy finding; §7 of it says to delete the file when the branch merges, at which point
    //    this entry silently stops mattering. Harmless direction, but it is a no-op waiting to
    //    happen rather than a rule.
    //  - this file, for the reason at the top.
    const EXEMPT = new Set([HOME, "docs/loopback-handoff.md", "tests/taxonomyHome.test.ts"]);
    const terms: Array<[RegExp, string]> = [
      [/per-manifest/i, "how wide a refusal is — a `blastRadius` value"],
      [/starv/i, "what a permanent slot claim costs — the `blastRadius` consequence"],
      [/applied partially/i, "LaunchDarkly's semantic-patch atomicity guarantee"],
      [/patch[- ]sites?\b/i, "the inventory of the patches `triggerRelease` sends"],
      [/role action/i, "which LaunchDarkly role action governs which instruction"],
      [/pending scheduled change/i, "what an allowlisted refusal does not prove"],
      [/guarded vers(us|.) progressive|guarded vs\.? progressive/i, "the retired 403 proof"],
    ];
    assert.ok(existsSync(resolve(repoRoot, HOME)), `the home itself (${HOME}) is missing — nothing below means anything`);
    const dir = (d: string, ext: string): string[] =>
      readdirSync(resolve(repoRoot, d)).filter((f) => f.endsWith(ext)).map((f) => `${d}/${f}`);
    const files = [
      "packages/beacon/README.md",
      ...dir("docs", ".md"),
      ...dir("packages/beacon/src", ".ts"),
      ...dir("tests", ".test.ts"),
    ].filter((f) => !EXEMPT.has(f));
    // 72 at the time of writing, across four directories. The floor only catches a moved or renamed
    // directory — an ordinary new source or test file grows the list, which is the safe direction.
    assert.ok(files.length >= 60, `scope collapsed to ${files.length} files — a rename or a moved dir`);

    for (const rel of files) {
      for (const unit of proseUnits(rel, readFileSync(resolve(repoRoot, rel), "utf8"))) {
        if (!TAXONOMY_SIGNAL.test(unit)) continue;
        for (const [term, what] of terms) {
          const found = term.exec(unit);
          assert.equal(
            found,
            null,
            `${rel} states part of the taxonomy's argument ('${found?.[0]}' — ${what}) in a paragraph ` +
              `that is about LaunchDarkly's refusals: "${unit.trim().replace(/\s+/g, " ").slice(0, 140)}". ` +
              `It belongs in PATCH_FAILURE_TAXONOMY (${HOME}) and nowhere else; point at it instead.`,
          );
        }
      }
    }
  });

  it("TIER B: the three taxonomy-adjacent sites point at the home and name no status", () => {
    const NUMERALS = /\b(403|404|405|408|409|429)\b/;
    // Every name LaunchDarkly's error table gives these statuses, because a name is a restatement as
    // much as a numeral is. The first version listed only the descriptive phrases and omitted the
    // canonical HTTP reason phrases entirely.
    const NAMES =
      /rate[- ]limit|too many requests|status conflict|concurrent[- ](api )?request|approval is required|approvals?[- ]required|required approvals|method not allowed|invalid resource identifier|not found|forbidden|invalid access token|unauthori[sz]ed|unprocessable|request timeout|invalid request body|bad request/i;
    // A status NAME is only a taxonomy claim when it is being CLASSIFIED. "GitHub rate limit" in the
    // readiness check and "rate limiting and outages" in the idempotency guard are neither, so this
    // asks whether a name and a verdict about it are NEAR EACH OTHER.
    //
    // PROXIMITY, NOT SENTENCES, and the two obvious alternatives both fail. Splitting on `[.!?\n]`
    // let wrapping defeat the check — at this repo's ~110-column comments a name and its verdict
    // almost always land on different lines. Splitting on `[.!?]` after joining the block goes wrong
    // the other way: these comments run long and contain few full stops, so one "sentence" can be a
    // whole paragraph, and an innocent "GitHub rate limit" 170 characters away from the word
    // "classifier" was reported as a taxonomy claim. A window is what "being classified" actually
    // means.
    const WINDOW = 120;
    const VERDICT = /\b(held|content|transient|deterministic|per-flag|slot|reject\w*|classif\w*|throw\w*|refusals?)\b/i;
    // `non-404` is the fullstack readiness check's own vocabulary (a GitHub error that is not a 404),
    // unrelated to the patch taxonomy.
    const strip = (s: string): string => s.replace(/non-404/g, "");
    for (const rel of ["packages/beacon/README.md", "docs/loop-seam.md", "packages/beacon/src/server.ts"]) {
      const abs = resolve(repoRoot, rel);
      assert.ok(existsSync(abs), `${rel} is missing — if it moved, update this list rather than deleting the check`);
      const raw = readFileSync(abs, "utf8");
      assert.match(raw, /PATCH_FAILURE_TAXONOMY/, `${rel} must POINT at the one home`);

      for (const unit of proseUnits(rel, strip(raw))) {
        const numeral = NUMERALS.exec(unit);
        assert.equal(
          numeral,
          null,
          `${rel} names a status ('${numeral?.[0]}'). Statuses are classified in one place only: ` +
            `PATCH_FAILURE_TAXONOMY (${HOME}).`,
        );
        const flat = unit.replace(/\s+/g, " ");
        for (const name of flat.matchAll(new RegExp(NAMES, "gi"))) {
          const at = name.index ?? 0;
          const near = flat.slice(Math.max(0, at - WINDOW), at + name[0].length + WINDOW);
          if (!VERDICT.test(near)) continue;
          assert.fail(
            `${rel} classifies a status by NAME ('${name[0]}'): "…${near.trim()}…". That verdict ` +
              `belongs in PATCH_FAILURE_TAXONOMY (${HOME}) — a numeral-free paraphrase is still a ` +
              `second copy.`,
          );
        }
      }
    }
  });
});

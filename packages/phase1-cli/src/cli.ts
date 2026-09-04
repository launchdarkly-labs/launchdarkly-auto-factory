#!/usr/bin/env node
/**
 * `autofactory` — Phase 1 front end #4 (headless CLI). Runs the full
 * LaunchDarkly-defined agent chain against the current working tree via the
 * shared core. Designed to be driven by a human or by Claude Code (see
 * bootstrap/claude-code/): progress streams to stdout, approval gates surface
 * as exit code 3 + a re-run command, edits land uncommitted in the tree.
 */

import { EXIT, parseArgs, usage } from "./args.js";
import { runIntake } from "./intake.js";
import { runCli } from "./run.js";

const parsed = parseArgs(process.argv.slice(2));
if ("help" in parsed) {
  console.log(usage());
  process.exitCode = EXIT.OK;
} else if ("error" in parsed) {
  console.error(`autofactory: ${parsed.error}\n`);
  console.error(usage());
  process.exitCode = EXIT.USAGE;
} else if ("intake" in parsed) {
  runIntake(parsed.intake).then((code) => {
    process.exitCode = code;
  });
} else {
  runCli(parsed.options).then((code) => {
    process.exitCode = code;
  });
}

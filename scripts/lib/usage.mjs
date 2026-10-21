import { writeSync } from "node:fs";

/**
 * Shared --help/-h handling for check/verify wrappers.
 *
 * One source of truth for help-flag detection so the 17 migrated wrappers
 * never drift: each wrapper calls `handleHelpFlag(argv.slice(2), usage())`
 * before any I/O, env checks, or subprocess work. Prints usage to stdout
 * and exits 0 with zero side effects (no checks run, nothing written, no
 * fetch). The write is synchronous so piped output is never truncated by
 * the exit.
 *
 * Usage text itself stays per-wrapper (purpose differs). The pair suite
 * pins the transport contract only: exit 0, `Usage:` on stdout, the
 * script basename, a `--flag` token, and no side effects. Each of the 17
 * migrated usages additionally states purpose, supported flags, exit
 * codes, and one example; the 5 pre-existing `--help` texts keep their
 * own shorter format.
 *
 * @param {string[]} args CLI args (typically argv.slice(2))
 * @param {string} usageText preformatted usage to print to stdout
 */
export function handleHelpFlag(args, usageText) {
  if (args.includes("--help") || args.includes("-h")) {
    try {
      writeSync(1, usageText.endsWith("\n") ? usageText : `${usageText}\n`);
    } catch {
      // Broken pipe (e.g. `| head`): usage is best-effort, exit stays 0.
    }
    process.exit(0);
  }
}

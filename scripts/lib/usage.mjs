/**
 * Shared --help/-h handling for check/verify wrappers.
 *
 * One source of truth for help-flag detection so 22 wrappers never drift:
 * each wrapper calls `handleHelpFlag(argv.slice(2), usage())` before any
 * I/O, env checks, or subprocess work. Prints usage to stdout and exits 0
 * with zero side effects (no checks run, nothing written, no fetch).
 *
 * Usage text itself stays per-wrapper (purpose differs), but every usage
 * must name its script basename, list a --flag, and carry purpose, flags,
 * exit codes, and one example (see TOG-35178).
 *
 * @param {string[]} args CLI args (typically argv.slice(2))
 * @param {string} usageText preformatted usage to print to stdout
 */
export function handleHelpFlag(args, usageText) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usageText);
    process.exit(0);
  }
}

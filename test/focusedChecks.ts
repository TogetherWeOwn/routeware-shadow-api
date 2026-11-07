/// <reference types="vite/client" />

/**
 * Focused per-feature checks live one file each in `checks/<name>.cmd` (run
 * with `npm run check:focused -- <name>`), not in `package.json#scripts`.
 * Oracles that pin their own check read them here.
 */
const files = import.meta.glob("../checks/*.cmd", {
  query: "?raw",
  import: "default",
  eager: true
}) as Record<string, string>;

/** Bare check name (`address-zip`) -> its shell command. */
export const focusedChecks: Record<string, string> = Object.fromEntries(
  Object.entries(files).map(([file, command]) => [file.replace(/^.*\/(.*)\.cmd$/, "$1"), command.trim()])
);

/** `[npm invocation, command]` pairs, the invocation being what docs must show after `npm run `. */
export const focusedCheckEntries: [string, string][] = Object.entries(focusedChecks).map(
  ([name, command]) => [`check:focused -- ${name}`, command]
);

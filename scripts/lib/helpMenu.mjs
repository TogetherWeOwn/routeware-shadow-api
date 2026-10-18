/**
 * Pure helpers for `npm run help`.
 *
 * Groups package.json scripts by namespace (the text before the first colon)
 * so a new clone can find its entry point without reading every script line.
 * Lifecycle hooks such as `predev` stay hidden because npm runs them itself.
 */

export const GENERAL_GROUP = "general";
const MAX_COMMAND_WIDTH = 72;

/**
 * @param {string} name
 * @param {Record<string, string>} scripts
 * @returns {boolean} true for `pre<x>`/`post<x>` when script `<x>` exists
 */
export function isLifecycleHook(name, scripts) {
  const base = name.replace(/^(pre|post)/, "");
  return base !== name && Object.hasOwn(scripts, base);
}

/**
 * @param {Record<string, string>} scripts
 * @returns {{ group: string, entries: { name: string, command: string }[] }[]}
 */
export function groupScripts(scripts) {
  const namespaces = new Set(
    Object.keys(scripts)
      .filter((name) => name.includes(":"))
      .map((name) => name.slice(0, name.indexOf(":"))),
  );
  const groups = new Map();
  for (const [name, command] of Object.entries(scripts)) {
    if (isLifecycleHook(name, scripts)) continue;
    const colon = name.indexOf(":");
    let group;
    if (colon !== -1) group = name.slice(0, colon);
    else group = namespaces.has(name) ? name : GENERAL_GROUP;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ name, command: String(command) });
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => {
    if (a === GENERAL_GROUP) return -1;
    if (b === GENERAL_GROUP) return 1;
    return 0;
  });
  return ordered.map(([group, entries]) => ({ group, entries }));
}

function truncate(text) {
  return text.length > MAX_COMMAND_WIDTH ? `${text.slice(0, MAX_COMMAND_WIDTH - 3)}...` : text;
}

/**
 * @param {ReturnType<typeof groupScripts>} groups
 * @returns {string}
 */
export function formatHelpMenu(groups) {
  const width = Math.max(0, ...groups.flatMap(({ entries }) => entries.map(({ name }) => name.length)));
  const lines = [];
  for (const { group, entries } of groups) {
    lines.push("", group);
    for (const { name, command } of entries) {
      lines.push(`  ${name.padEnd(width)}  ${truncate(command)}`);
    }
  }
  return lines.join("\n");
}

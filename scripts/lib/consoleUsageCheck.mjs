/**
 * Pure helpers for the console-usage lint (TOG-8898, unit-tested TOG-19019).
 *
 * Rule: no direct console access in `src/` — logging must go through the
 * structured helper in `src/lib/logger.ts`. Its one computed-severity
 * dispatch (`console[level](...)`) is the sole exception, and only in that
 * file. Bare `console.*`, `globalThis.console.*`, and
 * `globalThis["console"].*` are violations everywhere else.
 *
 * Everything here is pure (paths and text in, verdicts out) so it is
 * unit-testable with no `node:fs`. The suite runs under `node --test`
 * (see `scripts/check-console-usage.test.mjs`, imported by
 * `scripts/post-deploy-probe.test.mjs` so CI's always-run hygiene job
 * executes it): the `typescript` compiler
 * bundle is far too large to load inside the workers-pool vitest project,
 * so a `test/*.test.ts` suite cannot import this module. The impure
 * wrapper lives in `scripts/check-console-usage.mjs`, which walks `src/`
 * and feeds `{ path, text }` entries in (paths repo-relative, e.g.
 * `src/routes/orders.ts`).
 */
import ts from "typescript";

/** Repo-relative path of the structured logger holding the sole exception. */
export const LOGGER_PATH = "src/lib/logger.ts";

/** Message suffix shared by every violation line. */
export const VIOLATION_HINT = "direct console access is forbidden; use src/lib/logger.ts";

export function isConsoleObject(node) {
  if (ts.isIdentifier(node) && node.text === "console") return true;
  if (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "console" &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "globalThis"
  ) {
    return true;
  }
  return (
    ts.isElementAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "globalThis" &&
    ts.isStringLiteralLike(node.argumentExpression) &&
    node.argumentExpression.text === "console"
  );
}

export function isLoggerDispatch(node, filePath, loggerPath = LOGGER_PATH) {
  return (
    filePath === loggerPath &&
    ts.isElementAccessExpression(node) &&
    isConsoleObject(node.expression) &&
    ts.isIdentifier(node.argumentExpression) &&
    node.argumentExpression.text === "level" &&
    ts.isCallExpression(node.parent) &&
    node.parent.expression === node
  );
}

export function isConsoleReference(node, filePath, loggerPath = LOGGER_PATH) {
  if (ts.isIdentifier(node) && node.text === "console") {
    if (ts.isPropertyAssignment(node.parent) && node.parent.name === node) return false;
    return !(
      ts.isElementAccessExpression(node.parent) &&
      node.parent.expression === node &&
      isLoggerDispatch(node.parent, filePath, loggerPath)
    );
  }
  return isConsoleObject(node) && !isLoggerDispatch(node, filePath, loggerPath);
}

/**
 * Find direct-console violations in `{ path, text }` entries, where `path`
 * is repo-relative (e.g. `src/routes/orders.ts`). Returns
 * `{ file, line, column }` rows (1-based) sorted by file, line, column.
 */
export function findConsoleViolations(entries, { loggerPath = LOGGER_PATH } = {}) {
  const violations = [];
  for (const { path: file, text } of entries) {
    const source = ts.createSourceFile(
      file,
      String(text),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    function visit(node) {
      if (isConsoleReference(node, file, loggerPath)) {
        const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push({ file, line: line + 1, column: character + 1 });
      }
      ts.forEachChild(node, visit);
    }

    visit(source);
  }
  return violations.sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || a.column - b.column,
  );
}

export function formatPassLog(fileCount) {
  return `console lint passed (${fileCount} TypeScript files)`;
}

export function formatViolationLine(violation) {
  return `${violation.file}:${violation.line}:${violation.column}: ${VIOLATION_HINT}`;
}

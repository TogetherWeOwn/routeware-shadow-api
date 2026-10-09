#!/usr/bin/env node
/**
 * Reject direct console method access in src/. Logging must go through the
 * structured helper; its one computed severity dispatch is the sole exception.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(root, "src");
const loggerPath = path.join(srcRoot, "lib", "logger.ts");

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(fullPath));
    } else if (entry.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

function isConsoleObject(node) {
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

function isLoggerDispatch(node, filePath) {
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

function isConsoleReference(node, filePath) {
  if (ts.isIdentifier(node) && node.text === "console") {
    if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) return false;
    if (ts.isPropertyAssignment(node.parent) && node.parent.name === node) return false;
    return !(
      ts.isElementAccessExpression(node.parent) &&
      node.parent.expression === node &&
      isLoggerDispatch(node.parent, filePath)
    );
  }
  return isConsoleObject(node) && !isLoggerDispatch(node, filePath);
}

const violations = [];
let files;
try {
  files = sourceFiles(srcRoot);
} catch (error) {
  console.error(`console lint: cannot read src/: ${error.message}`);
  process.exitCode = 1;
}

for (const filePath of files ?? []) {
  const source = ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  function visit(node) {
    if (isConsoleReference(node, filePath)) {
      const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
      violations.push({
        file: path.relative(root, filePath).replaceAll("\\", "/"),
        line: line + 1,
        column: character + 1,
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
}

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(
      `${violation.file}:${violation.line}:${violation.column}: direct console access is forbidden; use src/lib/logger.ts`,
    );
  }
  process.exitCode = 1;
} else if (files) {
  console.log(`console lint passed (${files.length} TypeScript files)`);
}

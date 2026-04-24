#!/usr/bin/env node
/**
 * Validates out/harvest.ndjson lines (JSON + required fields).
 * Exits 0 if file missing (nothing to validate yet).
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const inFile = join(__dirname, "out", "harvest.ndjson");

let st;
try {
  st = await stat(inFile);
} catch {
  console.warn("validate-harvest: no", inFile, "— skip.");
  process.exit(0);
}

if (!st.size) {
  console.warn("validate-harvest: empty file — skip.");
  process.exit(0);
}

const rl = createInterface({ input: createReadStream(inFile) });
let lineNo = 0;
let errors = 0;
for await (const line of rl) {
  lineNo += 1;
  if (!line.trim()) {
    continue;
  }
  let row;
  try {
    row = JSON.parse(line);
  } catch (e) {
    console.error(`Line ${lineNo}: invalid JSON`, e.message);
    errors += 1;
    continue;
  }
  for (const k of ["ts", "method", "pathname"]) {
    if (row[k] == null || row[k] === "") {
      console.error(`Line ${lineNo}: missing "${k}"`);
      errors += 1;
    }
  }
}

if (errors) {
  console.error("validate-harvest:", errors, "issue(s).");
  process.exit(1);
}

console.log("validate-harvest: OK,", lineNo, "lines checked.");
process.exit(0);

/** Local-only CLI plumbing; record validation stays in the pure contract module. */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { HarvestValidationError } from "./harvestContract.mjs";

const NEXT_ACTIONS = {
  HARVEST_OK: "Continue with the next local discovery step.",
  HARVEST_MISSING: "Provide a harvest file before processing captured operations.",
  HARVEST_EMPTY: "Provide nonblank harvest records to discover operations.",
  HARVEST_INVALID_RECORDS: "Correct the reported harvest records, then validate again.",
  HARVEST_UNKNOWN_FLAG: "Use --help to see supported options.",
  HARVEST_READ_FAILED: "Check local harvest file access and readability, then retry.",
  HARVEST_WRITE_FAILED: "Check local aggregate output access and available space, then retry."
};

export function harvestResult(code, extra = {}) {
  return {
    schemaVersion: 1,
    ok: ["HARVEST_OK", "HARVEST_MISSING", "HARVEST_EMPTY"].includes(code),
    code,
    next_action: NEXT_ACTIONS[code],
    findings: [],
    ...extra
  };
}

export function harvestFailure(error, fallback = "HARVEST_READ_FAILED") {
  if (error instanceof HarvestValidationError) {
    return harvestResult(error.code, {
      findings: error.findings,
      findingCount: error.findingCount,
      findingsTruncated: error.findingCount > error.findings.length
    });
  }
  // Never serialize raw filesystem/parser messages (they can contain captured values).
  return harvestResult(fallback);
}

export function harvestOptions(args, aggregate = false) {
  const supported = new Set(["--help", "--json", ...(aggregate ? ["--dry-run"] : [])]);
  return {
    json: args.includes("--json"),
    help: args.includes("--help"),
    dryRun: aggregate && args.includes("--dry-run"),
    invalid: args.some(arg => !supported.has(arg))
  };
}

export function printHarvestResult(result, json, message) {
  if (json) {
    console.log(JSON.stringify(result));
  } else if (result.ok) {
    console.log(message);
  } else {
    console.error(`${result.code}: ${result.next_action}`);
    for (const item of result.findings) {
      console.error(`Line ${item.line}, field ${item.field}: ${item.code}. ${item.next_action}`);
    }
  }
  process.exitCode = result.ok ? 0 : 1;
}

/** Only stat ENOENT means fresh checkout; stream errors (including later ENOENT) fail. */
export async function readHarvestFile(file, consume) {
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    if (error.code === "ENOENT") return "HARVEST_MISSING";
    throw error;
  }
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) consume(line);
  } finally {
    lines.close();
    input.destroy();
  }
  return info.size === 0 ? "HARVEST_EMPTY" : "HARVEST_OK";
}

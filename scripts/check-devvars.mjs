#!/usr/bin/env node
/**
 * Verifies `.dev.vars` exists beside wrangler.toml and defines LOGIN_* keys
 * (does not print values).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const devVarsPath = path.join(root, ".dev.vars");
const wranglerPath = path.join(root, "wrangler.toml");

if (!fs.existsSync(wranglerPath)) {
  console.error("Expected wrangler.toml at", wranglerPath);
  process.exit(1);
}

if (!fs.existsSync(devVarsPath)) {
  console.error(
    "Missing .dev.vars at:\n  " +
      devVarsPath +
      "\n\nCreate it (see .dev.vars.example). `wrangler secret put` does not apply to `wrangler dev`."
  );
  process.exit(1);
}

const raw = fs.readFileSync(devVarsPath, "utf8").replace(/^\uFEFF/, "");
const keys = new Set();
const nonEmpty = new Set();
for (const line of raw.split(/\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    continue;
  }
  const eq = trimmed.indexOf("=");
  if (eq === -1) {
    continue;
  }
  const key = trimmed.slice(0, eq).replace(/\r$/, "").trim();
  const value = trimmed.slice(eq + 1).replace(/\r$/, "").trim();
  keys.add(key);
  if (value) {
    nonEmpty.add(key);
  }
}

let ok = true;
for (const k of ["LOGIN_USERNAME", "LOGIN_PASSWORD"]) {
  if (!keys.has(k)) {
    console.error("Missing key in .dev.vars:", k);
    ok = false;
  }
}

// The client-auth gate rejects every /api/v1/* call (except health) unless a token
// is configured, so local dev needs one. SHADOW_API_TOKEN is preferred; it falls back
// to CUSTOMER_SNAPSHOT_SYNC_SECRET when unset.
const clientTokens = ["SHADOW_API_TOKEN", "CUSTOMER_SNAPSHOT_SYNC_SECRET"];
if (!clientTokens.some((k) => nonEmpty.has(k))) {
  console.error(
    "Missing client auth token in .dev.vars: set a non-empty value for one of " +
      clientTokens.join(" or ") +
      " (used as the /api/v1/* bearer)."
  );
  ok = false;
}

if (!ok) {
  console.error("\nFix .dev.vars (one KEY=value per line, no spaces around =).");
  console.error("Run from repo root: node scripts/check-devvars.mjs");
  process.exit(1);
}

console.log(
  "OK: .dev.vars defines LOGIN_USERNAME, LOGIN_PASSWORD, and a client auth token (values not shown)."
);
console.log("Restart `wrangler dev` after editing .dev.vars.");

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  compareAppliedState, parseManifest, parseWranglerExecuteJson, verifyFileHashes,
} from "./d1DriftCheck.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inside = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);

// Refuse every symlink component, including a dangling final component. Never read credentials.
function physicalDirectory(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) throw new Error("invalid_path");
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.lstatSync(current).isDirectory() || fs.lstatSync(current).isSymbolicLink()) throw new Error("invalid_path");
  }
  return fs.realpathSync(absolute);
}

export function validateRehearsal({ root, scratch, candidateSha, actions }) {
  if (actions !== "true" || !/^[0-9a-f]{40}$/.test(candidateSha ?? "")) throw new Error("invalid_identity");
  const checkout = physicalDirectory(root);
  const output = physicalDirectory(scratch);
  if (output === path.parse(output).root || inside(checkout, output) || inside(output, checkout)) throw new Error("invalid_scratch");
  for (const name of fs.readdirSync(checkout)) {
    if (name === ".dev.vars.example" && !fs.lstatSync(path.join(checkout, name)).isSymbolicLink()) continue;
    if (/^\.(?:env|dev\.vars)(?:\.|$)/.test(name)) throw new Error("local_credentials");
  }
  return { root: checkout, scratch: output };
}

/** Existing checklist, using its drift helpers and a fixed local-only command plan. */
export function runRehearsal(options, {
  run = spawnSync, now = () => new Date().toISOString(),
  isolated = () => fs.readdirSync("/sys/class/net").every((name) => name === "lo"),
} = {}) {
  const startedAt = now();
  const receipt = {
    schemaVersion: 1, command: "deploy:rehearsal", candidateSha: null, startedAt,
    finishedAt: null, scope: "offline", conclusion: "FAIL", errorCode: null,
    checks: [], migrations: null, cleanup: "NOT ALLOCATED",
    live: { repositoryGateExplicitFalse: "NOT VERIFIED", remoteJournal: "NOT VERIFIED", stagingProbe: "NOT VERIFIED" },
  };
  let work;
  try {
    const { root, scratch } = validateRehearsal(options);
    receipt.candidateSha = options.candidateSha;
    if (!isolated()) throw new Error("network_not_isolated");
    // Subprocesses receive no inherited token, OAuth cache, NODE_OPTIONS or npm config.
    work = fs.mkdtempSync(path.join(scratch, "offline-rehearsal-"));
    const home = path.join(work, "home");
    fs.mkdirSync(home);
    const env = {
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home,
      XDG_CONFIG_HOME: path.join(home, "config"), XDG_CACHE_HOME: path.join(home, "cache"),
      XDG_DATA_HOME: path.join(home, "data"), XDG_STATE_HOME: path.join(home, "state"),
      TMPDIR: work, CI: "true", WRANGLER_SEND_METRICS: "false",
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
      WRANGLER_LOG_PATH: path.join(work, "wrangler.log"),
    };
    const execute = (id, args) => {
      const at = now();
      const result = run(process.execPath, args, {
        cwd: root, env, encoding: "utf8", timeout: 180_000,
        maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
      });
      const exitCode = Number.isInteger(result.status) ? result.status : null;
      receipt.checks.push({
        id, command: ["node", ...args.map((arg) => arg.startsWith(work) ? arg.replace(work, "<scratch>") : arg)],
        startedAt: at, finishedAt: now(), exitCode,
        conclusion: exitCode === 0 && !result.error ? "PASS" : "FAIL",
      });
      if (result.error || exitCode !== 0) throw new Error("command_failed");
      return result.stdout;
    };
    // Bind the receipt to the actual checkout before accepting configuration or bundle results.
    const identity = run("/usr/bin/git", ["rev-parse", "HEAD"], {
      cwd: root, env, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
    });
    if (identity.error || identity.status !== 0 || identity.stdout.trim() !== options.candidateSha) throw new Error("candidate_mismatch");
    const clean = run("/usr/bin/git", ["status", "--porcelain", "--untracked-files=normal"], {
      cwd: root, env, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
    });
    if (clean.error || clean.status !== 0 || clean.stdout.trim()) throw new Error("dirty_candidate");
    execute("workflow", ["scripts/check-ci-workflow.mjs"]);
    execute("vars-parity", ["scripts/check-vars-parity.mjs"]);
    const dir = path.join(root, "migrations/d1");
    const manifest = fs.readFileSync(path.join(dir, ".sha256sum"));
    const entries = fs.readdirSync(dir).filter((name) => name.endsWith(".sql")).sort().map((name) => {
      const file = path.join(dir, name);
      if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error("invalid_migration");
      return { name, sha: sha256(fs.readFileSync(file)) };
    });
    if (!entries.length || !verifyFileHashes(entries, parseManifest(manifest.toString("utf8"))).ok) throw new Error("manifest_drift");
    receipt.migrations = { manifestSha256: sha256(manifest), files: entries, localJournal: [], conclusion: "FAIL" };
    const wrangler = "node_modules/wrangler/bin/wrangler.js";
    const database = "routeware-customer-snapshot";
    const persist = path.join(work, "d1");
    execute("local-migrations", [wrangler, "d1", "migrations", "apply", database, "--local", "--persist-to", persist]);
    const journal = parseWranglerExecuteJson(execute("local-journal", [
      wrangler, "d1", "execute", database, "--local", "--persist-to", persist,
      "--command", "SELECT name FROM d1_migrations ORDER BY id;", "--json",
    ]));
    const names = entries.map((entry) => entry.name);
    if (!compareAppliedState(names, journal).ok || journal.length !== names.length) throw new Error("journal_drift");
    // Only committed names leave the scratch boundary, never arbitrary Wrangler output.
    receipt.migrations.localJournal = names;
    receipt.migrations.conclusion = "PASS";
    execute("worker-bundle", [wrangler, "deploy", "--dry-run", "--env=", "--outdir", path.join(work, "bundle")]);
    if (!fs.existsSync(path.join(work, "bundle/worker.js"))) throw new Error("missing_bundle");
    receipt.bundle = { sha256: sha256(fs.readFileSync(path.join(work, "bundle/worker.js"))) };
    receipt.conclusion = "PASS";
  } catch (error) {
    const codes = ["invalid_identity", "invalid_path", "invalid_scratch", "local_credentials", "network_not_isolated", "candidate_mismatch", "dirty_candidate", "command_failed", "invalid_migration", "manifest_drift", "journal_drift", "missing_bundle"];
    receipt.errorCode = codes.includes(error?.message) ? error.message : "rehearsal_error";
  } finally {
    if (work) {
      try {
        fs.rmSync(work, { recursive: true, force: true });
        receipt.cleanup = "PASS";
      } catch {
        receipt.cleanup = "FAIL";
        receipt.conclusion = "FAIL";
        receipt.errorCode = "cleanup_failed";
      }
    }
    receipt.finishedAt = now();
  }
  return receipt;
}

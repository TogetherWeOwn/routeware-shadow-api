import { spawn } from "node:child_process";

/**
 * Real spawn runner for the `verify:config` preflight.
 *
 * `scripts/lib/verifyConfig.mjs` must stay free of `node:child_process` (its
 * suite runs in the workers pool), so the impure child-spawning half lives
 * here. The runner matches the injected-runner contract: it resolves
 * `{ exitCode }`, rejects on spawn failure, and kills the child when the
 * leg's AbortSignal aborts (the lib owns the timeout timer and aborts on
 * expiry). `stdio: "ignore"` keeps child output off the parent's streams so
 * `--json` output stays exactly one object; `"inherit"` preserves today's
 * human-mode behavior where each leg prints its own detail.
 *
 * @param {{ cwd?: string }} [opts]
 * @returns {(check: { name: string, script: string, args: string[] }, ctx: { timeoutMs: number, signal: AbortSignal, stdio?: string }) => Promise<{ exitCode: number|null }>}
 */
export function createSpawnRunner({ cwd } = {}) {
  return (check, { signal, stdio } = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn("node", [check.script, ...(check.args ?? [])], {
        cwd,
        stdio: stdio === "inherit" ? "inherit" : "ignore",
      });
      let settled = false;
      const onAbort = () => {
        child.kill();
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }
      const done = (settle) => (value) => {
        if (settled) {
          return;
        }
        settled = true;
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
        settle(value);
      };
      child.on("error", done(reject));
      child.on("close", done((code) => resolve({ exitCode: code })));
    });
}

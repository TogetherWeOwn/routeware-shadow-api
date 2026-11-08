import { PROBES, resolveBase } from "./postDeployProbe.mjs";

const utc = (value) => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value));

/** Classify data only. Never fetch a target, resolve a token or execute a probe. */
export function classifyProbeEvidence(evidence) {
  const result = { schemaVersion: 1, command: "probe:evidence", candidateSha: null, observedAt: null,
    classification: "NOT VERIFIED", liveReadiness: "NOT VERIFIED", reason: "missing_receipt" };
  const finish = (classification, reason) => ({ ...result, classification,
    liveReadiness: classification === "PASS" && evidence?.kind === "staging-probe" ? "PASS" : "NOT VERIFIED", reason });
  if (!evidence || !/^[0-9a-f]{40}$/.test(evidence.candidateSha ?? "") || !utc(evidence.observedAt)) return result;
  result.candidateSha = evidence.candidateSha;
  result.observedAt = evidence.observedAt;
  const probe = evidence.probe;
  if (!["staging-probe", "synthetic"].includes(evidence.kind) || probe?.schemaVersion !== 1 ||
      probe.command !== "probe:post-deploy" || probe.mode !== "run") return finish("NOT VERIFIED", "not_executed_probe");
  try {
    // Reuse the scheduled target guard; localhost, plans and ordinary CI never prove live readiness.
    const target = new URL(resolveBase({ positional: probe.target, scheduled: true })).origin;
    if (evidence.kind === "staging-probe") {
      const approved = new URL(resolveBase({ positional: evidence.approvedStagingOrigin, scheduled: true })).origin;
      if (approved !== target) return finish("NOT VERIFIED", "unapproved_target");
    }
  } catch {
    return finish("NOT VERIFIED", "unapproved_target");
  }
  const rows = probe.checks;
  if (!Array.isArray(rows) || rows.length !== PROBES.length || !PROBES.every((expected, index) => {
    const row = rows[index];
    return row?.id === expected.id && row.method === "GET" && row.path === expected.path;
  })) return finish("NOT VERIFIED", "incomplete_checks");
  // Real endpoint/degraded/stale failures take precedence over an unrelated missing token.
  if (rows.some((row) => row.outcome === "fail" && row.errorCode !== "missing_token") ||
      rows.some((row) => row.cron === "stale" || row.cron === "malformed")) return finish("FAIL", "probe_failed");
  if (rows.slice(1).some((row) => row.errorCode === "missing_token" && ["skip", "fail"].includes(row.outcome))) return finish("SKIPPED", "missing_token");
  if (evidence.exitCode !== 0 || probe.ok !== true || probe.errorCode !== null) return finish("FAIL", "overall_failure");
  if (!rows.every((row) => row.outcome === "pass" && row.httpStatus === 200 && row.errorCode === null)) return finish("NOT VERIFIED", "incomplete_pass");
  // In the existing v1 evaluator a readiness pass at HTTP 200 entails body.status === "ok".
  // Unknown/absent cron was advisory to that CLI, but cannot count as readiness evidence here.
  if (rows[2].cron !== "fresh") return finish("NOT VERIFIED", "cron_unknown");
  return finish("PASS", evidence.kind === "synthetic" ? "synthetic_only" : "all_three_passed");
}

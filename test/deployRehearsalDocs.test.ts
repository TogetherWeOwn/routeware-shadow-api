/// <reference types="vite/client" />

import { describe, expect, it } from "vitest";
import checklist from "../docs/PRODUCTION-DEPLOY-DRY-RUN.md?raw";
import handover from "../docs/HANDOVER.md?raw";
import workflow from "../.github/workflows/ci.yml?raw";

function shellBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/^```bash\n([\s\S]*?)^```/gm)].map((match) => match[1]);
}

function hasSafeDryRun(markdown: string): boolean {
  const commands = shellBlocks(markdown).join("\n");
  const toolScript = commands.match(/sh -c '\n([\s\S]*?)\n\s*'/)?.[1];
  if (!toolScript || [...commands.matchAll(/\bwrangler\b/g)].length !== 1 ||
      [...commands.matchAll(/\bnpm\s+run\b/g)].length !== 3) return false;
  // Deliberately allow only this simple chain, not arbitrary shell syntax.
  const steps = toolScript.split("&&").map((step) => step.trim());
  return steps.length === 4 &&
    steps[0] === "npm run check:ci-workflow" &&
    steps[1] === "npm run check:vars-parity" &&
    steps[2] === "npm run check:d1-drift" &&
    /^npx --no-install wrangler deploy --dry-run(?:=true)? --env="" --outdir "\$PAPERCLIP_RUN_SCRATCH_DIR\/worker-dry-run"$/.test(steps[3]);
}

const repositoryDeployStop = /Keep the repository-scoped\s+`PRODUCTION_DEPLOY_ENABLED` variable set to `false` throughout this rehearsal/;

function safetyBoundary(markdown: string): boolean {
  return markdown.includes("**Production stays OFF.**") &&
    repositoryDeployStop.test(markdown) &&
    markdown.includes("not go-live approval") &&
    markdown.includes("Do not pass `--remote` during this rehearsal.") &&
    markdown.includes("Do not dispatch workflows or invoke a probe");
}

describe("production deploy rehearsal documentation", () => {
  it("is discoverable and preserves the explicit no-production boundary", () => {
    expect(handover).toContain("[production deploy dry-run checklist](PRODUCTION-DEPLOY-DRY-RUN.md)");
    expect(safetyBoundary(checklist)).toBe(true);
    for (const phrase of [
      "**Production stays OFF.**",
      "not go-live approval",
      "Do not pass `--remote` during this rehearsal.",
      "Do not dispatch workflows or invoke a probe",
    ]) {
      expect(safetyBoundary(checklist.replace(phrase, ""))).toBe(false);
    }
    expect(safetyBoundary(checklist.replace(repositoryDeployStop, ""))).toBe(false);
  });

  it("keeps the handover stop compatible with the rehearsal precondition", () => {
    const phase1 = handover.split("### Phase 1")[1]?.split("### Phase 2")[0] ?? "";
    expect(phase1).toMatch(/repository-scoped\s+`PRODUCTION_DEPLOY_ENABLED` variable to `false`/);
    expect(checklist).toMatch(repositoryDeployStop);
    expect(checklist).toContain("it overrides an applicable organization-level value for this repository");
    expect(checklist).toMatch(/Do not\s+add, edit or\s+delete a variable as part of this rehearsal\./);
  });

  it("offers only read-only metadata and credential-free local shell commands", () => {
    const blocks = shellBlocks(checklist);
    expect(blocks.length).toBe(2);
    const commands = blocks.join("\n");
    expect(commands).not.toMatch(/--remote|db:migrate:remote|secret\s+(?:put|set|delete)|variable\s+(?:set|delete)|workflow\s+run|\s-X\s+(?:POST|PUT|PATCH|DELETE)/);
    expect(hasSafeDryRun(checklist)).toBe(true);
    expect(commands).toContain("--outdir");
    expect(commands).toContain('env -i PATH="$PATH" HOME="$rehearsal_home"');
    expect(commands).toContain('XDG_CONFIG_HOME="$rehearsal_home/.config"');
    expect(commands).toContain(".env .env.* .dev.vars .dev.vars.*");
    expect(commands).toContain("export PAPERCLIP_RUN_SCRATCH_DIR");
    expect(commands).toContain("npm run check:ci-workflow");
    expect(commands).toContain("npm run check:vars-parity");
    expect(commands).toContain("npm run check:d1-drift");
    expect(commands).toContain(".variables[].name");
    expect(commands).toContain(".secrets[].name");
  });

  it("pins fail-closed isolated-HOME allocation before tool invocation", () => {
    const commands = shellBlocks(checklist).join("\n");
    const allocation = /^rehearsal_home=\$\(mktemp -d "\$PAPERCLIP_RUN_SCRATCH_DIR\/rehearsal-home\.XXXXXX"\) \|\| exit 1$/m;
    expect(commands).toMatch(allocation);
    expect(commands.replace('rehearsal-home.XXXXXX") || exit 1', 'rehearsal-home.XXXXXX")')).not.toMatch(allocation);
    expect(commands).toContain('env -i PATH="$PATH" PAPERCLIP_RUN_SCRATCH_DIR="${PAPERCLIP_RUN_SCRATCH_DIR:-}" sh -eu <<\'REHEARSAL\'');
    expect(commands).toContain("\nREHEARSAL\n");
    expect(commands.indexOf("rehearsal_home=$(mktemp")).toBeLessThan(commands.indexOf('env -i PATH="$PATH" HOME='));
  });

  it("rejects missing and explicitly disabled dry-run flags", () => {
    for (const flag of ["", "--dry-run=false", "--dry-run false", "--dry-run=0", "--no-dry-run"]) {
      expect(hasSafeDryRun(checklist.replace("--dry-run --env", `${flag} --env`))).toBe(false);
    }
    expect(hasSafeDryRun(checklist.replace("--dry-run --env", "--dry-run=true --env"))).toBe(true);
  });

  it("rejects additional deployments and unsupported compound commands", () => {
    for (const extra of [
      " && npx --no-install wrangler deploy",
      "; npx --no-install wrangler deploy",
      " || npx --no-install wrangler deploy",
      " | npx --no-install wrangler deploy",
      " && npm run deploy",
      " && npx wrangler versions upload && npx wrangler versions deploy --yes",
    ]) {
      expect(hasSafeDryRun(checklist.replace('/worker-dry-run"', `/worker-dry-run"${extra}`))).toBe(false);
    }
    expect(hasSafeDryRun(checklist.replace("npm run check:ci-workflow &&", "npm run deploy && npm run check:ci-workflow &&"))).toBe(false);
  });

  it("does not equate local checks, missing metadata or skipped probes with live readiness", () => {
    expect(checklist).toContain("An absent repository value does not establish that the effective gate is off.");
    expect(checklist).toMatch(/Local success does\s+not establish that production migrations are current/);
    expect(checklist).toContain("Authed probes skipped for missing credentials are **SKIPPED**, never green");
    expect(checklist).toContain("an unknown cron verdict is **NOT VERIFIED**");
    expect(checklist).toContain("summary and exit 0, readiness HTTP 200 with `status: \"ok\"`");
    expect(checklist).toContain("`PASS cron freshness -> fresh`");
    expect(checklist).toContain("degraded/503 readiness or stale cron is **FAIL**");
    expect(checklist).toContain("overall exit 0, readiness HTTP 200/ok and fresh cron");
    expect(checklist).toContain("This is not a\nproduction-readiness PASS");
    expect(checklist).toContain("does not roll back an already");
    for (const path of ["/api/v1/health", "/api/v1/shadow/health", "/api/v1/readiness"]) {
      expect(checklist).toContain(`GET ${path}`);
    }
  });

  it("pins the documented production gate and migration-before-deploy ordering", () => {
    const deploy = workflow.match(/^  deploy:\n[\s\S]*?(?=^  [\w-]+:\n|(?![\s\S]))/m)?.[0];
    expect(deploy).toBeDefined();
    expect(deploy).toMatch(/^    needs: \[build, hygiene\]$/m);
    const condition = "github.event_name == 'push' && github.ref == 'refs/heads/main' && vars.PRODUCTION_DEPLOY_ENABLED == 'true'";
    expect(deploy).toContain(`if: ${condition}`);
    expect(checklist).toContain(condition);
    expect(deploy).toMatch(/^    environment: production$/m);
    expect(deploy).toContain("group: deploy-production");
    expect(deploy).toContain("cancel-in-progress: false");
    const workflowConcurrency = workflow.split("\njobs:")[0];
    expect(workflowConcurrency).toContain(
      "group: ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}",
    );
    expect(workflowConcurrency).toContain(
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    );
    expect(checklist).toContain("cancels that PR's superseded runs");
    expect(checklist).toContain("a main push never cancels");
    expect(checklist).toContain("interruption risk");
    expect(checklist).toContain("**NOT READY**");
    const migrateAt = deploy!.indexOf("run: npm run db:migrate:remote");
    const publishAt = deploy!.indexOf("run: npx wrangler deploy");
    expect(migrateAt).toBeGreaterThan(0);
    expect(publishAt).toBeGreaterThan(migrateAt);
  });
});

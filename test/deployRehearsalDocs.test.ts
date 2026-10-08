/// <reference types="vite/client" />

import { describe, expect, it } from "vitest";
import checklist from "../docs/PRODUCTION-DEPLOY-DRY-RUN.md?raw";
import handover from "../docs/HANDOVER.md?raw";
import workflow from "../.github/workflows/ci.yml?raw";

function shellBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/^```bash\n([\s\S]*?)^```/gm)].map((match) => match[1]);
}

function hasSafeDryRun(markdown: string): boolean {
  const deployLines = shellBlocks(markdown).join("\n").split("\n")
    .filter((line) => /\bwrangler\s+deploy\b/.test(line));
  return deployLines.length === 1 && deployLines.every((line) =>
    /(?:^|\s)--dry-run(?:=true)?(?=\s|$)/.test(line) &&
    !/(?:^|\s)--no-dry-run\b|--dry-run(?:=|\s+)(?:false|0)\b/.test(line),
  );
}

function safetyBoundary(markdown: string): boolean {
  return markdown.includes("**Production stays OFF.**") &&
    /Leave `PRODUCTION_DEPLOY_ENABLED` unset/.test(markdown) &&
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
    expect(commands.indexOf("rehearsal_home=$(mktemp")).toBeLessThan(commands.indexOf("env -i"));
  });

  it("rejects missing and explicitly disabled dry-run flags", () => {
    for (const flag of ["", "--dry-run=false", "--dry-run false", "--dry-run=0", "--no-dry-run"]) {
      expect(hasSafeDryRun(checklist.replace("--dry-run --env", `${flag} --env`))).toBe(false);
    }
    expect(hasSafeDryRun(checklist.replace("--dry-run --env", "--dry-run=true --env"))).toBe(true);
  });

  it("does not equate local checks, missing metadata or skipped probes with live readiness", () => {
    expect(checklist).toContain("Organization variables can apply");
    expect(checklist).toContain("alone does not prove effective absence");
    expect(checklist).toMatch(/Local success does\s+not establish that production migrations are current/);
    expect(checklist).toContain("Authed probes skipped for missing credentials are **SKIPPED**, never green");
    expect(checklist).toContain("an unknown cron verdict is **NOT VERIFIED**");
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
    expect(workflowConcurrency).toContain("cancel-in-progress: true");
    expect(checklist).toContain("a newer main push can cancel");
    expect(checklist).toContain("an older workflow during migrations/deploy despite the job-level setting");
    expect(checklist).toContain("interruption risk as **NOT READY**");
    const migrateAt = deploy!.indexOf("run: npm run db:migrate:remote");
    const publishAt = deploy!.indexOf("run: npx wrangler deploy");
    expect(migrateAt).toBeGreaterThan(0);
    expect(publishAt).toBeGreaterThan(migrateAt);
  });
});

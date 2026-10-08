/// <reference types="vite/client" />

import { describe, expect, it } from "vitest";
import checklist from "../docs/PRODUCTION-DEPLOY-DRY-RUN.md?raw";
import handover from "../docs/HANDOVER.md?raw";
import workflow from "../.github/workflows/ci.yml?raw";

function shellBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/^```bash\n([\s\S]*?)^```/gm)].map((match) => match[1]);
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
    const deployLines = commands.split("\n").filter((line) => /wrangler deploy/.test(line));
    expect(deployLines.length).toBe(1);
    expect(deployLines[0]).toContain("--dry-run");
    expect(deployLines[0]).toContain("--outdir");
    expect(commands).toContain("npm run check:ci-workflow");
    expect(commands).toContain("npm run check:vars-parity");
    expect(commands).toContain("npm run check:d1-drift");
    expect(commands).toContain("unset CLOUDFLARE_API_TOKEN CLOUDFLARE_API_KEY CLOUDFLARE_EMAIL");
    expect(commands).toContain(".variables[].name");
    expect(commands).toContain(".secrets[].name");
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
    const migrateAt = deploy!.indexOf("run: npm run db:migrate:remote");
    const publishAt = deploy!.indexOf("run: npx wrangler deploy");
    expect(migrateAt).toBeGreaterThan(0);
    expect(publishAt).toBeGreaterThan(migrateAt);
  });
});

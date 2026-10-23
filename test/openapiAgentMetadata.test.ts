import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import packageJson from "../package.json";
import app from "../src/app";
import changelog from "../CHANGELOG.md?raw";
import quickstart from "../docs/CONSUMER-QUICKSTART.md?raw";

/**
 * Agent-facing OpenAPI metadata (acceptance for operation discovery).
 *
 * An AI agent choosing a tool needs three machine-readable facts per mounted
 * operation, without reading prose: a stable `operationId`, an access class
 * (`x-access`) and an effect class (`x-effect`). This file is the executable
 * contract for the mounted `/openapi.json` document.
 *
 * Contract
 * --------
 * `operationId`: unique lowerCamelCase string on EVERY mounted `/api/v1`
 *   operation; the two pre-existing ids (`health`, `listCustomerSnapshot`)
 *   are preserved.
 *
 * `x-access` (operation extension, one of):
 *   - `public`       no bearer (only `GET /api/v1/health`)
 *   - `read`         outer gate; `SHADOW_API_READ_TOKEN` (GET only), the full
 *                    token, or the sync secret
 *   - `full`         outer gate, non-GET: full token (or sync secret); the
 *                    read token is rejected
 *   - `sync-secret`  outer gate PLUS the inner privileged gate
 *                    (`requireSnapshotAuth`): only
 *                    `CUSTOMER_SNAPSHOT_SYNC_SECRET`; includes privileged
 *                    GETs (exports, orphans, /data reads, R2 archive)
 *
 * `x-effect` (operation extension, one of):
 *   - `none`                          no data access (liveness, 405 stub)
 *   - `local-read`                    D1/R2/config reads only; no upstream
 *   - `upstream-read`                 reads Routeware (including POST reads)
 *   - `local-write`                   mutates D1 only; upstream untouched
 *   - `upstream-read-local-sync`      pulls Routeware report data into D1/R2
 *   - `upstream-write-local-refresh`  writes Routeware, then refreshes D1
 *
 * `x-agent-metadata` (document root): `{ access: {...}, effect: {...} }`, a
 *   one-line legend per class above.
 *
 * Oracles: the mounted document and `app.routes` are the only operation
 * inventory (no hand-kept path list for completeness); `x-access` is verified
 * against the LIVE gates (outer 401 / inner 401 / pass-through) with the same
 * tokens `test/readOnlyRole.test.ts`, `test/dualSecretMatrix.test.ts` and
 * `test/authGateResweep.test.ts` use; `x-effect` is verified against pinned
 * semantic rules plus explicit representative cases.
 *
 * Run: `npm run check:openapi-agent-metadata` (this file only, credential-free).
 */

// Matches wrangler.toml [env.test.vars].
const API_TOKEN = "test-api-token";
const READ_TOKEN = "test-read-token";

const OUTER_DETAIL =
  "Send Authorization: Bearer <SHADOW_API_TOKEN>. See docs/PROBLEMS.md#unauthorized.";
const INNER_DETAIL =
  "Send Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>. See docs/PROBLEMS.md#unauthorized.";

const ACCESS_CLASSES = ["public", "read", "full", "sync-secret"] as const;
const EFFECT_CLASSES = [
  "none",
  "local-read",
  "upstream-read",
  "local-write",
  "upstream-read-local-sync",
  "upstream-write-local-refresh"
] as const;

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"];

type Operation = Record<string, unknown>;
type OpenApiDocument = {
  info: { description?: string };
  security?: Array<Record<string, unknown>>;
  paths: Record<string, Record<string, Operation>>;
  components?: { securitySchemes?: Record<string, { type?: string; scheme?: string; description?: string }> };
  "x-agent-metadata"?: {
    access?: Record<string, unknown>;
    effect?: Record<string, unknown>;
  };
};
type MountedOp = { key: string; method: string; path: string; operation: Operation };

async function fetchDocument(): Promise<OpenApiDocument> {
  const res = await exports.default.fetch("http://test.local/openapi.json");
  expect(res.status).toBe(200);
  return (await res.json()) as OpenApiDocument;
}

function documentedOperations(doc: OpenApiDocument): MountedOp[] {
  const ops: MountedOp[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (HTTP_METHODS.includes(method.toLowerCase())) {
        ops.push({
          key: `${method.toUpperCase()} ${path}`,
          method: method.toUpperCase(),
          path,
          operation
        });
      }
    }
  }
  return ops.sort((a, b) => a.key.localeCompare(b.key));
}

/** Operations the live router mounts, in OpenAPI `{param}` spelling. */
function routerOperationKeys(): string[] {
  const keys = new Set<string>();
  for (const r of app.routes) {
    if (r.method === "ALL" || !r.path.startsWith("/api/v1/")) {
      continue;
    }
    keys.add(`${r.method} ${r.path.replace(/:([^/]+)/g, "{$1}")}`);
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
}

function missing(ops: MountedOp[], pick: (op: MountedOp) => unknown): string[] {
  return ops.filter((op) => typeof pick(op) !== "string").map((op) => op.key);
}

describe("operation identities", () => {
  it("documents exactly the operations the live router mounts", async () => {
    const ops = documentedOperations(await fetchDocument());

    expect(ops.map((op) => op.key)).toEqual(routerOperationKeys());
  });

  it("gives every mounted operation an operationId", async () => {
    const ops = documentedOperations(await fetchDocument());

    expect(missing(ops, (op) => op.operation["operationId"])).toEqual([]);
  });

  it("keeps every operationId unique and lowerCamelCase", async () => {
    const ops = documentedOperations(await fetchDocument());
    const ids = ops.map((op) => String(op.operation["operationId"]));

    const badShape = ids.filter((id) => !/^[a-z][A-Za-z0-9]*$/.test(id));
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);

    expect(badShape).toEqual([]);
    expect(duplicates).toEqual([]);
    expect(new Set(ids).size).toBe(routerOperationKeys().length);
  });

  it("preserves the operationIds that already existed", async () => {
    const doc = await fetchDocument();

    expect(doc.paths["/api/v1/health"]?.["get"]?.["operationId"]).toBe("health");
    expect(doc.paths["/api/v1/customer-snapshot"]?.["get"]?.["operationId"]).toBe(
      "listCustomerSnapshot"
    );
  });
});

describe("access classification", () => {
  it("publishes a one-line legend for the access and effect classes", async () => {
    const legend = (await fetchDocument())["x-agent-metadata"];

    expect(Object.keys(legend?.access ?? {}).sort()).toEqual([...ACCESS_CLASSES].sort());
    expect(Object.keys(legend?.effect ?? {}).sort()).toEqual([...EFFECT_CLASSES].sort());
    const lines = [...Object.values(legend?.access ?? {}), ...Object.values(legend?.effect ?? {})];
    for (const line of lines) {
      expect(typeof line).toBe("string");
      expect((line as string).length).toBeGreaterThan(10);
      expect((line as string).length).toBeLessThanOrEqual(240);
    }
    // The legend names the credentials, so an agent need not read prose elsewhere.
    expect(legend?.access?.["read"]).toContain("SHADOW_API_READ_TOKEN");
    expect(legend?.access?.["sync-secret"]).toContain("CUSTOMER_SNAPSHOT_SYNC_SECRET");
  });

  it("classifies every mounted operation with a known x-access", async () => {
    const ops = documentedOperations(await fetchDocument());

    const unknown = ops
      .filter((op) => !(ACCESS_CLASSES as readonly unknown[]).includes(op.operation["x-access"]))
      .map((op) => `${op.key}=${String(op.operation["x-access"])}`);

    expect(unknown).toEqual([]);
  });

  it("marks only the health probe public, and only GET operations read-accessible", async () => {
    const ops = documentedOperations(await fetchDocument());

    expect(ops.filter((op) => op.operation["x-access"] === "public").map((op) => op.key)).toEqual([
      "GET /api/v1/health"
    ]);
    // The read token never authorizes non-GET methods.
    expect(
      ops.filter((op) => op.operation["x-access"] === "read" && op.method !== "GET").map((op) => op.key)
    ).toEqual([]);
  });

  it("pins representative access classes, including privileged GETs", async () => {
    const doc = await fetchDocument();
    const access = (key: string): unknown => {
      const [method, path] = key.split(" ") as [string, string];
      return doc.paths[path]?.[method.toLowerCase()]?.["x-access"];
    };
    const expected: Record<string, string> = {
      "GET /api/v1/health": "public",
      "GET /api/v1/shadow/health": "read",
      "GET /api/v1/readiness": "read",
      "GET /api/v1/customer-snapshot": "read",
      "GET /api/v1/customer-snapshot/{customerId}": "read",
      "GET /api/v1/address-snapshot": "read",
      "GET /api/v1/container-snapshot/{containerId}": "read",
      "GET /api/v1/routeware/home/index": "read",
      "POST /api/v1/routeware/customer/customers-read": "full",
      "POST /api/v1/routeware/customer/save-long-form": "full",
      "DELETE /api/v1/routeware/customer": "full",
      // Privileged GETs: outer gate passes the read token, the inner gate does not.
      "GET /api/v1/customer-snapshot/export": "sync-secret",
      "GET /api/v1/address-snapshot/export": "sync-secret",
      "GET /api/v1/container-snapshot/export": "sync-secret",
      "GET /api/v1/data-snapshot/orphans": "sync-secret",
      "GET /api/v1/data/customer": "sync-secret",
      "GET /api/v1/data/address": "sync-secret",
      "GET /api/v1/data/container": "sync-secret",
      "GET /api/v1/snapshots/{table}/{date}": "sync-secret",
      "GET /api/v1/snapshots/{table}": "sync-secret",
      "POST /api/v1/data/customer": "sync-secret",
      "POST /api/v1/customer-snapshot/sync": "sync-secret",
      "POST /api/v1/data-snapshot/sync": "sync-secret",
      "POST /api/v1/customer-snapshot/import": "sync-secret",
      "DELETE /api/v1/customer-snapshot/{customerId}": "sync-secret"
    };

    const actual = Object.fromEntries(Object.keys(expected).map((k) => [k, access(k)]));

    expect(actual).toEqual(expected);
  });

  it("describes the bearer roles truthfully without changing the token transport", async () => {
    const doc = await fetchDocument();
    const scheme = doc.components?.securitySchemes?.["bearerAuth"];

    expect(Object.keys(doc.components?.securitySchemes ?? {})).toEqual(["bearerAuth"]);
    expect(scheme?.type).toBe("http");
    expect(scheme?.scheme).toBe("bearer");
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
    // Roles the runtime really accepts, named where the agent reads auth.
    expect(scheme?.description).toContain("SHADOW_API_READ_TOKEN");
    expect(scheme?.description).toContain("GET");
    expect(scheme?.description).toContain("CUSTOMER_SNAPSHOT_SYNC_SECRET");
    expect(scheme?.description).toContain("x-access");
  });

  it("advertises no per-operation security combination the runtime cannot accept", async () => {
    const ops = documentedOperations(await fetchDocument());

    // Absent (inherits bearerAuth) or an empty list on the public probe only.
    const offenders = ops
      .filter((op) => {
        const security = op.operation["security"];
        if (security === undefined) return false;
        return !(op.key === "GET /api/v1/health" && Array.isArray(security) && security.length === 0);
      })
      .map((op) => op.key);

    expect(offenders).toEqual([]);
  });
});

describe("effect classification", () => {
  /**
   * Semantic oracle, independent of the metadata under test. Returns
   * `undefined` for an operation no rule covers: a NEW route then fails the
   * coverage test below until a human extends the rules (like the pinned
   * privileged set in `authGateResweep`).
   */
  function expectedEffect(method: string, path: string): string | undefined {
    if (path === "/api/v1/health" || path === "/api/v1/shadow/health") return "none";
    if (method === "DELETE" && path === "/api/v1/routeware/customer") return "none";
    if (path === "/api/v1/readiness") return "local-read";
    if (method === "POST" && path.endsWith("/sync")) return "upstream-read-local-sync";
    if (method === "POST" && path.endsWith("/import")) return "local-write";
    if (method === "DELETE" && path.startsWith("/api/v1/customer-snapshot/")) return "local-write";
    if (method === "POST" && path.startsWith("/api/v1/data/")) return "upstream-write-local-refresh";
    if (
      method === "POST" &&
      /^\/api\/v1\/routeware\/(customer\/save-long-form|address\/save-address-form|container\/save-container-form)$/.test(
        path
      )
    ) {
      return "upstream-write-local-refresh";
    }
    if (
      method === "GET" &&
      (/^\/api\/v1\/(customer|address|container)-snapshot(\/|$)/.test(path) ||
        path.startsWith("/api/v1/data/") ||
        path.startsWith("/api/v1/snapshots/") ||
        path === "/api/v1/data-snapshot/orphans")
    ) {
      return "local-read";
    }
    if (path.startsWith("/api/v1/routeware/")) return "upstream-read";
    return undefined;
  }

  it("classifies every mounted operation with a known x-effect", async () => {
    const ops = documentedOperations(await fetchDocument());

    const unknown = ops
      .filter((op) => !(EFFECT_CLASSES as readonly unknown[]).includes(op.operation["x-effect"]))
      .map((op) => `${op.key}=${String(op.operation["x-effect"])}`);

    expect(unknown).toEqual([]);
  });

  it("has a semantic oracle rule for every mounted operation", async () => {
    const ops = documentedOperations(await fetchDocument());

    expect(ops.filter((op) => expectedEffect(op.method, op.path) === undefined).map((op) => op.key)).toEqual(
      []
    );
  });

  it("matches the semantic oracle on every operation", async () => {
    const ops = documentedOperations(await fetchDocument());

    const actual = Object.fromEntries(ops.map((op) => [op.key, op.operation["x-effect"]]));
    const expected = Object.fromEntries(ops.map((op) => [op.key, expectedEffect(op.method, op.path)]));

    expect(actual).toEqual(expected);
  });

  it("pins representative effects: POST is not always a write", async () => {
    const doc = await fetchDocument();
    const effect = (key: string): unknown => {
      const [method, path] = key.split(" ") as [string, string];
      return doc.paths[path]?.[method.toLowerCase()]?.["x-effect"];
    };
    const expected: Record<string, string> = {
      "GET /api/v1/health": "none",
      "DELETE /api/v1/routeware/customer": "none",
      "GET /api/v1/readiness": "local-read",
      "GET /api/v1/customer-snapshot": "local-read",
      "GET /api/v1/data/customer": "local-read",
      "GET /api/v1/snapshots/{table}/{date}": "local-read",
      "GET /api/v1/snapshots/{table}": "local-read",
      "GET /api/v1/routeware/home/index": "upstream-read",
      "POST /api/v1/routeware/customer/customers-read": "upstream-read",
      "POST /api/v1/routeware/customer/detail-full": "upstream-read",
      "POST /api/v1/routeware/data/app-settings-get": "upstream-read",
      "POST /api/v1/customer-snapshot/import": "local-write",
      "DELETE /api/v1/customer-snapshot/{customerId}": "local-write",
      "POST /api/v1/customer-snapshot/sync": "upstream-read-local-sync",
      "POST /api/v1/data-snapshot/sync": "upstream-read-local-sync",
      "POST /api/v1/routeware/customer/save-long-form": "upstream-write-local-refresh",
      "POST /api/v1/data/container": "upstream-write-local-refresh"
    };

    const actual = Object.fromEntries(Object.keys(expected).map((k) => [k, effect(k)]));

    expect(actual).toEqual(expected);
  });

  it("never lets a read-token-accessible operation write or sync", async () => {
    const ops = documentedOperations(await fetchDocument());

    const offenders = ops
      .filter(
        (op) =>
          op.operation["x-access"] === "read" &&
          !["none", "local-read", "upstream-read"].includes(String(op.operation["x-effect"]))
      )
      .map((op) => op.key);

    expect(offenders).toEqual([]);
  });

  it("uses every declared class at least once", async () => {
    const ops = documentedOperations(await fetchDocument());

    expect([...new Set(ops.map((op) => op.operation["x-access"]))].sort()).toEqual(
      [...ACCESS_CLASSES].sort()
    );
    expect([...new Set(ops.map((op) => op.operation["x-effect"]))].sort()).toEqual(
      [...EFFECT_CLASSES].sort()
    );
  });
});

describe("discovery payload stays small", () => {
  it("keeps per-operation identity and classification under 160 bytes", async () => {
    const ops = documentedOperations(await fetchDocument());

    const oversized = ops
      .map((op) => ({
        key: op.key,
        bytes: JSON.stringify({
          operationId: op.operation["operationId"],
          "x-access": op.operation["x-access"],
          "x-effect": op.operation["x-effect"]
        }).length
      }))
      .filter((o) => o.bytes > 160)
      .map((o) => `${o.key}:${o.bytes}`);

    expect(oversized).toEqual([]);
  });
});

describe("x-access matches the live gates", () => {
  const originalFetch = globalThis.fetch;
  let seq = 0;

  beforeEach(() => {
    // Hermetic: any request that clears the gates and reaches Routeware throws,
    // surfacing as a non-401 error response. Nothing leaves the test.
    globalThis.fetch = (async () => {
      throw new Error("Unexpected upstream fetch in openapi agent metadata test");
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Fresh benchmark-range IP per call so per-IP auth-throttle buckets never leak.
  function freshIp(): string {
    seq += 1;
    return `198.18.${Math.floor(seq / 250)}.${(seq % 250) + 1}`;
  }

  function concrete(path: string): string {
    return path
      .replace("{table}", "customer")
      .replace("{date}", "2026-01-01")
      .replace(/\{[^}]+\}/g, "1");
  }

  async function probe(
    op: MountedOp,
    token: string | null
  ): Promise<{ status: number; detail: string | undefined }> {
    const headers = new Headers({ "CF-Connecting-IP": freshIp() });
    if (token !== null) {
      headers.set("authorization", `Bearer ${token}`);
    }
    const res = await exports.default.fetch(`http://test.local${concrete(op.path)}`, {
      method: op.method,
      headers
    });
    let detail: string | undefined;
    if (res.status === 401) {
      detail = ((await res.json()) as { detail?: string }).detail;
    } else {
      await res.arrayBuffer();
    }
    return { status: res.status, detail };
  }

  it("rejects an anonymous caller everywhere except on public operations", async () => {
    const ops = documentedOperations(await fetchDocument());

    const mismatches: string[] = [];
    for (const op of ops) {
      const { status, detail } = await probe(op, null);
      if (op.operation["x-access"] === "public") {
        if (status === 401) mismatches.push(`${op.key}: public but 401`);
      } else if (status !== 401 || detail !== OUTER_DETAIL) {
        mismatches.push(`${op.key}: expected outer 401, got ${status}`);
      }
    }

    expect(mismatches).toEqual([]);
  });

  it("agrees with the read-token gate (GET-only outer, sync secret inner)", async () => {
    const ops = documentedOperations(await fetchDocument()).filter(
      (op) => op.operation["x-access"] !== "public"
    );

    const mismatches: string[] = [];
    for (const op of ops) {
      const { status, detail } = await probe(op, READ_TOKEN);
      const cls = op.operation["x-access"];
      if (cls === "read") {
        if (status === 401) mismatches.push(`${op.key}: read class but read token got 401`);
      } else {
        const want = op.method === "GET" && cls === "sync-secret" ? INNER_DETAIL : OUTER_DETAIL;
        if (status !== 401 || detail !== want) {
          mismatches.push(`${op.key}: class ${String(cls)} expected 401 "${want}", got ${status}`);
        }
      }
    }

    expect(mismatches).toEqual([]);
  });

  it("agrees with the inner privileged gate for the full API token", async () => {
    const ops = documentedOperations(await fetchDocument()).filter(
      (op) => op.operation["x-access"] !== "public"
    );

    const mismatches: string[] = [];
    for (const op of ops) {
      const { status, detail } = await probe(op, API_TOKEN);
      if (op.operation["x-access"] === "sync-secret") {
        if (status !== 401 || detail !== INNER_DETAIL) {
          mismatches.push(`${op.key}: privileged but API token got ${status}`);
        }
      } else if (status === 401) {
        mismatches.push(`${op.key}: non-privileged but API token got 401`);
      }
    }

    expect(mismatches).toEqual([]);
  });
});

describe("wiring and documentation", () => {
  it("exposes an agent-runnable command that runs this file only", () => {
    const script = (packageJson.scripts as Record<string, string>)["check:openapi-agent-metadata"];

    expect(script).toContain("vitest run");
    expect(script).toContain("test/openapiAgentMetadata.test.ts");
  });

  it("notes the change in the 1.0.0 changelog section", () => {
    const release = changelog.split(/^## /m).find((s) => s.startsWith("[1.0.0]")) ?? "";

    expect(release).toContain("operationId");
    expect(release).toContain("x-access");
    expect(release).toContain("x-effect");
  });

  it("documents the discovery schema with an example in the consumer quickstart", () => {
    expect(quickstart).toContain("x-access");
    expect(quickstart).toContain("x-effect");
    expect(quickstart).toContain("operationId");
    expect(quickstart).toContain("npm run check:openapi-agent-metadata");
  });
});

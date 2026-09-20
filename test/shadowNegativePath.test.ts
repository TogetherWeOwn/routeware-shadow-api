import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { shadowHealthResponseSchema } from "../src/routes/shadow";

// Matches wrangler.toml [env.test.vars].
const API_TOKEN = "test-api-token";

/**
 * TOG-3518 staging slice: negative-path probe for the versioned Shadow API.
 *
 * Asserts the worker rejects cleanly — unknown version prefix and unknown
 * route return the typed 404 envelope (RFC 7807 `application/problem+json`
 * from `src/lib/problem.ts`, `type` anchoring into `docs/PROBLEMS.md`), not
 * a stack trace or an empty 500.
 *
 * Envelope note: the issue text sketches `{ok:false,error:...}`, but this
 * repo's typed error envelope is problem+json (CONVENTIONS.md § "OpenAPI and
 * the public HTTP surface"; every `type` URL anchors into PROBLEMS.md).
 * The probe pins the envelope the codebase actually serves.
 *
 * Gate note: the `/api/v1/*` bearer gate (`src/app.ts`) only matches the v1
 * prefix, so an unknown *version* (`/api/v9/...`) falls through to
 * `app.notFound` without requiring auth, while an unknown *route* under v1
 * hits the gate first (401 without a token, 404 with one). Both orderings
 * are pinned below.
 *
 * Staging-only, no creds in repo (test-env token only), no prod route
 * changed. Runs under `npm test` and `npm run test:contracts`.
 */
async function call(path: string, token: string | null): Promise<Response> {
  const headers = new Headers();
  if (token !== null) {
    headers.set("authorization", `Bearer ${token}`);
  }
  return exports.default.fetch(`http://test.local${path}`, { headers });
}

type ProblemBody = {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  stack?: unknown;
};

async function expectTyped404(res: Response, path: string): Promise<ProblemBody> {
  // Status and envelope first: typed 404, never a stack trace or empty 500.
  expect(res.status).toBe(404);
  expect(res.status).not.toBe(500);
  expect(res.headers.get("content-type")).toContain("problem+json");
  const body = (await res.json()) as ProblemBody;
  expect(body.type).toBe(
    "https://github.com/rick7c2/routeware-shadow-api/blob/main/docs/PROBLEMS.md#not-found"
  );
  expect(body.title).toBe("Not Found");
  expect(body.status).toBe(404);
  expect(body.detail).toContain(path);
  // No internal leakage: the onError 500 shape stays on 500s, never here.
  expect("stack" in body).toBe(false);
  return body;
}

describe("shadow API negative path: unknown version and unknown route", () => {
  it("rejects an unknown version prefix with a typed 404 (positive)", async () => {
    // Arrange / Act
    const res = await call("/api/v9/unknown", API_TOKEN);

    // Assert
    await expectTyped404(res, "/api/v9/unknown");
  });

  it("rejects the unknown version prefix without requiring auth (outside the /api/v1/* gate)", async () => {
    // Arrange / Act — no token: the v1 gate does not cover /api/v9/*, so the
    // reject is still the typed 404, not a 401 and not a 500.
    const res = await call("/api/v9/unknown", null);

    // Assert
    await expectTyped404(res, "/api/v9/unknown");
  });

  it("rejects an unknown route under the known version with a typed 404 once authorized", async () => {
    // Arrange / Act
    const res = await call("/api/v1/shadow/does-not-exist", API_TOKEN);

    // Assert
    await expectTyped404(res, "/api/v1/shadow/does-not-exist");
  });

  it("gate runs before routing under the known version (401 without a token)", async () => {
    // Arrange / Act
    const res = await call("/api/v1/shadow/does-not-exist", null);

    // Assert — unauthorized v1 requests never reach routing, even unknown paths.
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("problem+json");
  });

  it("known-good still passes per the TOG-3495 contract (negative-of-regression)", async () => {
    // Arrange / Act
    const res = await call("/api/v1/shadow/health", API_TOKEN);

    // Assert — 200 + schema valid, so the negative-path reject cannot mask a
    // regression that breaks the versioned route itself.
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(shadowHealthResponseSchema.safeParse(body).success).toBe(true);
  });
});

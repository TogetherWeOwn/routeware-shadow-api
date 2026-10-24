/// <reference types="vite/client" />

import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { ensureD1TestTables } from "./d1TestMigrations";

// Merge composition: #343 landed followable `Link` next targets after the
// upperId acceptance suite was frozen, so no Test Author file pins the two
// together. This file pins the acceptance-criteria composition from the
// Builder side: a capped page's next target carries the same caller-held
// `upperId` ceiling, and following it verbatim cannot escape the cap.
// Real local D1 executes every read; no upstream is allowed.
const TEST_ENV = env as unknown as Env;
const TOKEN = "test-read-token";
const ORIGIN = "https://snapshot-upper-id-link.test.invalid";

const RESOURCES = [
  { name: "customer", path: "/api/v1/customer-snapshot", id: "customer_id" },
  { name: "address", path: "/api/v1/address-snapshot", id: "pickup_address_id" },
  { name: "container", path: "/api/v1/container-snapshot", id: "container_id" }
] as const;
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };

async function seed(id: number) {
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, ?, 1, 'synthetic')")
      .bind(id, `synthetic-co-${id}`),
    db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, address, enabled, synced_at) VALUES (?, ?, ?, 1, 'synthetic')")
      .bind(id, id, `synthetic-addr-${id}`),
    db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, location_address, serial_number, enabled, synced_at) VALUES (?, ?, ?, ?, 1, 'synthetic')")
      .bind(id, id, `synthetic-loc-${id}`, `synthetic-serial-${id}`)
  ]);
}

async function get(url: URL) {
  const response = await app.fetch(
    new Request(url, { headers: { authorization: `Bearer ${TOKEN}` } }),
    TEST_ENV
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as Body;
  return { response, body };
}

function nextTarget(response: Response, current: URL): URL {
  const link = response.headers.get("link");
  expect(link).toMatch(/^<\/api\/v1\/(?:customer|address|container)-snapshot\?[^<>\s]*>; rel="next"$/);
  const target = new URL(/^<([^>]+)>; rel="next"$/.exec(link!)![1], current);
  expect(target.origin).toBe(current.origin);
  expect(target.searchParams.has("offset")).toBe(false);
  return target;
}

beforeAll(async () => {
  await ensureD1TestTables();
});

beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected outbound fetch in upperId/Link composition test"); }));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
  for (let id = 1; id <= 6; id++) await seed(id);
});

afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(RESOURCES)("$name snapshot: upperId survives Link continuations", (resource) => {
  const ids = (body: Body) => body.rows.map((r) => r[resource.id]);

  it("preserves the caller-held cap in the next target and following it stays capped", async () => {
    const firstUrl = new URL(`${resource.path}?upperId=4&limit=2`, ORIGIN);
    const first = await get(firstUrl);
    expect(ids(first.body)).toEqual([1, 2]);
    expect(first.body.total).toBe(4);
    expect(first.body.nextCursor).toBe(2);

    const target = nextTarget(first.response, firstUrl);
    expect(target.pathname).toBe(resource.path);
    expect(target.searchParams.get("upperId")).toBe("4");
    expect(target.searchParams.get("cursor")).toBe("2");
    expect(target.searchParams.get("limit")).toBe("2");

    // A higher-ID arrival between pages must not leak into the traversal,
    // even when the caller follows the server's link verbatim.
    await seed(7);
    const followed = await get(target);
    expect(ids(followed.body)).toEqual([3, 4]);
    expect(followed.body.total).toBe(2);
    expect(followed.body.nextCursor).toBe(4);

    const terminal = nextTarget(followed.response, target);
    expect(terminal.searchParams.get("upperId")).toBe("4");
    expect(terminal.searchParams.get("cursor")).toBe("4");
    const last = await get(terminal);
    expect(ids(last.body)).toEqual([]);
    expect(last.body.total).toBe(0);
    expect(last.body.nextCursor).toBeNull();
    expect(last.response.headers.get("link")).toBeNull();
  });

  it("omits upperId from the next target when the caller sent none", async () => {
    const firstUrl = new URL(`${resource.path}?limit=2`, ORIGIN);
    const first = await get(firstUrl);
    expect(ids(first.body)).toEqual([1, 2]);
    const target = nextTarget(first.response, firstUrl);
    expect(target.searchParams.has("upperId")).toBe(false);
    expect(target.searchParams.get("cursor")).toBe("2");
  });
});

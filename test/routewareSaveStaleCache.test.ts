import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { env, exports } from "cloudflare:workers";
import { ensureD1TestTables } from "./d1TestMigrations";

// Matches wrangler.toml [env.test.vars]. The sync secret passes both gates:
// the outer /api/v1/* gate accepts it as a fallback, and the /data/* reads
// require it — same pattern as test/snapshotSyncE2E.test.ts. (A gitignored
// local .dev.vars may override SHADOW_API_TOKEN, so the API token is not a
// stable test credential here.)
const SYNC_SECRET = "test-sync-secret";

/**
 * TOG-6463 — the routeware-tier save routes used to forward upstream and
 * return, so a successful save (including the documented `Enabled=false`
 * disable flow) stayed invisible to shadow reads until the next cron sync:
 * D1 kept the pre-save row and `GET /api/v1/data/*` kept serving the cached
 * pre-save bundle.
 *
 * Each test below walks the issue's repro end to end against the real routes,
 * the real test D1, and the real Workers cache: seed D1, warm the cached
 * read, POST the routeware-tier save with stubbed upstream, then re-read.
 * Two assertions discriminate the fix:
 *
 * - the save triggers a `GetCustomerDetailFull` fetch (the probe in the issue:
 *   pre-fix this count was 0), and
 * - the re-read serves the post-save record, not the pre-save one.
 *
 * Upstream is stubbed at `globalThis.fetch` (save URLs → success JSON,
 * detail-full → the post-save payload) and fails loudly on anything else, so
 * no test can reach `killeen.routeware.com`. The explicit
 * `__RequestVerificationToken` skips the anti-forgery modal fetch; that path
 * is covered elsewhere.
 */

async function call(path: string, init: RequestInit = {}, token: string = SYNC_SECRET): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return exports.default.fetch(`http://test.local${path}`, { ...init, headers });
}

function db(): D1Database {
  return (env as unknown as { CUSTOMER_DB: D1Database }).CUSTOMER_DB;
}

function detailPayload(customerId: number, companyName: string, enabled: boolean): unknown {
  return {
    currentCustomer: { CustomerID: customerId, CompanyName: companyName, Enabled: enabled },
    data: []
  };
}

const detailFullCalls: number[] = [];
const behavior = { saveBody: '{"success":true}' };

type CustomerRead = { customer: { company_name: string; enabled: number } };

describe("routeware-tier saves refresh D1 + cache (TOG-6463)", () => {
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    await ensureD1TestTables();
  });

  beforeEach(() => {
    detailFullCalls.length = 0;
    behavior.saveBody = '{"success":true}';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (
        url.includes("/WebRW/Customer/SaveCustomerLongForm") ||
        url.includes("/WebRW/PickupAddress/SaveAddressForm") ||
        url.includes("/WebRW/Container/SaveContainerForm")
      ) {
        return new Response(behavior.saveBody, {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.includes("/WebRW/Customer/GetCustomerDetailFull")) {
        const raw = new TextDecoder().decode((init?.body as ArrayBuffer | undefined) ?? new ArrayBuffer(0));
        const { customerID } = JSON.parse(raw) as { customerID: number };
        detailFullCalls.push(customerID);
        const payload =
          customerID === 42
            ? detailPayload(42, "Acme", false)
            : detailPayload(customerID, `Refreshed-${customerID}`, true);
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error(`Unexpected upstream fetch in test: ${url}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("customer disable via save-long-form is visible to shadow reads", async () => {
    // Arrange — seed an enabled customer and warm the cached read.
    const now = new Date().toISOString();
    await db()
      .prepare(
        "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (42, 'Acme', 1, ?)"
      )
      .bind(now)
      .run();
    const warm = await call("/api/v1/data/customer?id=42", {}, SYNC_SECRET);
    expect(warm.status).toBe(200);
    expect(((await warm.json()) as CustomerRead).customer.enabled).toBe(1);

    // Act — the documented disable flow: save-long-form with Enabled=false.
    const save = await call("/api/v1/routeware/customer/save-long-form", {
      method: "POST",
      body: "CustomerID=42&CompanyName=Acme&Enabled=false&__RequestVerificationToken=client-token",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }
    });

    // Assert — the upstream 200 passes through untouched, D1 was refreshed
    // from GetCustomerDetailFull, and the re-read serves the disabled record.
    expect(save.status).toBe(200);
    expect(await save.text()).toBe('{"success":true}');
    expect(detailFullCalls).toEqual([42]);
    const reread = await call("/api/v1/data/customer?id=42", {}, SYNC_SECRET);
    expect(reread.status).toBe(200);
    expect(((await reread.json()) as CustomerRead).customer.enabled).toBe(0);
  });

  it("address save refreshes the owning customer for shadow reads", async () => {
    // Arrange
    const now = new Date().toISOString();
    await db()
      .prepare(
        "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (5, 'Pre', 1, ?)"
      )
      .bind(now)
      .run();
    const warm = await call("/api/v1/data/customer?id=5", {}, SYNC_SECRET);
    expect(warm.status).toBe(200);
    expect(((await warm.json()) as CustomerRead).customer.company_name).toBe("Pre");

    // Act
    const save = await call("/api/v1/routeware/address/save-address-form", {
      method: "POST",
      body: "CustomerID=5&PickupAddressID=10&Address=1+Main+St&__RequestVerificationToken=client-token",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }
    });

    // Assert
    expect(save.status).toBe(200);
    expect(detailFullCalls).toEqual([5]);
    const reread = await call("/api/v1/data/customer?id=5", {}, SYNC_SECRET);
    expect(reread.status).toBe(200);
    expect(((await reread.json()) as CustomerRead).customer.company_name).toBe("Refreshed-5");
  });

  it("container save resolves the owner from D1 and refreshes it", async () => {
    // Arrange — the container form posts only PickupAddressID; the owner comes
    // from the address snapshot (same fallback as handlePostDataContainer).
    const now = new Date().toISOString();
    await db()
      .prepare(
        "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (7, 'Pre', 1, ?)"
      )
      .bind(now)
      .run();
    await db()
      .prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, synced_at) VALUES (70, 7, ?)")
      .bind(now)
      .run();
    const warm = await call("/api/v1/data/customer?id=7", {}, SYNC_SECRET);
    expect(warm.status).toBe(200);
    expect(((await warm.json()) as CustomerRead).customer.company_name).toBe("Pre");

    // Act — no CustomerID in the form.
    const save = await call("/api/v1/routeware/container/save-container-form", {
      method: "POST",
      body: "ContainerID=0&PickupAddressID=70&__RequestVerificationToken=client-token",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }
    });

    // Assert
    expect(save.status).toBe(200);
    expect(detailFullCalls).toEqual([7]);
    const reread = await call("/api/v1/data/customer?id=7", {}, SYNC_SECRET);
    expect(reread.status).toBe(200);
    expect(((await reread.json()) as CustomerRead).customer.company_name).toBe("Refreshed-7");
  });
});

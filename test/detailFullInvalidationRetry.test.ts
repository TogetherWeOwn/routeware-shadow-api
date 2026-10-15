import { afterEach, describe, expect, it, vi } from "vitest";

const realConsoleError = console.error;

afterEach(() => {
  console.error = realConsoleError;
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("detail-full retry budget with real graph invalidation", () => {
  it("evicts all 400 graph ids after one transient cache-delete failure", async () => {
    // One customer + 199 addresses + 200 containers fits two complete passes.
    // The real helper must not count the initial pass twice and suppress retry.
    const addressIds = Array.from({ length: 199 }, (_, i) => 1000 + i);
    const containerIds = Array.from({ length: 200 }, (_, i) => 2000 + i);
    const staleEntries = new Set([
      "https://routeware-shadow-entity/v1/customer/5",
      ...addressIds.map((id) => `https://routeware-shadow-entity/v1/address/${id}`),
      ...containerIds.map((id) => `https://routeware-shadow-entity/v1/container/${id}`)
    ]);
    const failedKey = "https://routeware-shadow-entity/v1/address/1098";
    const deletes: string[] = [];
    let failedOnce = false;

    // entityDataCache captures caches.default on import. Only the external
    // Cache API is replaced; both budget calculation and retry run for real.
    vi.resetModules();
    vi.stubGlobal("caches", {
      default: {
        async delete(request: Request): Promise<boolean> {
          deletes.push(request.url);
          if (request.url === failedKey && !failedOnce) {
            failedOnce = true;
            throw new Error("synthetic transient cache failure");
          }
          return staleEntries.delete(request.url);
        }
      }
    });
    console.error = () => {};
    const { detailFullInvalidateAttempts } = await import("../src/lib/detailFullSync");
    const { invalidateCustomerGraphWithRetry } = await import("../src/lib/entityDataCache");

    expect(staleEntries.size).toBe(400);
    await expect(
      invalidateCustomerGraphWithRetry(
        { customerId: 5, addressIds, containerIds },
        detailFullInvalidateAttempts(addressIds.length, containerIds.length)
      )
    ).resolves.toBeUndefined();

    expect(failedOnce).toBe(true);
    expect(deletes.filter((url) => url === failedKey)).toHaveLength(2);
    expect(staleEntries.size).toBe(0);
    expect(deletes.length).toBeLessThanOrEqual(950);
  });
});

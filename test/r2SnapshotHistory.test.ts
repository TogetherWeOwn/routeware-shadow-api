import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { stringToUint8Stream } from "../src/lib/csvStream";
import {
  archiveReportCsvToR2AfterD1,
  sha256HexBytes,
  snapshotR2HistoryObjectKey,
  snapshotR2LatestObjectKey,
  type R2ArchiveDetail,
  type SnapshotManifest
} from "../src/lib/r2SnapshotArchive";
import { syncCustomerSnapshotFromStream } from "../src/lib/snapshot/streamSync";
import { ensureD1TestTables } from "./d1TestMigrations";

const frozen = new Date("2026-10-08T12:34:56.789Z");
const firstCsv = "CustomerID,CompanyName,Enabled\n901,Example One,true\n";
const secondCsv = "CustomerID,CompanyName,Enabled\n901,Example Two,true\n";
const testEnv = env as unknown as Env;

afterEach(() => vi.useRealTimers());

beforeAll(async () => {
  await ensureD1TestTables();
});

describe("timestamped R2 history", () => {
  it("keeps both same-millisecond D1 syncs and advances only the stable pointers", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(frozen);
    const details: R2ArchiveDetail[] = [];
    for (const csv of [firstCsv, secondCsv]) {
      const result = await archiveReportCsvToR2AfterD1(
        testEnv, "customer", stringToUint8Stream(csv),
        (stream) => syncCustomerSnapshotFromStream(testEnv.CUSTOMER_DB, stream),
        (detail) => details.push(detail)
      );
      expect(result.upserted).toBe(1);
    }
    const keys = details.map((detail) => detail.key!);
    expect(details.map((detail) => detail.status)).toEqual(["stored", "stored"]);
    expect(details.every((detail) => detail.reason === undefined)).toBe(true);
    expect(new Set(keys).size).toBe(2);
    const listing = await testEnv.SNAPSHOTS.list({ prefix: "snapshot-history/2026-10-08/" });
    const listedKeys = new Set(listing.objects.map((object) => object.key));
    expect(keys.every((key) => listedKeys.has(key))).toBe(true);
    for (const [i, key] of keys.entries()) {
      expect(key).toMatch(/^snapshot-history\/2026-10-08\/2026-10-08T12-34-56-789Z-[0-9a-f-]{36}\/customer\.csv$/);
      const csv = [firstCsv, secondCsv][i];
      expect(await (await testEnv.SNAPSHOTS.get(key))!.text()).toBe(csv);
      const manifest = await (await testEnv.SNAPSHOTS.get(`${key}.manifest.json`))!
        .json<SnapshotManifest>();
      expect(manifest.files["customer.csv"]).toEqual({
        key, sha256: await sha256HexBytes(new TextEncoder().encode(csv)),
        bytes: new TextEncoder().encode(csv).byteLength
      });
    }
    const latest = await (await testEnv.SNAPSHOTS.get(snapshotR2LatestObjectKey("customer")))!
      .json<SnapshotManifest>();
    expect(latest.files["customer.csv"].key).toBe(keys[1]);
    expect(await (await testEnv.SNAPSHOTS.get("snapshots/2026-10-08/customer.csv"))!.text())
      .toBe(secondCsv);
    const daily = await (await testEnv.SNAPSHOTS.get("snapshots/2026-10-08.manifest.json"))!
      .json<SnapshotManifest>();
    expect(daily.files["customer.csv"].key).toBe("snapshots/2026-10-08/customer.csv");
    expect(daily.files["customer.csv"].sha256).toBe(latest.files["customer.csv"].sha256);
  });

  it("uses UTC even when the caller's time has an offset", () => {
    expect(snapshotR2HistoryObjectKey("address", new Date("2026-10-09T01:00:00+02:00")))
      .toMatch(/^snapshot-history\/2026-10-08\/2026-10-08T23-00-00-000Z-[0-9a-f-]{36}\/address\.csv$/);
  });

  it("keeps one UTC date when D1 finishes after midnight", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T23:59:59.999Z"));
    const writes: string[] = [];
    const bucket = {
      async get() { return null; },
      async put(key: string) { writes.push(key); return {} as R2Object; }
    } as unknown as R2Bucket;
    await archiveReportCsvToR2AfterD1(
      { SNAPSHOTS: bucket } as Env, "customer", stringToUint8Stream(firstCsv),
      async () => { vi.setSystemTime(new Date("2026-10-09T00:00:01Z")); return "ok"; }
    );
    expect(writes[0]).toContain("snapshot-history/2026-10-08/2026-10-08T23-59-59-999Z-");
    expect(writes[1]).toBe("snapshots/2026-10-08/customer.csv");
    expect(writes[2]).toBe(`${writes[0]}.manifest.json`);
    expect(writes[3]).toBe("snapshots/2026-10-08.manifest.json");
    expect(writes[4]).toBe("snapshot-latest/customer.json");
  });

  // [stage, status, reason]: either CSV copy failing is a failed archive (the
  // daily alias is what the date restore route serves); a sidecar or pointer
  // failing leaves both CSVs in place and is reported as `stored` plus a reason
  // that names the stage.
  it.each([
    ["history", "failed", "R2 publication unavailable"],
    ["daily alias", "failed", "daily alias: R2 publication unavailable"],
    ["history manifest", "stored", "manifest: history manifest: R2 publication unavailable"],
    ["daily manifest", "stored", "manifest: daily manifest: R2 publication unavailable"],
    ["latest pointer", "stored", "manifest: latest pointer: R2 publication unavailable"]
  ] as const)(
    "preserves the D1 result and reports the %s failure without advancing latest",
    async (stage, status, reason) => {
      const stages = ["history", "daily alias", "history manifest", "daily manifest", "latest pointer"];
      const failAt = stages.indexOf(stage);
      const writes: string[] = [];
      const bucket = {
        async get() { return null; },
        async put(key: string) {
          if (writes.length === failAt) throw new Error("R2 publication unavailable");
          writes.push(key);
          return {} as R2Object;
        }
      } as unknown as R2Bucket;
      const details: R2ArchiveDetail[] = [];
      const result = await archiveReportCsvToR2AfterD1(
        { SNAPSHOTS: bucket } as Env, "customer", stringToUint8Stream(firstCsv),
        async () => "D1 success", (detail) => details.push(detail)
      );
      expect(result).toBe("D1 success");
      expect(writes).toHaveLength(failAt);
      expect(writes).not.toContain("snapshot-latest/customer.json");
      expect(details).toHaveLength(1);
      expect(details[0].status).toBe(status);
      expect(details[0].reason).toBe(reason);
      expect(details[0].key).toMatch(/^snapshot-history\//);
    }
  );

  it("keeps latest and the daily manifest on run 1 when run 2's daily alias write fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T01:02:03.004Z"));
    const sync = (stream: ReadableStream<Uint8Array>) =>
      syncCustomerSnapshotFromStream(testEnv.CUSTOMER_DB, stream);
    const details: R2ArchiveDetail[] = [];
    await archiveReportCsvToR2AfterD1(
      testEnv, "customer", stringToUint8Stream(firstCsv), sync, (d) => details.push(d)
    );
    // Same bucket, but the date alias write is refused on the second run.
    const real = testEnv.SNAPSHOTS;
    const flaky = {
      get: (key: string) => real.get(key),
      put: (key: string, value: Parameters<R2Bucket["put"]>[1], options?: R2PutOptions) => {
        if (key === "snapshots/2026-10-09/customer.csv") {
          return Promise.reject(new Error("alias put unavailable"));
        }
        return real.put(key, value, options);
      }
    } as unknown as R2Bucket;
    await archiveReportCsvToR2AfterD1(
      { ...testEnv, SNAPSHOTS: flaky } as Env, "customer", stringToUint8Stream(secondCsv), sync,
      (d) => details.push(d)
    );

    expect(details.map((d) => d.status)).toEqual(["stored", "failed"]);
    expect(details[1].reason).toBe("daily alias: alias put unavailable");
    // Run 2's history CSV landed (recoverable), but nothing points at it yet.
    expect(await (await real.get(details[1].key!))!.text()).toBe(secondCsv);
    expect(await real.get(`${details[1].key!}.manifest.json`)).toBeNull();
    expect(await (await real.get("snapshots/2026-10-09/customer.csv"))!.text()).toBe(firstCsv);
    const latest = await (await real.get(snapshotR2LatestObjectKey("customer")))!
      .json<SnapshotManifest>();
    expect(latest.files["customer.csv"].key).toBe(details[0].key);
    const daily = await (await real.get("snapshots/2026-10-09.manifest.json"))!
      .json<SnapshotManifest>();
    expect(daily.files["customer.csv"].sha256).toBe(
      await sha256HexBytes(new TextEncoder().encode(firstCsv))
    );
  });
});

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
    expect(writes[2]).toBe("snapshots/2026-10-08/customer.csv");
    expect(writes[3]).toBe("snapshots/2026-10-08.manifest.json");
  });

  it.each(["history", "history manifest", "daily alias", "daily manifest", "latest"])(
    "preserves the D1 result and leaves latest unchanged when %s fails",
    async (stage) => {
      const writes: string[] = [];
      const failAt = ["history", "history manifest", "daily alias", "daily manifest", "latest"].indexOf(stage);
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
      expect(details[0].status).toBe(failAt === 0 ? "failed" : "stored");
      expect(details[0].reason).toContain("R2 publication unavailable");
    }
  );
});

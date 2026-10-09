import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  archiveReportCsvToR2AfterD1,
  csvBasename,
  isSnapshotManifest,
  renderSnapshotManifest,
  sha256HexBytes,
  snapshotR2ManifestObjectKey,
  updateSnapshotManifest,
  type SnapshotArchiveTable,
  type SnapshotManifest,
} from "../src/lib/r2SnapshotArchive";

/**
 * R2 archive integrity manifest (TOG-8881, gap R3-06).
 *
 * After a successful D1 sync the archiver writes the CSV and upserts one
 * entry (`{key, sha256, bytes}`) into the date's sidecar
 * `snapshots/YYYY-MM-DD.manifest.json`. What this pins:
 *
 * 1. The manifest entry's hash matches the exact CSV bytes stored at the key.
 * 2. A second table archived the same date merges (read-modify-write keeps
 *    both entries); the key lives next to the date dir, not inside it.
 * 3. A failed CSV put writes no manifest (a hash for bytes that never
 *    landed would make the manifest a lie); D1's result still returns.
 * 4. A corrupt existing sidecar is replaced, not merged — one bad manifest
 *    cannot wedge future archives.
 * 5. Pure helpers: deterministic render, manifest guard, basename/key shape.
 *
 * Fixture bytes are synthetic (`ExampleCo`); no customer PII.
 */

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function toBytes(value: unknown): Uint8Array {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    const v = value as Uint8Array;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  throw new Error(`unsupported put value: ${typeof value}`);
}

/** In-memory R2 double: `put` stores bytes, `get` returns `{ text() }`. */
function createMapBucket(initial: Record<string, string> = {}) {
  const store = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(initial)) store.set(k, toBytes(v));
  const putKeys: string[] = [];
  const bucket = {
    async put(key: string, value: unknown) {
      putKeys.push(key);
      store.set(key, toBytes(value));
      return {} as R2Object;
    },
    async get(key: string) {
      const bytes = store.get(key);
      if (!bytes) return null;
      const text = new TextDecoder().decode(bytes);
      return { text: async () => text } as unknown as R2Object;
    },
    async createMultipartUpload() {
      throw new Error("multipart unexpected in manifest tests");
    },
  } as unknown as R2Bucket;
  return { bucket, store, putKeys };
}

const warned: Array<Record<string, unknown>> = [];
const realWarn = console.warn;
const logged: Array<Record<string, unknown>> = [];
const realInfo = console.info;
const errored: Array<Record<string, unknown>> = [];
const realError = console.error;

beforeEach(() => {
  warned.length = 0;
  logged.length = 0;
  errored.length = 0;
  console.warn = (...args: unknown[]) => {
    warned.push(args[0] as Record<string, unknown>);
  };
  console.info = (...args: unknown[]) => {
    logged.push(args[0] as Record<string, unknown>);
  };
  console.error = (...args: unknown[]) => {
    errored.push(args[0] as Record<string, unknown>);
  };
});

afterEach(() => {
  console.warn = realWarn;
  console.info = realInfo;
  console.error = realError;
});

function enabledEnv(bucket: R2Bucket): Env {
  return { SNAPSHOTS: bucket } as unknown as Env;
}

async function archive(table: SnapshotArchiveTable, csv: string, bucket: R2Bucket) {
  return archiveReportCsvToR2AfterD1(enabledEnv(bucket), table, streamFromText(csv), async () => ({
    upserted: 1,
  }));
}

describe("snapshot manifest sidecar", () => {
  it("writes the CSV and a manifest whose entry hashes the exact stored bytes", async () => {
    // Arrange
    const { bucket, store } = createMapBucket();
    const csv = "CustomerID,Name\n1,ExampleCo\n";

    // Act
    await archive("customer", csv, bucket);

    // Assert — CSV landed verbatim; the manifest entry pins its sha256 + size.
    const today = new Date().toISOString().slice(0, 10);
    const csvKey = `snapshots/${today}/customer.csv`;
    expect(new TextDecoder().decode(store.get(csvKey))).toBe(csv);
    const manifestKey = `snapshots/${today}.manifest.json`;
    const parsed = JSON.parse(new TextDecoder().decode(store.get(manifestKey)!)) as SnapshotManifest;
    expect(isSnapshotManifest(parsed)).toBe(true);
    expect(parsed.files["customer.csv"]).toEqual({
      key: csvKey,
      sha256: await sha256HexBytes(new TextEncoder().encode(csv)),
      bytes: new TextEncoder().encode(csv).byteLength,
    });
    expect(logged).toContainEqual(
      expect.objectContaining({
        level: "info",
        msg: "R2 snapshot manifest updated",
        route: "snapshot.r2.manifest",
        manifestKey,
      })
    );
  });

  it("merges a second same-date table into the existing manifest", async () => {
    // Arrange
    const { bucket, store } = createMapBucket();

    // Act — customer then address, the way the sequential syncs run.
    await archive("customer", "CustomerID\n1\n", bucket);
    await archive("address", "PickupAddressID\n9\n", bucket);

    // Assert — one manifest, both entries, each hash matching its CSV.
    const today = new Date().toISOString().slice(0, 10);
    const parsed = JSON.parse(
      new TextDecoder().decode(store.get(`snapshots/${today}.manifest.json`)!)
    ) as SnapshotManifest;
    expect(isSnapshotManifest(parsed)).toBe(true);
    expect(Object.keys(parsed.files).sort()).toEqual(["address.csv", "customer.csv"]);
    for (const name of ["address.csv", "customer.csv"]) {
      const entry = parsed.files[name];
      const csvBytes = store.get(entry.key)!;
      expect(entry.sha256).toBe(await sha256HexBytes(csvBytes));
      expect(entry.bytes).toBe(csvBytes.byteLength);
    }
  });

  it("writes no manifest when the CSV put fails — D1 result still returned", async () => {
    // Arrange — R2 throws on every put; D1 already succeeded.
    const failing = {
      async put() {
        throw new Error("R2 boom");
      },
      async get() {
        return null;
      },
      async createMultipartUpload() {
        throw new Error("R2 boom");
      },
    } as unknown as R2Bucket;

    // Act
    const result = await archive("container", "ContainerID\n5\n", failing);

    // Assert — caller sees the D1 result; both failures are logged errors.
    expect(result).toEqual({ upserted: 1 });
    expect(errored).toContainEqual(
      expect.objectContaining({
        level: "error",
        msg: "R2 snapshot put failed",
        route: "snapshot.r2.archive",
        key: expect.stringMatching(/^snapshots\/\d{4}-\d{2}-\d{2}\/container\.csv$/),
      })
    );
    expect(errored.some((e) => e.route === "snapshot.r2.manifest")).toBe(false);
  });

  it("replaces a corrupt existing manifest instead of merging into it", async () => {
    // Arrange — a sidecar that is not JSON at all.
    const { bucket, store } = createMapBucket();
    const today = new Date().toISOString().slice(0, 10);
    const manifestKey = `snapshots/${today}.manifest.json`;
    store.set(manifestKey, new TextEncoder().encode("{oops"));

    // Act
    await archive("customer", "CustomerID\n1\n", bucket);

    // Assert — warned, replaced, and the new manifest carries only the table
    // just archived (verify then reports the others as missing, loudly).
    expect(warned).toContainEqual(
      expect.objectContaining({
        level: "warn",
        msg: "R2 snapshot manifest is not JSON; replacing",
        route: "snapshot.r2.manifest",
        manifestKey,
      })
    );
    const parsed = JSON.parse(new TextDecoder().decode(store.get(manifestKey)!)) as SnapshotManifest;
    expect(isSnapshotManifest(parsed)).toBe(true);
    expect(Object.keys(parsed.files)).toEqual(["customer.csv"]);
  });

  it("replaces a well-formed but invalid manifest (wrong entry shape)", async () => {
    // Arrange
    const { bucket, store } = createMapBucket();
    const today = new Date().toISOString().slice(0, 10);
    const manifestKey = `snapshots/${today}.manifest.json`;
    store.set(
      manifestKey,
      new TextEncoder().encode(JSON.stringify({ version: 1, date: today, files: { "x.csv": 42 } }))
    );

    // Act
    await updateSnapshotManifest(bucket, manifestKey, {
      "customer.csv": { key: `snapshots/${today}/customer.csv`, sha256: "a".repeat(64), bytes: 3 },
    });

    // Assert
    expect(warned).toContainEqual(
      expect.objectContaining({
        level: "warn",
        msg: "R2 snapshot manifest failed validation; replacing",
        route: "snapshot.r2.manifest",
        manifestKey,
      })
    );
    const parsed = JSON.parse(new TextDecoder().decode(store.get(manifestKey)!)) as SnapshotManifest;
    expect(isSnapshotManifest(parsed)).toBe(true);
    expect(Object.keys(parsed.files)).toEqual(["customer.csv"]);
  });
});

describe("manifest pure helpers", () => {
  it("renders deterministically (sorted keys, trailing newline)", () => {
    const text = renderSnapshotManifest({
      version: 1,
      date: "2026-09-28",
      files: {
        "customer.csv": { key: "snapshots/2026-09-28/customer.csv", sha256: "b".repeat(64), bytes: 2 },
        "address.csv": { key: "snapshots/2026-09-28/address.csv", sha256: "a".repeat(64), bytes: 1 },
      },
    });
    expect(text.endsWith("\n")).toBe(true);
    expect(text.indexOf("address.csv")).toBeLessThan(text.indexOf("customer.csv"));
    expect(isSnapshotManifest(JSON.parse(text))).toBe(true);
  });

  it("guards the manifest shape (version, date, entry fields)", () => {
    const good = {
      version: 1,
      date: "2026-09-28",
      files: { "customer.csv": { key: "k", sha256: "c".repeat(64), bytes: 0 } },
    };
    expect(isSnapshotManifest(good)).toBe(true);
    expect(isSnapshotManifest({ ...good, version: 2 })).toBe(false);
    expect(isSnapshotManifest({ ...good, date: "28/09/2026" })).toBe(false);
    expect(isSnapshotManifest({ ...good, files: null })).toBe(false);
    expect(
      isSnapshotManifest({ ...good, files: { "c.csv": { key: "k", sha256: "short", bytes: 1 } } })
    ).toBe(false);
    expect(isSnapshotManifest(null)).toBe(false);
  });

  it("sha256 helper matches the known empty-string vector", async () => {
    expect(await sha256HexBytes(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("key helpers keep the manifest next to the date dir, not inside it", () => {
    expect(csvBasename("address")).toBe("address.csv");
    expect(snapshotR2ManifestObjectKey(new Date("2026-09-28T12:00:00.000Z"))).toBe(
      "snapshots/2026-09-28.manifest.json"
    );
  });
});

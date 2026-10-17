import { describe, expect, it } from "vitest";

import { stringToUint8Stream } from "../src/lib/csvStream";
import {
  InvalidSnapshotCsvError,
  syncAddressSnapshotFromCsvText,
  syncAddressSnapshotFromStream,
  syncContainerSnapshotFromCsvText,
  syncContainerSnapshotFromStream,
  syncCustomerSnapshotFromCsvText,
  syncCustomerSnapshotFromStream
} from "../src/lib/snapshot/streamSync";
import { mapSnapshotImportError } from "../src/routes/snapshotImport";
import { recordingDb } from "./snapshotDbFake";

/**
 * `src/lib/snapshot/streamSync.ts` is the body of the daily cron: it streams a
 * Routeware CSV export straight into D1 and then, for a report *sync* (not a
 * partial import), deletes rows it did not see so upstream deletions propagate.
 *
 * That delete is the dangerous part. `options.reconcile && cols && dataRows > 0`
 * is the only thing standing between a bad or empty export and a wiped snapshot
 * table — an empty export must leave the existing rows alone rather than delete
 * all ~609k of them. Each guard clause is pinned below.
 *
 * The header check is the second risk: Routeware serves an HTML login page with
 * HTTP 200 when the session has lapsed, so "is this actually the CSV?" cannot be
 * inferred from the status code and must be asserted on the first line.
 *
 * The three exported sync functions are near-identical, and every property above
 * has to hold for all three — a guard present only on the customer path still
 * lets a bad address export wipe `address_snapshot`. So the behavioural tests
 * are a `describe.each` over one spec per table; only the header-error wording
 * is asserted separately, since that string is what tells an operator which
 * report path is misconfigured.
 */

const CUSTOMER_HEADER =
  "CustomerID,CustomerTypeID,CompanyName,FirstName,MiddleInitial,LastName,NameSuffix," +
  "CustomerNumber,SubCustomerNumber,Phone1,Phone2,Comments,Enabled";
const ADDRESS_HEADER =
  "PickupAddressID,CustomerID,RouteID,Address,City,State,Zip,FranchiseID,Comments," +
  "ExtrasAllowed,Enabled,DriverNote,Latitude,Longitude,Last_Audit_Date";
const CONTAINER_HEADER =
  "ContainerID,PickupAddressID,ContainerTypeID,SerialNumber,RFID,OnCall,EventCode,GPSLocked," +
  "Latitude,Longitude,Enabled,Address,City,State,Zip,ContainerNote";

function deletesIn(runs: Array<{ sql: string }>): string[] {
  return runs.map((r) => r.sql).filter((sql) => sql.startsWith("DELETE"));
}

type StreamSync = (
  db: D1Database,
  body: ReadableStream<Uint8Array>,
  batchSize?: number,
  options?: { reconcile?: boolean }
) => Promise<{ upserted: number; rowCount: number; deleted?: number }>;

type TextSync = (
  db: D1Database,
  csvText: string
) => Promise<{ upserted: number; rowCount: number }>;

type Spec = {
  name: string;
  sync: StreamSync;
  fromText: TextSync;
  table: string;
  header: string;
  /** Bindings per row, including the trailing `synced_at`. */
  ncols: number;
  /** A valid data row whose primary key is `id`. */
  row: (id: number) => string;
  /** A row that must fail to parse — its primary key is not an integer. */
  badRow: string;
};

const SPECS: Spec[] = [
  {
    name: "customer",
    sync: syncCustomerSnapshotFromStream,
    fromText: syncCustomerSnapshotFromCsvText,
    table: "customer_snapshot",
    header: CUSTOMER_HEADER,
    ncols: 14,
    row: (id) => `${id},,Co ${id},,,,,,,,,,true`,
    badRow: "not-an-id,,,,,,,,,,,,"
  },
  {
    name: "address",
    sync: syncAddressSnapshotFromStream,
    fromText: syncAddressSnapshotFromCsvText,
    table: "address_snapshot",
    header: ADDRESS_HEADER,
    ncols: 16,
    row: (id) => `${id},1,,${id} Main St,Killeen,TX,76541,,,false,true,,,,`,
    badRow: "not-an-id,1,,,,,,,,,,,,,"
  },
  {
    name: "container",
    sync: syncContainerSnapshotFromStream,
    fromText: syncContainerSnapshotFromCsvText,
    table: "container_snapshot",
    header: CONTAINER_HEADER,
    ncols: 29,
    row: (id) => `${id},10,,SN-${id},,false,,false,,,true,${id} Main St,Killeen,TX,76541,`,
    badRow: "not-an-id,10,,,,,,,,,,,,,,"
  }
];

function csvOf(spec: Spec, ids: number[]): string {
  return [spec.header, ...ids.map(spec.row)].join("\n");
}

describe("streamSync header validation", () => {
  it("rejects a body that is not the customer CSV", async () => {
    // Arrange — a lapsed session yields an HTML login page with status 200.
    const { db, batches } = recordingDb();
    const body = stringToUint8Stream("<!DOCTYPE html>\n<html><body>Sign in</body></html>");

    // Act
    const error = (await syncCustomerSnapshotFromStream(db, body).catch(
      (e: unknown) => e
    )) as Error;

    // Assert — and nothing was written.
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("Customer report is not valid CSV (missing CustomerID header)");
    expect((error as InvalidSnapshotCsvError).clientMessage).toBe(
      "Customer import body must start with a header row whose first column is CustomerID."
    );
    expect(batches).toEqual([]);
  });

  it("rejects an address CSV fed to the customer sync", async () => {
    // Arrange — swapped report paths must fail loudly, not import into the
    // wrong table.
    const { db } = recordingDb();

    // Act
    const error = (await syncCustomerSnapshotFromStream(
      db,
      stringToUint8Stream(ADDRESS_HEADER)
    ).catch((e: unknown) => e)) as Error;

    // Assert
    expect(error.message).toContain("missing CustomerID header");
  });

  it("names the address report in its own header error", async () => {
    // Arrange / Act
    const { db } = recordingDb();
    const error = (await syncAddressSnapshotFromStream(
      db,
      stringToUint8Stream(CUSTOMER_HEADER)
    ).catch((e: unknown) => e)) as Error;

    // Assert
    expect(error.message).toContain(
      "Address report is not valid CSV (missing PickupAddressID header)"
    );
    expect((error as InvalidSnapshotCsvError).clientMessage).toBe(
      "Address import body must start with a header row whose first column is PickupAddressID."
    );
  });

  it("names the container report in its own header error", async () => {
    // Arrange / Act
    const { db } = recordingDb();
    const error = (await syncContainerSnapshotFromStream(
      db,
      stringToUint8Stream(CONTAINER_HEADER.replace("ContainerID", "SomethingElse"))
    ).catch((e: unknown) => e)) as Error;

    // Assert
    expect(error.message).toContain(
      "Container report is not valid CSV (missing ContainerID header)"
    );
    expect((error as InvalidSnapshotCsvError).clientMessage).toBe(
      "Container import body must start with a header row whose first column is ContainerID."
    );
  });

  it("rejects a container CSV fed to the address sync", async () => {
    // Arrange — both reports start with an id column, so only the exact prefix
    // check distinguishes them.
    const { db, batches } = recordingDb();

    // Act
    const error = (await syncAddressSnapshotFromStream(
      db,
      stringToUint8Stream(CONTAINER_HEADER)
    ).catch((e: unknown) => e)) as Error;

    // Assert
    expect(error.message).toContain("missing PickupAddressID header");
    expect(batches).toEqual([]);
  });

  it("maps a wrong-header body to the customer 400 detail through the mapper", async () => {
    // Arrange
    const { db } = recordingDb();

    // Act
    const error = await syncCustomerSnapshotFromStream(
      db,
      stringToUint8Stream(ADDRESS_HEADER)
    ).catch((e: unknown) => e);
    const response = mapSnapshotImportError(
      "http://test.local/api/v1/customer-snapshot/import",
      error,
      () => false,
      (e) => e instanceof InvalidSnapshotCsvError
    );

    // Assert
    expect(response?.status).toBe(400);
    const body = (await response?.json()) as { detail: string };
    expect(body.detail).toBe(
      "Customer import body must start with a header row whose first column is CustomerID. See docs/PROBLEMS.md#bad-request."
    );
  });
});

describe.each(SPECS)("$name stream sync", (spec) => {
  describe("header handling", () => {
    it("accepts a header with leading whitespace and mixed case", async () => {
      // Arrange — the check lowercases and trims before comparing, because the
      // export's casing is not guaranteed.
      const { db } = recordingDb();
      const csv = ["  " + spec.header.toLowerCase(), spec.row(1)].join("\n");

      // Act
      const result = await spec.sync(db, stringToUint8Stream(csv));

      // Assert
      expect(result.rowCount).toBe(1);
    });

    it("accepts a fully quoted header", async () => {
      // Arrange — real exports quote headers (`"CustomerID",...`)
      // and the row parser already strips those quotes, so the guard must
      // read the parsed first cell rather than the raw line.
      const { db } = recordingDb();
      const quoted = spec.header
        .split(",")
        .map((h) => `"${h}"`)
        .join(",");
      const csv = [quoted, spec.row(1)].join("\n");

      // Act
      const result = await spec.sync(db, stringToUint8Stream(csv));

      // Assert
      expect(result.rowCount).toBe(1);
    });
  });

  describe("reconcile guard", () => {
    it("deletes rows not seen in this run when reconciling a non-empty report", async () => {
      // Arrange
      const { db, runs } = recordingDb({ changes: 12 });

      // Act
      const result = await spec.sync(db, stringToUint8Stream(csvOf(spec, [1, 2, 3])), 80, {
        reconcile: true
      });

      // Assert
      expect(deletesIn(runs)).toEqual([`DELETE FROM ${spec.table} WHERE synced_at < ?`]);
      expect(result).toEqual({ upserted: 3, rowCount: 3, deleted: 12 });
    });

    it("does not delete anything when the report has a header but no data rows", async () => {
      // Arrange — the guard that stops an empty or broken export from wiping the
      // table. Without it this run would delete every existing row.
      const { db, runs } = recordingDb({ changes: 999 });

      // Act
      const result = await spec.sync(db, stringToUint8Stream(spec.header), 80, {
        reconcile: true
      });

      // Assert
      expect(deletesIn(runs)).toEqual([]);
      expect(result).toEqual({ upserted: 0, rowCount: 0, deleted: 0 });
    });

    it("does not delete anything when every data row fails to parse", async () => {
      // Arrange — rows present but none usable is still an unusable export.
      const { db, runs } = recordingDb({ changes: 999 });
      const csv = [spec.header, spec.badRow, spec.badRow].join("\n");

      // Act
      const result = await spec.sync(db, stringToUint8Stream(csv), 80, { reconcile: true });

      // Assert
      expect(deletesIn(runs)).toEqual([]);
      expect(result.rowCount).toBe(0);
      expect(result.deleted).toBe(0);
    });

    it("does not delete anything when reconcile is not requested", async () => {
      // Arrange — a partial import must never remove rows it did not look at.
      const { db, runs } = recordingDb({ changes: 999 });

      // Act
      const result = await spec.sync(db, stringToUint8Stream(csvOf(spec, [1, 2, 3])));

      // Assert
      expect(deletesIn(runs)).toEqual([]);
      expect(result.deleted).toBe(0);
    });

    it("returns all-zero counts for a completely empty body", async () => {
      // Arrange
      const { db, batches, runs } = recordingDb({ changes: 999 });

      // Act
      const result = await spec.sync(db, stringToUint8Stream(""), 80, { reconcile: true });

      // Assert
      expect(result).toEqual({ upserted: 0, rowCount: 0, deleted: 0 });
      expect(batches).toEqual([]);
      expect(deletesIn(runs)).toEqual([]);
    });

    it("stamps every upsert and the reconcile delete with the same synced_at", async () => {
      // Arrange — if the delete used a later timestamp than the inserts, it
      // would delete the rows this very run just wrote.
      const { db, batches, runs } = recordingDb({ changes: 0 });

      // Act
      await spec.sync(db, stringToUint8Stream(csvOf(spec, [1, 2])), 80, { reconcile: true });

      // Assert
      const deleteBind = runs.find((r) => r.sql.startsWith("DELETE"))?.binds[0];
      const insertBinds = batches.flat().flatMap((s) => s.binds);
      const stamps = new Set(insertBinds.filter((_, i) => i % spec.ncols === spec.ncols - 1));
      expect(deleteBind).toBeTruthy();
      expect(stamps).toEqual(new Set([deleteBind]));
    });
  });

  describe("batching", () => {
    it("flushes mid-stream at batchSize and flushes the remainder at the end", async () => {
      // Arrange — 5 rows at a batch size of 2 means flushes after rows 2 and 4,
      // then a tail flush of 1. Losing the tail flush silently drops the last
      // partial batch of every import.
      const { db, batches } = recordingDb();

      // Act
      const result = await spec.sync(db, stringToUint8Stream(csvOf(spec, [1, 2, 3, 4, 5])), 2);

      // Assert
      expect(result).toEqual({ upserted: 5, rowCount: 5, deleted: 0 });
      const rowsPerBatch = batches.map((b) =>
        b.reduce((n, s) => n + s.binds.length / spec.ncols, 0)
      );
      expect(rowsPerBatch).toEqual([2, 2, 1]);
    });

    it("issues no tail flush when the row count divides evenly by batchSize", async () => {
      // Arrange — 4 rows at a batch size of 2 leaves `batch` empty at the end.
      const { db, batches } = recordingDb();

      // Act
      await spec.sync(db, stringToUint8Stream(csvOf(spec, [1, 2, 3, 4])), 2);

      // Assert
      expect(batches).toHaveLength(2);
    });

    it("counts only rows it could parse", async () => {
      // Arrange
      const { db } = recordingDb();
      const csv = [spec.header, spec.row(1), "oops", spec.row(2)].join("\n");

      // Act
      const result = await spec.sync(db, stringToUint8Stream(csv));

      // Assert
      expect(result.rowCount).toBe(2);
      expect(result.upserted).toBe(2);
    });

    it("preserves the ids and their order from the CSV", async () => {
      // Arrange — the primary key is the first binding of every row.
      const { db, batches } = recordingDb();

      // Act
      await spec.sync(db, stringToUint8Stream(csvOf(spec, [9, 4, 7])));

      // Assert
      const ids = batches
        .flat()
        .flatMap((s) => s.binds)
        .filter((_, i) => i % spec.ncols === 0);
      expect(ids).toEqual([9, 4, 7]);
    });
  });

  describe("fromCsvText wrapper", () => {
    it("wraps the text form and never reconciles", async () => {
      // Arrange — the text helper takes no options, so it must not delete.
      const { db, runs } = recordingDb({ changes: 999 });

      // Act
      const result = await spec.fromText(db, csvOf(spec, [1, 2]));

      // Assert
      expect(result.rowCount).toBe(2);
      expect(result.upserted).toBe(2);
      expect(deletesIn(runs)).toEqual([]);
    });
  });
});

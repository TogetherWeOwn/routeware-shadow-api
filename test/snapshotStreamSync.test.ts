import { describe, expect, it } from "vitest";

import { stringToUint8Stream } from "../src/lib/csvStream";
import {
  syncAddressSnapshotFromStream,
  syncContainerSnapshotFromStream,
  syncCustomerSnapshotFromCsvText,
  syncCustomerSnapshotFromStream
} from "../src/lib/snapshot/streamSync";
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
 */

const CUSTOMER_HEADER =
  "CustomerID,CustomerTypeID,CompanyName,FirstName,MiddleInitial,LastName,NameSuffix," +
  "CustomerNumber,SubCustomerNumber,Phone1,Phone2,Comments,Enabled";
const ADDRESS_HEADER =
  "PickupAddressID,CustomerID,RouteID,Address,City,State,Zip,FranchiseID,Comments," +
  "ExtrasAllowed,Enabled,DriverNote,Latitude,Longitude,Last_Audit_Date";
const CONTAINER_HEADER = "ContainerID,PickupAddressID,ContainerTypeID,SerialNumber,Enabled";

/** Bindings per customer row, including the trailing synced_at. */
const CUST_NCOLS = 14;

function customerCsv(ids: number[]): string {
  const rows = ids.map((id) => `${id},,Co ${id},,,,,,,,,,true`);
  return [CUSTOMER_HEADER, ...rows].join("\n");
}

function deletesIn(runs: Array<{ sql: string }>): string[] {
  return runs.map((r) => r.sql).filter((sql) => sql.startsWith("DELETE"));
}

describe("syncCustomerSnapshotFromStream header validation", () => {
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
  });

  it("accepts a header with leading whitespace and mixed case", async () => {
    // Arrange
    const { db } = recordingDb();
    const csv = ["  " + CUSTOMER_HEADER.toLowerCase(), "1,,Acme,,,,,,,,,,true"].join("\n");

    // Act
    const result = await syncCustomerSnapshotFromStream(db, stringToUint8Stream(csv));

    // Assert
    expect(result.rowCount).toBe(1);
  });
});

describe("syncCustomerSnapshotFromStream reconcile guard", () => {
  it("deletes rows not seen in this run when reconciling a non-empty report", async () => {
    // Arrange
    const { db, runs } = recordingDb({ changes: 12 });

    // Act
    const result = await syncCustomerSnapshotFromStream(
      db,
      stringToUint8Stream(customerCsv([1, 2, 3])),
      80,
      { reconcile: true }
    );

    // Assert
    expect(deletesIn(runs)).toEqual(["DELETE FROM customer_snapshot WHERE synced_at < ?"]);
    expect(result).toEqual({ upserted: 3, rowCount: 3, deleted: 12 });
  });

  it("does not delete anything when the report has a header but no data rows", async () => {
    // Arrange — the guard that stops an empty or broken export from wiping the
    // table. Without it this run would delete every existing row.
    const { db, runs } = recordingDb({ changes: 999 });

    // Act
    const result = await syncCustomerSnapshotFromStream(
      db,
      stringToUint8Stream(CUSTOMER_HEADER),
      80,
      { reconcile: true }
    );

    // Assert
    expect(deletesIn(runs)).toEqual([]);
    expect(result).toEqual({ upserted: 0, rowCount: 0, deleted: 0 });
  });

  it("does not delete anything when every data row fails to parse", async () => {
    // Arrange — rows present but none usable is still an unusable export.
    const { db, runs } = recordingDb({ changes: 999 });
    const csv = [CUSTOMER_HEADER, "not-an-id,,,,,,,,,,,,", "also-bad,,,,,,,,,,,,"].join("\n");

    // Act
    const result = await syncCustomerSnapshotFromStream(db, stringToUint8Stream(csv), 80, {
      reconcile: true
    });

    // Assert
    expect(deletesIn(runs)).toEqual([]);
    expect(result.rowCount).toBe(0);
    expect(result.deleted).toBe(0);
  });

  it("does not delete anything when reconcile is not requested", async () => {
    // Arrange — a partial import must never remove rows it did not look at.
    const { db, runs } = recordingDb({ changes: 999 });

    // Act
    const result = await syncCustomerSnapshotFromStream(
      db,
      stringToUint8Stream(customerCsv([1, 2, 3]))
    );

    // Assert
    expect(deletesIn(runs)).toEqual([]);
    expect(result.deleted).toBe(0);
  });

  it("returns all-zero counts for a completely empty body", async () => {
    // Arrange
    const { db, batches, runs } = recordingDb({ changes: 999 });

    // Act
    const result = await syncCustomerSnapshotFromStream(db, stringToUint8Stream(""), 80, {
      reconcile: true
    });

    // Assert
    expect(result).toEqual({ upserted: 0, rowCount: 0, deleted: 0 });
    expect(batches).toEqual([]);
    expect(deletesIn(runs)).toEqual([]);
  });

  it("stamps every upsert and the reconcile delete with the same synced_at", async () => {
    // Arrange — if the delete used a later timestamp than the inserts, it would
    // delete the rows this very run just wrote.
    const { db, batches, runs } = recordingDb({ changes: 0 });

    // Act
    await syncCustomerSnapshotFromStream(db, stringToUint8Stream(customerCsv([1, 2])), 80, {
      reconcile: true
    });

    // Assert
    const deleteBind = runs.find((r) => r.sql.startsWith("DELETE"))?.binds[0];
    const insertBinds = batches.flat().flatMap((s) => s.binds);
    const stamps = new Set(insertBinds.filter((_, i) => i % CUST_NCOLS === CUST_NCOLS - 1));
    expect(deleteBind).toBeTruthy();
    expect(stamps).toEqual(new Set([deleteBind]));
  });
});

describe("syncCustomerSnapshotFromStream batching", () => {
  it("flushes mid-stream at batchSize and flushes the remainder at the end", async () => {
    // Arrange — 5 rows at a batch size of 2 means flushes after rows 2 and 4,
    // then a tail flush of 1.
    const { db, batches } = recordingDb();

    // Act
    const result = await syncCustomerSnapshotFromStream(
      db,
      stringToUint8Stream(customerCsv([1, 2, 3, 4, 5])),
      2
    );

    // Assert
    expect(result).toEqual({ upserted: 5, rowCount: 5, deleted: 0 });
    const rowsPerBatch = batches.map((b) =>
      b.reduce((n, s) => n + s.binds.length / CUST_NCOLS, 0)
    );
    expect(rowsPerBatch).toEqual([2, 2, 1]);
  });

  it("counts only rows it could parse", async () => {
    // Arrange
    const { db } = recordingDb();
    const csv = [CUSTOMER_HEADER, "1,,Acme,,,,,,,,,,true", "oops", "2,,Beta,,,,,,,,,,true"].join(
      "\n"
    );

    // Act
    const result = await syncCustomerSnapshotFromStream(db, stringToUint8Stream(csv));

    // Assert
    expect(result.rowCount).toBe(2);
    expect(result.upserted).toBe(2);
  });

  it("preserves the customer ids and order from the CSV", async () => {
    // Arrange
    const { db, batches } = recordingDb();

    // Act
    await syncCustomerSnapshotFromStream(db, stringToUint8Stream(customerCsv([9, 4, 7])));

    // Assert
    const ids = batches
      .flat()
      .flatMap((s) => s.binds)
      .filter((_, i) => i % CUST_NCOLS === 0);
    expect(ids).toEqual([9, 4, 7]);
  });
});

describe("syncCustomerSnapshotFromCsvText", () => {
  it("wraps the text form and never reconciles", async () => {
    // Arrange — the text helper takes no options, so it must not delete.
    const { db, runs } = recordingDb({ changes: 999 });

    // Act
    const result = await syncCustomerSnapshotFromCsvText(db, customerCsv([1, 2]));

    // Assert
    expect(result.rowCount).toBe(2);
    expect(result.upserted).toBe(2);
    expect(deletesIn(runs)).toEqual([]);
  });
});

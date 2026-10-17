import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { streamCsvLines, stringToUint8Stream } from "../src/lib/csvStream";
import { syncCustomerSnapshotFromStream } from "../src/lib/snapshot/streamSync";
import { ensureD1TestTables } from "./d1TestMigrations";
import { recordingDb } from "./snapshotDbFake";

/**
 * R2-07 CSV import dialect sweep (gap G12).
 *
 * Every CSV dialect edge an operator export can carry must map to either a
 * documented 400 or a correct import: BOM, CRLF, quoted commas, escaped
 * quotes, multiline / quoted-CRLF fields, bare CR, NUL bytes, 10k-row files,
 * and quote-scanner behavior across stream chunk boundaries.
 *
 * A stray unbalanced `"` mid-field is treated as a literal inch mark, so all
 * well-formed rows land (fixed by the quote-scanner change; see the
 * stray-quote tests below).
 *
 * Unit tests run against `recordingDb` (no D1); HTTP tests run through the
 * real app + real test D1 like test/snapshotImportEdges.test.ts.
 */

const CUSTOMER_HEADER =
  "CustomerID,CustomerTypeID,CompanyName,FirstName,MiddleInitial,LastName,NameSuffix," +
  "CustomerNumber,SubCustomerNumber,Phone1,Phone2,Comments,Enabled";
const ROW = (id: number, company = `Co ${id}`) =>
  `${id},,${company},,,,,,,,,,true`;

/** Emit the given strings as separate stream chunks, to control boundaries. */
function chunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
}

async function collectLines(s: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of streamCsvLines(s)) out.push(line);
  return out;
}

describe("CSV dialect sweep, stream level", () => {
  it("imports a BOM-prefixed file, header and row intact", async () => {
    // Arrange
    const { db, batches } = recordingDb();

    // Act
    const r = await syncCustomerSnapshotFromStream(
      db,
      stringToUint8Stream(`﻿${CUSTOMER_HEADER}\n${ROW(1)}`)
    );

    // Assert
    expect(r).toEqual({ upserted: 1, rowCount: 1, deleted: 0 });
    expect(batches.flat().flatMap((s) => s.binds)[2]).toBe("Co 1");
  });

  it("imports a CRLF file", async () => {
    // Arrange
    const { db } = recordingDb();

    // Act
    const r = await syncCustomerSnapshotFromStream(
      db,
      stringToUint8Stream(`${CUSTOMER_HEADER}\r\n${ROW(1)}\r\n`)
    );

    // Assert
    expect(r).toEqual({ upserted: 1, rowCount: 1, deleted: 0 });
  });

  it("imports a bare-CR file (trailing CR stripped by the field parser)", async () => {
    // Arrange
    const { db, batches } = recordingDb();

    // Act
    const r = await syncCustomerSnapshotFromStream(
      db,
      stringToUint8Stream(`${CUSTOMER_HEADER}\r${ROW(1)}\r`)
    );

    // Assert
    expect(r).toEqual({ upserted: 1, rowCount: 1, deleted: 0 });
    expect(batches.flat().flatMap((s) => s.binds)[2]).toBe("Co 1");
  });

  it("keeps a quoted comma inside the field", async () => {
    // Arrange
    const { db, batches } = recordingDb();

    // Act
    const r = await syncCustomerSnapshotFromStream(
      db,
      stringToUint8Stream(`${CUSTOMER_HEADER}\n${ROW(1, '"Acme, Inc."')}`)
    );

    // Assert
    expect(r).toEqual({ upserted: 1, rowCount: 1, deleted: 0 });
    expect(batches.flat().flatMap((s) => s.binds)[2]).toBe("Acme, Inc.");
  });

  it("unescapes doubled quotes combined with a comma", async () => {
    // Arrange
    const { db, batches } = recordingDb();

    // Act
    const r = await syncCustomerSnapshotFromStream(
      db,
      stringToUint8Stream(`${CUSTOMER_HEADER}\n${ROW(1, '"say ""hi"", ok"')}`)
    );

    // Assert
    expect(r).toEqual({ upserted: 1, rowCount: 1, deleted: 0 });
    expect(batches.flat().flatMap((s) => s.binds)[2]).toBe('say "hi", ok');
  });

  it("joins a multiline quoted field", async () => {
    // Arrange
    const { db, batches } = recordingDb();

    // Act
    const r = await syncCustomerSnapshotFromStream(
      db,
      stringToUint8Stream(`${CUSTOMER_HEADER}\n${ROW(1, '"Acme\nInc."')}`)
    );

    // Assert
    expect(r).toEqual({ upserted: 1, rowCount: 1, deleted: 0 });
    expect(batches.flat().flatMap((s) => s.binds)[2]).toBe("Acme\nInc.");
  });

  it("keeps a quoted CRLF inside the field", async () => {
    // Arrange
    const { db, batches } = recordingDb();

    // Act
    const r = await syncCustomerSnapshotFromStream(
      db,
      stringToUint8Stream(
        `${CUSTOMER_HEADER}\r\n${ROW(1, '"line1\r\nline2"')}\r\n${ROW(2)}\r\n`
      )
    );

    // Assert
    expect(r).toEqual({ upserted: 2, rowCount: 2, deleted: 0 });
    expect(batches.flat().flatMap((s) => s.binds)[2]).toBe("line1\r\nline2");
  });

  it("rejects a NUL byte before any D1 write", async () => {
    const { db, batches } = recordingDb();

    await expect(syncCustomerSnapshotFromStream(
      db,
      stringToUint8Stream(`${CUSTOMER_HEADER}\n${ROW(1, "a\u0000b")}`),
      undefined,
      { rejectControlCharacters: true }
    )).rejects.toThrow("CSV row 2 contains a disallowed control character.");

    expect(batches).toEqual([]);
  });

  it("imports 10k rows with no truncation (125 batches of 80)", async () => {
    // Arrange
    const { db, batches } = recordingDb();
    const csv = [
      CUSTOMER_HEADER,
      ...Array.from({ length: 10_000 }, (_, i) => ROW(i + 1))
    ].join("\n");

    // Act
    const r = await syncCustomerSnapshotFromStream(
      db,
      stringToUint8Stream(csv)
    );

    // Assert
    expect(r).toEqual({ upserted: 10000, rowCount: 10000, deleted: 0 });
    expect(batches).toHaveLength(125);
  });

  it("is chunk-invariant when a doubled-quote pair straddles a boundary", async () => {
    // Arrange — split between the two halves of a `""` pair.
    const full = 'a,"x ""y"\nb,c\n';
    const cut = full.indexOf('""') + 1;

    // Act
    const one = await collectLines(stringToUint8Stream(full));
    const two = await collectLines(
      chunkedStream([full.slice(0, cut), full.slice(cut)])
    );

    // Assert
    expect(two).toEqual(one);
    expect(one).toEqual(['a,"x ""y"', "b,c"]);
  });

  it("is chunk-invariant at every split point around a close-quote + newline", async () => {
    // Arrange
    const full = 'a,"x ""y"""\nb,c\n';
    const one = await collectLines(stringToUint8Stream(full));

    // Act / Assert — no split point may change the logical lines.
    for (let cut = 1; cut < full.length; cut++) {
      const two = await collectLines(
        chunkedStream([full.slice(0, cut), full.slice(cut)])
      );
      expect(two, `split at byte ${cut}`).toEqual(one);
    }
    expect(one).toEqual(['a,"x ""y"""', "b,c"]);
  });

  it("is chunk-invariant at every split point of a stray-quote file", async () => {
    // Arrange — chunking must never change the outcome, even for malformed
    // input: whatever the scanner does, it does deterministically.
    const full = 'h1,h2\n1,"a\n2,b\n3,c\n';
    const one = await collectLines(stringToUint8Stream(full));

    // Act / Assert
    for (let cut = 1; cut < full.length; cut++) {
      const two = await collectLines(
        chunkedStream([full.slice(0, cut), full.slice(cut)])
      );
      expect(two, `split at byte ${cut}`).toEqual(one);
    }
  });

  it("is chunk-invariant at every split point of a mid-field stray-quote file", async () => {
    // Arrange — the shape: a stray inch mark mid-field. The defer
    // guard (trailing `"` inside quotes waits for more data) must not change
    // the outcome at any boundary, and the stray `"` must never open a merge.
    const full = 'h1,h2\n1,5" widget\n2,ok\n';
    const one = await collectLines(stringToUint8Stream(full));

    // Act / Assert — no split point may change the logical lines.
    for (let cut = 1; cut < full.length; cut++) {
      const two = await collectLines(
        chunkedStream([full.slice(0, cut), full.slice(cut)])
      );
      expect(two, `split at byte ${cut}`).toEqual(one);
    }
    expect(one).toEqual(["h1,h2", '1,5" widget', "2,ok"]);
  });

  it("treats a mid-field stray quote as a literal: all rows land", async () => {
    // Arrange — row 2 carries a stray inch mark (`5" widget`), rows 3-4 are
    // well-formed. Fixed: the scanner only opens a quoted field
    // at field start, so the stray `"` is a literal and no rows are lost.
    const { db, batches } = recordingDb();
    const csv = [
      CUSTOMER_HEADER,
      ROW(1),
      ROW(2, '5" widget'),
      ROW(3),
      ROW(4)
    ].join("\n");

    // Act
    const r = await syncCustomerSnapshotFromStream(
      db,
      stringToUint8Stream(csv)
    );

    // Assert — all four rows land, stray mark preserved verbatim.
    expect(r).toEqual({ upserted: 4, rowCount: 4, deleted: 0 });
    const flat = batches.flat().flatMap((s) => s.binds);
    const ids = flat.filter((_, i) => i % 14 === 0);
    expect(ids).toEqual([1, 2, 3, 4]);
    expect(flat[14 + 2]).toBe('5" widget');
  });

  it("yields the remainder when the file ends inside an unclosed quote (documented EOF behavior)", async () => {
    // Arrange — csvStream.ts documents this: a trailing unterminated quote
    // yields the final buffer as one line instead of failing. No well-formed
    // rows are lost here (unlike the mid-file stray case above).
    const { db } = recordingDb();
    const csv = [CUSTOMER_HEADER, ROW(1), ROW(2), '3,,"oops'].join("\n");

    // Act
    const r = await syncCustomerSnapshotFromStream(
      db,
      stringToUint8Stream(csv)
    );

    // Assert
    expect(r).toEqual({ upserted: 3, rowCount: 3, deleted: 0 });
  });
});

describe("CSV dialect sweep, HTTP level", () => {
  beforeAll(async () => {
    await ensureD1TestTables();
  });

  function custDb(): D1Database {
    return (env as unknown as { CUSTOMER_DB: D1Database }).CUSTOMER_DB;
  }

  async function postImport(body: string): Promise<Response> {
    return exports.default.fetch(
      "http://test.local/api/v1/customer-snapshot/import",
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-sync-secret",
          "content-type": "text/csv"
        },
        body
      }
    );
  }

  it("imports a BOM-prefixed body with 200", async () => {
    // Act
    const res = await postImport(`﻿${CUSTOMER_HEADER}\n${ROW(74001)}`);

    // Assert
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ upserted: 1, rowCount: 1 });
  });

  it("imports a CRLF body with 200", async () => {
    // Act
    const res = await postImport(`${CUSTOMER_HEADER}\r\n${ROW(74002)}\r\n`);

    // Assert
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ upserted: 1, rowCount: 1 });
  });

  it("imports a quoted-comma company and stores the exact value", async () => {
    // Act
    const res = await postImport(
      `${CUSTOMER_HEADER}\n${ROW(74003, '"Acme, Inc."')}`
    );

    // Assert
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ upserted: 1, rowCount: 1 });
    const row = await custDb()
      .prepare("SELECT company_name FROM customer_snapshot WHERE customer_id = 74003")
      .first<{ company_name: string }>();
    expect(row?.company_name).toBe("Acme, Inc.");
  });

  it("imports 10k rows end to end with 200", async () => {
    // Arrange
    const csv = [
      CUSTOMER_HEADER,
      ...Array.from({ length: 10_000 }, (_, i) => ROW(75000 + i))
    ].join("\n");

    // Act
    const res = await postImport(csv);

    // Assert
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ upserted: 10000, rowCount: 10000 });
  });

  it("rejects a BOM-only body with 400, not a silent 200 zeros", async () => {
    // Act
    const res = await postImport("﻿");

    // Assert
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("problem+json");
  });

  it("rejects a header-only BOM body with 400", async () => {
    // Act
    const res = await postImport(`﻿${CUSTOMER_HEADER}`);

    // Assert
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("problem+json");
  });

  it("rejects a header + blank-lines-only body with 400", async () => {
    // Act
    const res = await postImport(`${CUSTOMER_HEADER}\n\n   \n\n`);

    // Assert
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("problem+json");
  });

  it("rejects a UTF-16LE body with 400, never a 500", async () => {
    // Arrange — a UTF-16LE file is not valid CSV input; the header check must
    // fail closed with a 400, not blow up downstream.
    const utf16 = new Uint8Array(
      Buffer.from(`﻿${CUSTOMER_HEADER}\n${ROW(74004)}\n`, "utf16le")
    );

    // Act
    const res = await exports.default.fetch(
      "http://test.local/api/v1/customer-snapshot/import",
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-sync-secret",
          "content-type": "text/csv"
        },
        body: utf16 as unknown as BodyInit
      }
    );

    // Assert
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("problem+json");
  });

  it("imports every row through a mid-file stray quote with 200", async () => {
    // Arrange — fixed: the stray `"` in row 74102 is a literal,
    // so all four well-formed rows land with success reported.
    const csv = [
      CUSTOMER_HEADER,
      ROW(74101),
      ROW(74102, '5" widget'),
      ROW(74103),
      ROW(74104)
    ].join("\n");

    // Act
    const res = await postImport(csv);

    // Assert
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ upserted: 4, rowCount: 4 });
    const rows = await custDb()
      .prepare(
        "SELECT customer_id, company_name FROM customer_snapshot WHERE customer_id IN (74101,74102,74103,74104) ORDER BY customer_id"
      )
      .all<{ customer_id: number; company_name: string }>();
    expect(rows.results?.map((r) => r.customer_id)).toEqual([
      74101, 74102, 74103, 74104
    ]);
    expect(rows.results?.[1]?.company_name).toBe('5" widget');
  });
});

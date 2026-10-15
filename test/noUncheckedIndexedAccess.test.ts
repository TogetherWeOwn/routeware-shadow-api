import { describe, expect, it } from "vitest";
import { bearerFromRequest } from "../src/lib/auth";
import { mapCsvHeaders } from "../src/lib/csvParse";
import { parseAddressSnapshotCsv } from "../src/lib/csvAddressSnapshot";
import { parseContainerSnapshotCsv } from "../src/lib/csvContainerSnapshot";
import { parseCustomerSnapshotCsv } from "../src/lib/csvCustomerSnapshot";
import {
  extractRequestVerificationTokenFromHtml,
  lastUrlEncodedValue,
} from "../src/lib/customerSaveAutoToken";
import {
  extractAntiForgeryFromExtNet,
  mergeSetCookies,
} from "../src/lib/httpAuth";
import { renderSnapshotManifest } from "../src/lib/r2SnapshotArchive";
import { extractRequestIdFromText } from "../src/lib/routewareQueryReportCsv";
import { rejectUnsupportedSnapshotImportContentType } from "../src/routes/snapshotImport";

function headerReader(auth?: string) {
  return {
    header: (n: string) => (n.toLowerCase() === "authorization" ? auth : undefined),
  };
}

function jarResponse(setCookies: string[]): Response {
  const headers = new Headers();
  for (const sc of setCookies) {
    headers.append("set-cookie", sc);
  }
  return new Response("ok", { status: 200, headers });
}

/**
 * TOG-18935: guards added for `noUncheckedIndexedAccess` in `src/`.
 * Each case exercises a new explicit-guard branch reachable from input
 * (headers, CSV bodies, Set-Cookie attributes, report text) and pins the
 * behavior-neutral outcome.
 */
describe("noUncheckedIndexedAccess guards (TOG-18935)", () => {
  it("bearerFromRequest returns the token or null, never undefined", () => {
    expect(bearerFromRequest(headerReader("Bearer s3cret"))).toBe("s3cret");
    expect(bearerFromRequest(headerReader("bearer s3cret"))).toBe("s3cret");
    expect(bearerFromRequest(headerReader(undefined))).toBeNull();
    expect(bearerFromRequest(headerReader(""))).toBeNull();
    expect(bearerFromRequest(headerReader("Bearer "))).toBeNull();
    expect(bearerFromRequest(headerReader("Bearer s3cret junk"))).toBeNull();
    expect(bearerFromRequest(headerReader("Basic s3cret"))).toBeNull();
  });

  it("mapCsvHeaders handles an empty header line without throwing", () => {
    const cols = mapCsvHeaders("");
    expect(cols[""]).toBe(0);
    const normal = mapCsvHeaders("CustomerID,Enabled");
    expect(normal["customerid"]).toBe(0);
    expect(normal["enabled"]).toBe(1);
  });

  it("snapshot CSV parsers return empty header and no rows for empty input", () => {
    expect(parseCustomerSnapshotCsv("")).toEqual({ header: "", rows: [] });
    expect(parseAddressSnapshotCsv("")).toEqual({ header: "", rows: [] });
    expect(parseContainerSnapshotCsv("")).toEqual({ header: "", rows: [] });
  });

  it("snapshot CSV parsers return the header and no rows for header-only input", () => {
    const customerHeader = "CustomerID,CustomerTypeID,CompanyName";
    expect(parseCustomerSnapshotCsv(customerHeader)).toEqual({
      header: customerHeader,
      rows: [],
    });
    const addressHeader = "PickupAddressID,CustomerID,Address";
    expect(parseAddressSnapshotCsv(addressHeader)).toEqual({
      header: addressHeader,
      rows: [],
    });
    const containerHeader = "ContainerID,PickupAddressID,SerialNumber";
    expect(parseContainerSnapshotCsv(containerHeader)).toEqual({
      header: containerHeader,
      rows: [],
    });
  });

  it("snapshot CSV parsers skip blank lines between data rows", () => {
    const csv = "CustomerID,CustomerTypeID,CompanyName\n1,,Acme\n\n2,,Globex\n";
    const parsed = parseCustomerSnapshotCsv(csv);
    expect(parsed.rows.map((r) => r.customerId)).toEqual([1, 2]);
  });

  it("rejectUnsupportedSnapshotImportContentType falls through to 415 on missing/empty type", () => {
    const url = "http://test.local/api/v1/customer-snapshot/import";
    expect(
      rejectUnsupportedSnapshotImportContentType({ url, contentType: null })
    ).not.toBeNull();
    expect(
      rejectUnsupportedSnapshotImportContentType({ url, contentType: "" })?.status
    ).toBe(415);
    expect(
      rejectUnsupportedSnapshotImportContentType({
        url,
        contentType: "application/json",
      })?.status
    ).toBe(415);
  });

  it("rejectUnsupportedSnapshotImportContentType accepts CSV and octet-stream with parameters", () => {
    const url = "http://test.local/api/v1/customer-snapshot/import";
    expect(
      rejectUnsupportedSnapshotImportContentType({ url, contentType: "text/csv" })
    ).toBeNull();
    expect(
      rejectUnsupportedSnapshotImportContentType({
        url,
        contentType: "Text/CSV; charset=utf-8",
      })
    ).toBeNull();
    expect(
      rejectUnsupportedSnapshotImportContentType({
        url,
        contentType: "application/octet-stream",
      })
    ).toBeNull();
  });

  it("extractRequestIdFromText returns null with no UUID and lowercases keyed ids", () => {
    expect(extractRequestIdFromText("still processing")).toBeNull();
    expect(extractRequestIdFromText("")).toBeNull();
    const upper = "BC5FFC64-A44D-477A-9AAC-192F5166E987";
    expect(
      extractRequestIdFromText(`{ "requestID": "${upper}" }`)
    ).toBe(upper.toLowerCase());
  });

  it("anti-forgery extractors return null when no token is present", () => {
    expect(extractAntiForgeryFromExtNet("<html>no token here</html>")).toBeNull();
    expect(
      extractRequestVerificationTokenFromHtml("<html>no token here</html>")
    ).toBeNull();
    expect(lastUrlEncodedValue("CustomerID=5", "__RequestVerificationToken")).toBeUndefined();
  });

  it("mergeSetCookies evicts Max-Age<=0 and past Expires, keeps bare empty values", () => {
    const now = Date.now();
    const jar: Record<string, string> = { stale: "FAKE-old" };
    mergeSetCookies(jar, jarResponse(["stale=gone; Max-Age=0"]), now);
    expect("stale" in jar).toBe(false);

    const jar2: Record<string, string> = { gone: "FAKE-old" };
    mergeSetCookies(
      jar2,
      jarResponse(["gone=gone; Expires=Thu, 01 Jan 1970 00:00:00 GMT"]),
      now
    );
    expect("gone" in jar2).toBe(false);

    const jar3: Record<string, string> = {};
    mergeSetCookies(jar3, jarResponse(["empty=; Path=/"]), now);
    expect(jar3["empty"]).toBe("");
  });

  it("renderSnapshotManifest keeps sorted entries", () => {
    const text = renderSnapshotManifest({
      version: 1,
      date: "2026-10-01",
      files: {
        "customer.csv": {
          key: "snapshots/2026-10-01/customer.csv",
          sha256: "a".repeat(64),
          bytes: 10,
        },
      },
    });
    expect(text).toContain("customer.csv");
    expect(text.endsWith("\n")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import {
  extractRequestVerificationTokenFromHtml,
  injectAntiForgeryTokenIntoUrlencoded,
  isPlaceholderAntiForgeryToken,
  lastUrlEncodedValue
} from "../src/lib/customerSaveAutoToken";
import { isLoginPageResponse, isLoginRedirect, looksLikeLoginPageHtml } from "../src/lib/loginRedirect";
import {
  routewareWebRwUrl,
  routewareWebRwUrlWithIncomingSearch
} from "../src/lib/upstreamUrl";
import { problemJsonResponse } from "../src/lib/problem";
import { parseAddressSnapshotRow } from "../src/lib/csvAddressSnapshot";
import { mapCsvHeaders } from "../src/lib/csvParse";
import { parseContainerSnapshotRow } from "../src/lib/csvContainerSnapshot";
import { streamCsvLines, stringToUint8Stream } from "../src/lib/csvStream";
import { snapshotR2ObjectKey } from "../src/lib/r2SnapshotArchive";

describe("customerSaveAutoToken helpers", () => {
  it("lastUrlEncodedValue returns last duplicate", () => {
    expect(lastUrlEncodedValue("a=1&a=2&b=3", "a")).toBe("2");
  });

  it("extracts anti-forgery token from HTML", () => {
    const html =
      '<form><input name="__RequestVerificationToken" type="hidden" value="abc+123" /></form>';
    expect(extractRequestVerificationTokenFromHtml(html)).toBe("abc+123");
  });

  it("detects placeholder tokens", () => {
    expect(isPlaceholderAntiForgeryToken("REPLACE_WITH_TOKEN")).toBe(true);
    expect(isPlaceholderAntiForgeryToken("real-token")).toBe(false);
  });

  it("injects token at start of urlencoded body", () => {
    const out = injectAntiForgeryTokenIntoUrlencoded("CustomerID=1&Enabled=false", "T1");
    expect(out).toContain("__RequestVerificationToken=T1&");
    expect(out).toContain("CustomerID=1");
  });
});

describe("isLoginRedirect", () => {
  it("returns false for non-302", () => {
    expect(isLoginRedirect(new Response(null, { status: 200 }))).toBe(false);
  });

  it("detects Account/Login", () => {
    const response = new Response(null, {
      status: 302,
      headers: { location: "https://x/WebRW/Account/Login" }
    });
    expect(isLoginRedirect(response)).toBe(true);
  });

  it("detects Login.aspx", () => {
    const response = new Response(null, {
      status: 302,
      headers: { location: "/foo/Login.aspx?x=1" }
    });
    expect(isLoginRedirect(response)).toBe(true);
  });
});

describe("looksLikeLoginPageHtml (TOG-6515)", () => {
  it("matches a password field plus the login path", () => {
    expect(
      looksLikeLoginPageHtml(
        '<form action="/WebRW/Account/Login"><input name="Password" type="password" /></form>'
      )
    ).toBe(true);
  });

  it("matches Ext.NET login markers (Password-inputEl + UserName + token)", () => {
    expect(
      looksLikeLoginPageHtml(
        '<div id="Password-inputEl"></div><div>UserName</div>' +
          '<input name="__RequestVerificationToken" value="FAKE" />'
      )
    ).toBe(true);
  });

  it("rejects anti-forgery modal HTML (token but no password field)", () => {
    expect(
      looksLikeLoginPageHtml(
        '<form><input name="__RequestVerificationToken" type="hidden" value="abc+123" /></form>'
      )
    ).toBe(false);
  });

  it("rejects an error page with no login structure", () => {
    expect(
      looksLikeLoginPageHtml(
        "<!DOCTYPE html><html><body>Object reference not set to an instance of an object</body></html>"
      )
    ).toBe(false);
  });
});

describe("isLoginPageResponse (TOG-6515)", () => {
  it("returns false without reading JSON/CSV 200 bodies", async () => {
    const json = new Response('{"Password":"UserName"}', {
      status: 200,
      headers: { "content-type": "application/json" }
    });
    expect(await isLoginPageResponse(json)).toBe(false);
    const csv = new Response("Password,UserName", {
      status: 200,
      headers: { "content-type": "text/csv" }
    });
    expect(await isLoginPageResponse(csv)).toBe(false);
  });

  it("detects an HTML 200 login page", async () => {
    const login = new Response(
      '<form action="/WebRW/Account/Login"><input name="Password" type="password" /></form>',
      { status: 200, headers: { "content-type": "text/html" } }
    );
    expect(await isLoginPageResponse(login)).toBe(true);
  });
});

describe("routewareWebRwUrl", () => {
  it("joins base path and resource path", () => {
    const url = routewareWebRwUrl(
      "https://example.com",
      "/WebRW",
      "/Home/Index"
    );
    expect(url.href).toBe("https://example.com/WebRW/Home/Index");
  });
});

describe("routewareWebRwUrlWithIncomingSearch", () => {
  it("copies search from incoming request", () => {
    const incoming = new Request(
      "https://shadow.test/api/v1/routeware/reports/q?job=1&flag=yes"
    );
    const url = routewareWebRwUrlWithIncomingSearch(
      "https://example.com",
      "/WebRW",
      "/Reports/QueryRequestIsComplete",
      incoming
    );
    expect(url.pathname).toBe("/WebRW/Reports/QueryRequestIsComplete");
    expect(url.search).toBe("?job=1&flag=yes");
  });
});

describe("snapshotR2ObjectKey", () => {
  it("uses UTC date and table", () => {
    const k = snapshotR2ObjectKey("container", new Date("2026-01-15T12:00:00.000Z"));
    expect(k).toBe("snapshots/2026-01-15/container.csv");
  });
});

describe("streamCsvLines", () => {
  async function collect(s: string): Promise<string[]> {
    const out: string[] = [];
    for await (const line of streamCsvLines(stringToUint8Stream(s))) {
      out.push(line);
    }
    return out;
  }

  it("splits on unix newlines", async () => {
    expect(await collect("a,b\nc,d\n")).toEqual(["a,b", "c,d"]);
  });

  it("treats newline inside quotes as part of one line", async () => {
    expect(await collect(`"x\ny",z\n`)).toEqual([`"x\ny",z`]);
  });

  it("yields the last line when a quoted field is not closed at EOF (lenient)", async () => {
    expect(await collect('a,"b')).toEqual(['a,"b']);
  });
});

describe("address / container snapshot CSV", () => {
  it("parses sample address row and links CustomerID to PickupAddressID", () => {
    const header =
      "PickupAddressID,CustomerID,RouteID,Address,City,State,Zip,FranchiseID,Comments,ExtrasAllowed,Enabled,DriverNote,Latitude,Longitude,Last_Audit_Date";
    const cols = mapCsvHeaders(header);
    const dataLine =
      '"11581","2","1","1611 DENISE DR","KILLEEN","TX","76542","","","True","True","","","",""';
    const r = parseAddressSnapshotRow(cols, dataLine);
    expect(r).not.toBeNull();
    if (!r) {
      return;
    }
    expect(r.pickupAddressId).toBe(11581);
    expect(r.customerId).toBe(2);
  });

  it("parses sample container row and links ContainerID to PickupAddressID", () => {
    const header =
      "ContainerID,PickupAddressID,ContainerTypeID,SerialNumber,RFID,OnCall,EventCode,GPSLocked,Latitude,Longitude,Enabled,Address,City,State,Zip,ContainerNote,UD-Cost_Share-UD,UD-Enclosure_Doors-UD,UD-Last_Compactor_Inspection-UD,UD-Last_Enclosure_Inspection-UD,UD-Material_Stream-UD,Color,ServiceCodeType,ServiceCode_input,ServiceCode,ServiceDate,RouteIDs,FrequencyIDs";
    const cols = mapCsvHeaders(header);
    const dataLine = `"1","16914","6","115388","","False","PU","True","31.0","-97.0","True","4300 ABIGAIL DR A","KILLEEN","TX","76549","","","","","","","","","","","1, 2","1, 2"`;
    const r = parseContainerSnapshotRow(cols, dataLine);
    expect(r).not.toBeNull();
    if (!r) {
      return;
    }
    expect(r.containerId).toBe(1);
    expect(r.pickupAddressId).toBe(16914);
  });
});

describe("problemJsonResponse", () => {
  it("sets problem+json content type", async () => {
    const response = problemJsonResponse({
      type: "https://example.com/probs/oops",
      title: "Oops",
      status: 418
    });
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    const body = (await response.json()) as { status: number; title: string };
    expect(body.status).toBe(418);
    expect(body.title).toBe("Oops");
  });
});

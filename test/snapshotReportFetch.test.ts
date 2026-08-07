import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `src/lib/snapshot/reportFetch.ts` — the single door through which every
 * scheduled snapshot pulls its CSV. All three orchestration steps (customer,
 * address, container) call `fetchReportCsvForPath`, so its two failure modes
 * are the ones that decide whether a nightly cron produces data or an empty
 * export.
 *
 * Both are silent from the caller's side. Routeware answers an expired admin
 * session with a login redirect or an HTML error page rather than a 401, so the
 * first attempt failing is routine; if the re-auth retry were dropped, or the
 * session not re-read after `establishSession`, the retry would carry the same
 * dead cookie and every scheduled sync would fail identically. And if the
 * `!resp.ok` throw were softened, `streamSync` would parse a login page as CSV,
 * find zero rows, and — were the reconcile guard not also in place — delete the
 * table it was meant to refresh.
 */

type ForwardCall = {
  url: string;
  cookie: string | null;
  request: Request;
  body: ArrayBuffer | null;
};

const calls: {
  forwards: ForwardCall[];
  established: Array<{ loginUrl: string; stub: unknown }>;
  sessionReads: number;
  idNames: string[];
  stubGets: unknown[];
} = {
  forwards: [],
  established: [],
  sessionReads: 0,
  idNames: [],
  stubGets: []
};

const behavior: { responses: Array<() => Response> } = { responses: [] };

vi.mock("../src/lib/sessionState", () => ({
  readSessionState: async () => {
    calls.sessionReads += 1;
    return {
      cookieHeader: `ASP.NET_SessionId=s${calls.sessionReads}`,
      expiresAtMs: null,
      refreshing: false
    };
  }
}));

vi.mock("../src/lib/establishSession", () => ({
  establishSession: async (_env: unknown, stub: unknown, loginUrl: string) => {
    calls.established.push({ loginUrl, stub });
  }
}));

vi.mock("../src/lib/upstreamForward", () => ({
  // A plain function, not vi.fn(): the spy wrapper records the settled result
  // of the double and turns a deliberate rejection into an unhandled one under
  // the workers pool.
  forwardToUpstream: async (
    incoming: Request,
    upstreamUrl: URL,
    session: { cookieHeader: string | null } | null,
    bodyBuffer: ArrayBuffer | null
  ) => {
    calls.forwards.push({
      url: upstreamUrl.toString(),
      cookie: session?.cookieHeader ?? null,
      request: incoming,
      body: bodyBuffer
    });
    const next = behavior.responses.shift();
    return next ? next() : new Response("id,name\n", { status: 200 });
  }
}));

const { createReportRequest, fetchReportCsvForPath } = await import(
  "../src/lib/snapshot/reportFetch"
);

const doSessionStub = { name: "primary-stub" } as unknown as DurableObjectStub;

const env = {
  TARGET_ORIGIN: "https://killeen.example.test",
  TARGET_BASE_PATH: "/WebRW",
  LOGIN_URL: "https://killeen.example.test/WebRW/Account/Login",
  AUTH_SESSION: {
    idFromName: (name: string) => {
      calls.idNames.push(name);
      return { name } as unknown as DurableObjectId;
    },
    get: (id: DurableObjectId) => {
      calls.stubGets.push(id);
      return doSessionStub;
    }
  }
} as unknown as Env;

const REPORT_PATH = "/WebRW/Reports/QueryReport?reportID=42&format=csv";

beforeEach(() => {
  calls.forwards = [];
  calls.established = [];
  calls.sessionReads = 0;
  calls.idNames = [];
  calls.stubGets = [];
  behavior.responses = [];
});

describe("createReportRequest", () => {
  it("asks for CSV first while still accepting anything the report endpoint returns", () => {
    // Arrange — Routeware content-negotiates: without an explicit CSV accept it
    // serves the HTML report viewer, which parses to zero rows.

    // Act
    const req = createReportRequest(env);

    // Assert
    expect(req.headers.get("accept")).toBe("text/csv,*/*;q=0.8");
  });

  it("sends a referer inside the application so the export is not treated as off-site", () => {
    // Arrange

    // Act
    const req = createReportRequest(env);

    // Assert
    expect(req.headers.get("referer")).toBe("https://killeen.example.test/WebRW/");
  });

  it("is a GET, since the report path already carries every parameter", () => {
    // Arrange

    // Act
    const req = createReportRequest(env);

    // Assert
    expect(req.method).toBe("GET");
  });
});

describe("fetchReportCsvForPath", () => {
  it("resolves the report path against the configured target origin", async () => {
    // Arrange
    behavior.responses = [() => new Response("id,name\n1,Acme\n", { status: 200 })];

    // Act
    await fetchReportCsvForPath(env, REPORT_PATH);

    // Assert
    expect(calls.forwards).toHaveLength(1);
    expect(calls.forwards[0].url).toBe(
      "https://killeen.example.test/WebRW/Reports/QueryReport?reportID=42&format=csv"
    );
  });

  it("keeps the origin of an absolute report path rather than re-basing it", async () => {
    // Arrange — `new URL(path, origin)` ignores the base when the path is
    // already absolute; pin that so a fully-qualified configured path works.
    behavior.responses = [() => new Response("id\n", { status: 200 })];

    // Act
    await fetchReportCsvForPath(env, "https://other.example.test/Export.csv");

    // Assert
    expect(calls.forwards[0].url).toBe("https://other.example.test/Export.csv");
  });

  it("uses the single shared 'primary' session Durable Object", async () => {
    // Arrange — a per-call DO name would mean each report re-authenticates and
    // the login sessions would race each other out of validity.
    behavior.responses = [() => new Response("id\n", { status: 200 })];

    // Act
    await fetchReportCsvForPath(env, REPORT_PATH);

    // Assert
    expect(calls.idNames).toEqual(["primary"]);
    expect(calls.stubGets).toEqual([{ name: "primary" }]);
  });

  it("returns the upstream response untouched on a 200 without re-authenticating", async () => {
    // Arrange
    const csv = "id,name\n1,Acme\n";
    behavior.responses = [() => new Response(csv, { status: 200 })];

    // Act
    const resp = await fetchReportCsvForPath(env, REPORT_PATH);

    // Assert
    expect(await resp.text()).toBe(csv);
    expect(calls.established).toEqual([]);
    expect(calls.forwards).toHaveLength(1);
    expect(calls.sessionReads).toBe(1);
  });

  it("sends the stored session cookie with the first attempt", async () => {
    // Arrange
    behavior.responses = [() => new Response("id\n", { status: 200 })];

    // Act
    await fetchReportCsvForPath(env, REPORT_PATH);

    // Assert
    expect(calls.forwards[0].cookie).toBe("ASP.NET_SessionId=s1");
  });

  it("forwards no request body, since the report call is a GET", async () => {
    // Arrange
    behavior.responses = [() => new Response("id\n", { status: 200 })];

    // Act
    await fetchReportCsvForPath(env, REPORT_PATH);

    // Assert
    expect(calls.forwards[0].body).toBeNull();
  });

  it("carries the CSV accept and referer headers to the upstream forwarder", async () => {
    // Arrange — the headers are only useful if the request built by
    // `createReportRequest` is the one actually forwarded.
    behavior.responses = [() => new Response("id\n", { status: 200 })];

    // Act
    await fetchReportCsvForPath(env, REPORT_PATH);

    // Assert
    expect(calls.forwards[0].request.headers.get("accept")).toBe("text/csv,*/*;q=0.8");
    expect(calls.forwards[0].request.headers.get("referer")).toBe(
      "https://killeen.example.test/WebRW/"
    );
  });

  it("re-establishes the session and retries once after a login redirect", async () => {
    // Arrange — an expired admin session surfaces as a 302 to the login page,
    // never as a 401.
    behavior.responses = [
      () => new Response("", { status: 302, headers: { location: "/WebRW/Account/Login" } }),
      () => new Response("id,name\n1,Acme\n", { status: 200 })
    ];

    // Act
    const resp = await fetchReportCsvForPath(env, REPORT_PATH);

    // Assert
    expect(calls.established).toHaveLength(1);
    expect(calls.forwards).toHaveLength(2);
    expect(resp.status).toBe(200);
  });

  it("also retries after a plain non-200, which is how an error page arrives", async () => {
    // Arrange
    behavior.responses = [
      () => new Response("<html>Session expired</html>", { status: 500 }),
      () => new Response("id,name\n1,Acme\n", { status: 200 })
    ];

    // Act
    const resp = await fetchReportCsvForPath(env, REPORT_PATH);

    // Assert
    expect(calls.established).toHaveLength(1);
    expect(await resp.text()).toBe("id,name\n1,Acme\n");
  });

  it("logs in against the configured login URL using the same session stub", async () => {
    // Arrange
    behavior.responses = [
      () => new Response("", { status: 500 }),
      () => new Response("id\n", { status: 200 })
    ];

    // Act
    await fetchReportCsvForPath(env, REPORT_PATH);

    // Assert
    expect(calls.established[0]).toEqual({
      loginUrl: "https://killeen.example.test/WebRW/Account/Login",
      stub: doSessionStub
    });
  });

  it("re-reads the session after re-authenticating rather than reusing the stale one", async () => {
    // Arrange — reusing the pre-login cookie would make the retry fail in
    // exactly the same way as the first attempt, so the retry would be theatre.
    behavior.responses = [
      () => new Response("", { status: 500 }),
      () => new Response("id\n", { status: 200 })
    ];

    // Act
    await fetchReportCsvForPath(env, REPORT_PATH);

    // Assert
    expect(calls.sessionReads).toBe(2);
    expect(calls.forwards[0].cookie).toBe("ASP.NET_SessionId=s1");
    expect(calls.forwards[1].cookie).toBe("ASP.NET_SessionId=s2");
  });

  it("retries against the same URL it first requested", async () => {
    // Arrange
    behavior.responses = [
      () => new Response("", { status: 500 }),
      () => new Response("id\n", { status: 200 })
    ];

    // Act
    await fetchReportCsvForPath(env, REPORT_PATH);

    // Assert
    expect(calls.forwards[1].url).toBe(calls.forwards[0].url);
  });

  it("retries at most once instead of looping against a broken upstream", async () => {
    // Arrange — a cron running inside ctx.waitUntil has a wall-clock budget; a
    // retry loop would burn it and take the other snapshot steps down with it.
    behavior.responses = [
      () => new Response("", { status: 500, statusText: "Internal Server Error" }),
      () => new Response("", { status: 500, statusText: "Internal Server Error" })
    ];

    // Act
    await fetchReportCsvForPath(env, REPORT_PATH).catch(() => undefined);

    // Assert
    expect(calls.forwards).toHaveLength(2);
    expect(calls.established).toHaveLength(1);
  });

  it("throws with the status and status text when the retry also fails", async () => {
    // Arrange — this throw is what tags the scheduled run with a failing step;
    // returning the error page instead would be parsed as an empty CSV.
    behavior.responses = [
      () => new Response("", { status: 503, statusText: "Service Unavailable" }),
      () =>
        new Response("<html>maintenance</html>", {
          status: 503,
          statusText: "Service Unavailable"
        })
    ];

    // Act
    const error = (await fetchReportCsvForPath(env, REPORT_PATH).catch(
      (e: unknown) => e
    )) as Error;

    // Assert
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Report fetch failed: 503 Service Unavailable");
  });

  it("accepts a retry that succeeds with a non-200 but still-ok status", async () => {
    // Arrange — the retry trigger is `status !== 200` but the throw guard is
    // `!resp.ok`, so a 204 retries once and is then accepted.
    behavior.responses = [
      () => new Response(null, { status: 204 }),
      () => new Response(null, { status: 204 })
    ];

    // Act
    const resp = await fetchReportCsvForPath(env, REPORT_PATH);

    // Assert
    expect(resp.status).toBe(204);
    expect(calls.forwards).toHaveLength(2);
  });

  it("does not re-authenticate when the very first attempt is already ok", async () => {
    // Arrange — pins the short-circuit: a 200 must not pay for a login round
    // trip on every one of the three nightly report steps.
    behavior.responses = [() => new Response("id\n", { status: 200 })];

    // Act
    await fetchReportCsvForPath(env, REPORT_PATH);

    // Assert
    expect(calls.established).toEqual([]);
    expect(calls.sessionReads).toBe(1);
  });
});

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Request, type Response } from "playwright";
import {
  fullHeaders,
  redactBodyPreview,
  redactHeaders,
  redactQueryObject,
  redactUrlEncoded,
  redactUrlSearch
} from "./lib/redact.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "out");
const OUT_FILE = join(OUT_DIR, "harvest.ndjson");

const TARGET_ORIGIN =
  process.env.TARGET_ORIGIN ?? "https://killeen.routeware.com";
const TARGET_BASE_PATH = process.env.TARGET_BASE_PATH ?? "/WebRW";
const START_URL = process.env.START_URL ?? `${TARGET_ORIGIN}${TARGET_BASE_PATH}/`;

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Max bytes stored for request/response bodies (UTF-8 string slice / decode cap). */
const MAX_RESPONSE_BYTES = intEnv("HARVEST_MAX_RESPONSE_BYTES", 256 * 1024);
const MAX_REQUEST_BODY_BYTES = intEnv("HARVEST_MAX_REQUEST_BYTES", 256 * 1024);

function underWebRw(url: URL): boolean {
  return url.origin === new URL(TARGET_ORIGIN).origin && url.pathname.startsWith(TARGET_BASE_PATH);
}

/** Full header capture (Cookie, Authorization, Set-Cookie, …). Default strips those for safer logs. */
function harvestFullHeaders(): boolean {
  const full = process.env.HARVEST_FULL_HEADERS;
  if (full !== undefined && full !== "") {
    const s = String(full).toLowerCase();
    if (s === "1" || s === "true" || s === "yes") {
      return true;
    }
  }
  const redact = process.env.HARVEST_REDACT_HEADERS;
  if (redact !== undefined && redact !== "") {
    const s = String(redact).toLowerCase();
    if (s === "0" || s === "false" || s === "no") {
      return true;
    }
  }
  return false;
}

type Append = (obj: object) => void;


async function logRequestResponse(
  request: Request,
  response: Response | null,
  append: Append,
  headerCapture: (h: Headers | Record<string, string>) => Record<string, string>,
  redactSensitive: boolean
): Promise<void> {
  try {
    const url = new URL(request.url());
    if (!underWebRw(url)) {
      return;
    }
    let requestBodyPreview: string | undefined;
    let requestBodyTruncated = false;
    const postData = request.postData();
    if (postData) {
      requestBodyTruncated = postData.length > MAX_REQUEST_BODY_BYTES;
      requestBodyPreview = requestBodyTruncated
        ? postData.slice(0, MAX_REQUEST_BODY_BYTES)
        : postData;
    }

    const requestContentType = request.headers()["content-type"] ?? null;
    const responseContentType = response?.headers()["content-type"] ?? null;

    let responseBodyPreview: string | undefined;
    let responseBodyTruncated = false;
    let responseHeaders: Record<string, string> | null = null;
    if (response) {
      responseHeaders = headerCapture(response.headers());
      const buf = await response.body().catch(() => null);
      if (buf && buf.byteLength > 0) {
        const slice =
          buf.byteLength > MAX_RESPONSE_BYTES ? buf.slice(0, MAX_RESPONSE_BYTES) : buf;
        responseBodyTruncated = buf.byteLength > MAX_RESPONSE_BYTES;
        responseBodyPreview = new TextDecoder("utf-8", { fatal: false }).decode(slice);
      }
    }

    // Mask credentials/PII in bodies and query strings unless full capture is on
    // (header redaction alone leaves login/save bodies and query tokens exposed).
    if (redactSensitive) {
      requestBodyPreview = redactBodyPreview(requestContentType, requestBodyPreview);
      responseBodyPreview = redactBodyPreview(responseContentType, responseBodyPreview);
    }

    const rawQuery = Object.fromEntries(url.searchParams);
    const rawQueryString = url.search ? url.search.slice(1) : "";
    const frame = request.frame();
    const rawFrameUrl = frame?.url() ?? null;
    append({
      ts: new Date().toISOString(),
      method: request.method(),
      resourceType: request.resourceType(),
      origin: url.origin,
      pathname: url.pathname,
      pathWithQuery: redactSensitive
        ? `${url.pathname}${url.search ? `?${redactUrlEncoded(rawQueryString)}` : ""}`
        : `${url.pathname}${url.search}`,
      fullUrl: redactSensitive ? redactUrlSearch(url.href) : url.href,
      query: redactSensitive ? redactQueryObject(rawQuery) : rawQuery,
      queryString: redactSensitive ? redactUrlEncoded(rawQueryString) : rawQueryString,
      frameUrl: redactSensitive ? redactUrlSearch(rawFrameUrl) : rawFrameUrl,
      requestHeaders: headerCapture(request.headers()),
      requestContentType,
      requestBodySize: request.postDataBuffer()?.byteLength ?? 0,
      requestBodyPreview,
      requestBodyTruncated,
      responseStatus: response?.status() ?? null,
      responseHeaders,
      responseContentType,
      responseBodyPreview,
      responseBodyTruncated
    });
  } catch {
    // Avoid crashing the recorder on odd responses (e.g. aborted navigation).
  }
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  // CLI flags so the modes work cross-platform (inline `FOO=1 npm run …` does not
  // work in PowerShell / cmd). Flags OR with the equivalent env vars.
  const argv = new Set(process.argv.slice(2));
  const flagFull = argv.has("--full");
  const flagFresh = argv.has("--fresh");
  const fresh =
    flagFresh || process.env.HARVEST_FRESH === "1" || process.env.HARVEST_FRESH === "true";
  const stream = createWriteStream(OUT_FILE, { flags: fresh ? "w" : "a" });
  if (fresh) {
    console.log("HARVEST_FRESH: truncating", OUT_FILE);
  }

  const fullHdr = flagFull || harvestFullHeaders();
  if (fullHdr) {
    console.warn(
      "HARVEST_FULL_HEADERS / HARVEST_REDACT_HEADERS=0: logging all headers (cookies, auth). Keep harvest.ndjson private."
    );
  }
  const headerCapture = fullHdr ? fullHeaders : redactHeaders;
  // Full-header mode also disables body/query redaction (the operator has opted
  // into a sensitive harvest and the warning above says to keep it private).
  const redactSensitive = !fullHdr;

  const append: Append = (obj) => {
    stream.write(`${JSON.stringify(obj)}\n`);
  };

  const browser = await chromium.launch({
    headless: process.env.HEADLESS === "1",
    channel: process.env.CHROME_CHANNEL
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  page.on("requestfinished", (request) => {
    void (async () => {
      const response = await request.response();
      await logRequestResponse(request, response, append, headerCapture, redactSensitive);
    })();
  });

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`\nStopping (${reason})…`);
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await new Promise<void>((resolve, reject) => {
      stream.end((err) => (err ? reject(err) : resolve()));
    });
    console.log("Wrote log to", OUT_FILE);
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  rl.on("SIGINT", () => {
    rl.close();
  });

  console.log("Navigating to", START_URL);
  console.log("Log in and use the app. NDJSON →", OUT_FILE);
  await page.goto(START_URL, { waitUntil: "domcontentloaded" });

  console.log("Press Enter in this terminal to stop (or Ctrl+C).");
  let stopReason = "Enter";
  try {
    await rl.question("");
  } catch {
    stopReason = "Ctrl+C or closed input";
  } finally {
    rl.close();
  }

  await shutdown(stopReason);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

/** One admission's external-read budget, shared by discovery and repair proof.
 * The ordinary GITHUB_TOKEN baseline is 1,000 requests/hour/repository. Spend at
 * most 20% on admission and retain 100 for other consumers. Native response
 * headers must still prove capacity; this is not a reservation against races or
 * a guarantee against GitHub's additional, partly unpublished secondary limits.
 */
export const MAX_ADMISSION_READS = 200;
export const ADMISSION_RESERVE = 100;
export const ADMISSION_TIMEOUT_MS = 120_000;
export const READ_TIMEOUT_MS = 10_000;

function fail(message) {
  throw new Error(`build publication history: ${message}`);
}

// Pre-fetch validation refusals are static operator-visible reasons (missing
// token, bad path, non-GET). They carry no credential or signed URL, so they
// are marked and rethrown unchanged; fetch errors stay redacted below.
function failRefusal(message) {
  const error = new Error(`build publication history: ${message}`);
  error.admissionTransportRefusal = true;
  throw error;
}

function integerHeader(headers, name) {
  const raw = headers[name];
  if (typeof raw !== "string" || !/^(0|[1-9][0-9]*)$/.test(raw)) fail(`missing or malformed ${name}; NOT READY`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) fail(`malformed ${name}`);
  return value;
}

// Only content-addressed provider resources are reusable. Never cache a listing,
// current/terminal attempt, job, mutable tag ref, Release or expiring log URL.
// The full path keys repository, content kind and exact commit/object identity.
function immutablePath(path) {
  return /^\/repos\/[^/]+\/[^/]+\/(?:contents\/\.github\/workflows\/ci\.yml\?ref=[0-9a-f]{40}|git\/tags\/[0-9a-f]{40})$/.test(path);
}

export function createAdmissionReader(api) {
  if (!api || typeof api.request !== "function") fail("history provider transport required");
  const started = performance.now();
  const cache = new Map();
  let reads = 0;
  let remaining = null;
  let refusal = null;

  function assertAdmissionDeadline() {
    if (performance.now() - started >= ADMISSION_TIMEOUT_MS) fail("admission time budget exceeded; NOT READY");
  }

  async function read(path) {
    if (refusal) throw refusal;
    try {
      const timeLeft = ADMISSION_TIMEOUT_MS - (performance.now() - started);
      if (timeLeft <= 0) fail("admission time budget exceeded; NOT READY");
      if (cache.has(path)) return structuredClone(cache.get(path));
      if (reads >= MAX_ADMISSION_READS) fail("history read budget exceeded; NOT READY");
      if (remaining !== null && remaining < MAX_ADMISSION_READS - reads + ADMISSION_RESERVE) {
        fail("insufficient provider read budget; NOT READY");
      }
      reads += 1; // Count dispatches, including errors/timeouts. No retries.
      const dispatched = performance.now();
      const controller = new AbortController();
      let timer;
      let response;
      try {
        response = await Promise.race([
          api.request("GET", path, { signal: controller.signal }),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error("provider read timed out; NOT READY"));
            }, Math.min(READ_TIMEOUT_MS, timeLeft));
          })
        ]);
      } catch (error) {
        if (error && error.admissionTransportRefusal) throw error;
        // Never echo a transport error: it can contain a token or signed URL.
        fail("provider read failed or timed out; NOT READY");
      } finally {
        clearTimeout(timer);
      }
      // Decoding can block the event loop past a timer's deadline. A resolved
      // request must not win the race merely because its overdue timer ran late.
      if (performance.now() - dispatched >= READ_TIMEOUT_MS) fail("provider read time budget exceeded; NOT READY");
      if (!response || typeof response !== "object") fail("malformed provider envelope");
      const headers = response.headers;
      if (response.status === 403 || response.status === 429) fail(`provider rate limit or access refusal (${response.status}); NOT READY`);
      if (!headers || typeof headers !== "object") fail("provider rate metadata missing; NOT READY");
      // Any Retry-After signal is a refusal, including malformed values. Never
      // sleep to reset or reinterpret a throttled response as empty history.
      if (headers["retry-after"] !== undefined) fail("provider retry-after refusal; NOT READY");
      if (response.status !== 200) fail(`provider returned status ${String(response.status)}; NOT READY`);
      const limit = integerHeader(headers, "x-ratelimit-limit");
      const available = integerHeader(headers, "x-ratelimit-remaining");
      const used = integerHeader(headers, "x-ratelimit-used");
      const reset = integerHeader(headers, "x-ratelimit-reset");
      const now = Math.floor(Date.now() / 1000);
      if (headers["x-ratelimit-resource"] !== "core" || limit === 0 || available > limit
        || used > limit || used !== limit - available || reset <= now || reset > now + 3660) fail("invalid provider rate metadata; NOT READY");
      // A window rollover or concurrent users cannot grow this admission's
      // allowance. Decrement our own observation even if headers repeat/increase.
      remaining = Math.min(remaining === null ? available : remaining - 1, available);
      if (remaining < MAX_ADMISSION_READS - reads + ADMISSION_RESERVE) fail("insufficient provider read budget; NOT READY");
      assertAdmissionDeadline();
      const result = { data: response.data, headers };
      if (immutablePath(path)) cache.set(path, structuredClone(result));
      return result;
    } catch (error) {
      refusal = error; // A failed admission cannot be resumed with cached proof.
      throw error;
    }
  }
  // The aggregate deadline also bounds synchronous proof validation after the
  // last GET. Callers assert this same admission-local deadline after final
  // validation, immediately before success, with no extra GET (no reset).
  read.assertWithinAdmissionDeadline = assertAdmissionDeadline;
  return read;
}

/** No hidden fetch redirects/retries: every invocation is exactly one GET. */
export function githubTransport(token) {
  return {
    async request(method, path, { signal } = {}) {
      if (method !== "GET") failRefusal("history admission is read-only");
      if (typeof token !== "string" || token.length === 0) failRefusal("GitHub token required for history admission");
      if (typeof path !== "string" || !path.startsWith("/repos/") || path.includes("#")) failRefusal("invalid provider path");
      const response = await fetch(`https://api.github.com${path}`, {
        method, signal, redirect: "manual",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "routeware-shadow-api-build-admission"
        }
      });
      const headers = Object.fromEntries(response.headers.entries());
      // Refuse redirects without consuming a signed/foreign destination. GitHub
      // log-download redirects currently make that repair path NOT READY.
      if (response.status !== 200) {
        await response.body?.cancel();
        return { status: response.status, headers, data: null };
      }
      const text = await response.text();
      if (/\/actions\/jobs\/[1-9][0-9]*\/logs$/.test(path)) return { status: response.status, headers, data: text };
      let data = null;
      try { data = JSON.parse(text); } catch { /* Admission rejects malformed proof. */ }
      return { status: response.status, headers, data };
    }
  };
}

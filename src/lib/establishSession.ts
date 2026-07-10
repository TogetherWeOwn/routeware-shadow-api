import { establishSessionWithBrowser } from "./browserAuth";
import { establishSessionViaHttp } from "./httpAuth";

/**
 * Establish a Routeware session, choosing the method by `AUTH_MODE`:
 *   - "http"    → HTTP form login only (no browser).
 *   - "browser" → Browser Rendering login only.
 *   - "auto"    → (default) HTTP login, falling back to the browser on failure.
 *
 * The HTTP path is far cheaper/faster than Browser Rendering; the browser stays
 * as a resilient fallback in case the login markup or anti-forgery flow changes.
 */
export async function establishSession(
  env: Env,
  stub: DurableObjectStub,
  bootstrapUrl: string
): Promise<void> {
  const mode = ((env as Env & { AUTH_MODE?: string }).AUTH_MODE ?? "auto")
    .trim()
    .toLowerCase();

  if (mode === "browser") {
    return establishSessionWithBrowser(env, stub, bootstrapUrl);
  }

  try {
    await establishSessionViaHttp(env, stub);
    return;
  } catch (err) {
    if (mode === "http") {
      throw err;
    }
    console.warn(
      "HTTP auth failed; falling back to Browser Rendering:",
      err instanceof Error ? err.message : String(err)
    );
    return establishSessionWithBrowser(env, stub, bootstrapUrl);
  }
}

import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../routes/types";

/** Deployment metadata only; the API contract version remains APP_VERSION. */
export function parseBuildVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^([1-9][0-9]{3})\.([1-9][0-9]{2,3})\.(0|[1-9][0-9]*)$/.exec(value);
  if (!match || match[0] !== value || !Number.isSafeInteger(Number(match[3]))) return null;
  const month = match[2]!.slice(0, -2);
  const day = match[2]!.slice(-2);
  const date = `${match[1]}-${month.padStart(2, "0")}-${day}`;
  const time = new Date(`${date}T00:00:00.000Z`);
  return Number.isFinite(time.getTime()) && time.toISOString().slice(0, 10) === date
    ? value
    : null;
}

/** Decorate the existing gate without moving it behind another middleware. */
export function withBuildVersion(
  handler: MiddlewareHandler<AppEnv> = async (_, next) => { await next(); }
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const response = await handler(c, next);
    if (response) c.res = response;
    // Discovery needs no deployment binding; do not read an absent property.
    const value = c.env && Object.hasOwn(c.env, "BUILD_VERSION")
      ? c.env.BUILD_VERSION
      : undefined;
    // Context assignment merges old headers; its native API also strips spoofs.
    c.header("X-Build-Version", parseBuildVersion(value) ?? undefined);
    return c.res;
  };
}

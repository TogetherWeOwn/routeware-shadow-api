type SessionState = {
  cookieHeader: string | null;
  expiresAtMs: number | null;
  refreshing: boolean;
};

/**
 * Auto-expire a held lock after this long so a refresh that crashed without
 * unlocking cannot wedge authentication forever. Must exceed a worst-case
 * browser login.
 */
const LOCK_TTL_MS = 120_000;

export class AuthSession {
  constructor(
    private readonly state: DurableObjectState,
    _env: Env
  ) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/get") {
      const data: SessionState = {
        cookieHeader: (await this.state.storage.get("cookieHeader")) ?? null,
        expiresAtMs: (await this.state.storage.get("expiresAtMs")) ?? null,
        refreshing: (await this.state.storage.get("refreshing")) ?? false
      };
      return Response.json(data);
    }

    if (url.pathname === "/set") {
      const body = await req.json() as {
        cookieHeader: string;
        expiresAtMs: number;
      };

      await this.state.storage.put("cookieHeader", body.cookieHeader);
      await this.state.storage.put("expiresAtMs", body.expiresAtMs);
      await this.state.storage.put("refreshing", false);
      await this.state.storage.delete("lockedAt");
      return new Response("OK");
    }

    if (url.pathname === "/lock") {
      const refreshing = await this.state.storage.get<boolean>("refreshing");
      const lockedAt = await this.state.storage.get<number>("lockedAt");
      const now = Date.now();
      // Treat a lock older than LOCK_TTL_MS as stale (holder likely crashed).
      const heldAndFresh =
        refreshing === true &&
        typeof lockedAt === "number" &&
        now - lockedAt < LOCK_TTL_MS;
      if (heldAndFresh) {
        return new Response("LOCKED", { status: 423 });
      }
      await this.state.storage.put("refreshing", true);
      await this.state.storage.put("lockedAt", now);
      return new Response("OK");
    }

    if (url.pathname === "/unlock") {
      await this.state.storage.put("refreshing", false);
      await this.state.storage.delete("lockedAt");
      return new Response("OK");
    }

    return new Response("Not Found", { status: 404 });
  }
}

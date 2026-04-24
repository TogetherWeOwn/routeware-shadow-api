type SessionState = {
  cookieHeader: string | null;
  expiresAtMs: number | null;
  refreshing: boolean;
};

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
      return new Response("OK");
    }

    if (url.pathname === "/lock") {
      if (await this.state.storage.get("refreshing")) {
        return new Response("LOCKED", { status: 423 });
      }
      await this.state.storage.put("refreshing", true);
      return new Response("OK");
    }

    if (url.pathname === "/unlock") {
      await this.state.storage.put("refreshing", false);
      return new Response("OK");
    }

    return new Response("Not Found", { status: 404 });
  }
}

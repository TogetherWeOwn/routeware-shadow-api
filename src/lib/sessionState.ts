export type SessionState = {
  cookieHeader: string | null;
  expiresAtMs: number | null;
  refreshing: boolean;
};

export async function readSessionState(
  stub: DurableObjectStub
): Promise<SessionState> {
  const response = await stub.fetch("https://auth/get");
  return response.json() as Promise<SessionState>;
}

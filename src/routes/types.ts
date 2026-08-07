/**
 * Context types shared by every route module.
 *
 * `Variables` is populated by the body-buffer middleware in `app.ts`: the
 * request body is read once there (the stream can only be consumed once) and
 * the `AuthSession` Durable Object stub is resolved per request.
 */
export type Variables = {
  bodyBuffer: ArrayBuffer | null;
  sessionStub: DurableObjectStub;
};

/** Generic parameter shared by the root app and every mounted route module. */
export type AppEnv = { Bindings: Env; Variables: Variables };

# Structured application logs

Application code writes one structured log event through `logEvent` in `src/lib/logger.ts`. Each event has the same fields:

- `level`: `info`, `warn`, or `error`
- `msg`: a stable, human-readable event summary
- `route`: a static route or operation label; do not include request values or identifiers
- `ms`: elapsed milliseconds when measured, otherwise `null`

Additional context is limited to the fields declared by `LogEventInput`; unknown keys are dropped at runtime, and nested values are accepted only for the validated per-table aggregate counts. Callers must still pass only fixed or allowlisted values — never request payloads, business/customer identifiers, raw exceptions, or customer data. Failure records that need a cause pass `kind: errorKind(err)`: the class name of the innermost error in its `cause` chain whose class is not the generic `Error` (`Error` when none is named), never its message (for example `ChainedHttpError`, `ChainedTimeoutError`, `SnapshotForeignKeyError` or `SessionCookiesMissing`). The one exception-derived string in a record is the R2 archive `reason` at `tables.<table>.r2.reason`, which carries the R2 driver's message.

Example fail-open event:

```json
{"level":"error","msg":"AUTH THROTTLE FAIL-OPEN","route":"authThrottle.failOpen","ms":null,"reason":"do_error"}
```

Log stable summaries only. Do not pass exception objects, exception messages, request bodies, credentials, or customer data; those values can contain sensitive information. The helper dispatches at the matching console severity while passing the event object so Cloudflare Workers Logs can index its fields. Cloudflare recommends logging JSON objects for searchable fields and supports `console.info`, `console.warn`, and `console.error` in Workers:

- [Workers Logs: structured JSON logging](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Workers Console API](https://developers.cloudflare.com/workers/runtime-apis/console/)

`npm run lint` parses TypeScript under `src/` and rejects direct `console.*` access. The severity dispatch in `src/lib/logger.ts` is the only permitted console call.

## Detail-full sync D1 op-budget utilization

Every successful `syncCustomerDetailFullToD1` run (`src/lib/detailFullSync.ts`) emits exactly one `info` line so operators can see D1 op-budget headroom. Over-budget runs throw fail-closed before the first write and emit no line.

- `msg`: `Detail-full sync D1 op-budget utilization`
- `route`: `sync.detailFull`
- `customerId`: the synced customer id (a numeric internal key, never customer payload data)
- `addressCount` / `containerCount`: the graph shape that was synced
- `d1Ops`: `detailFullD1Ops(addressCount, containerCount)` for the run
- `d1OpsBudget`: `DETAIL_FULL_MAX_D1_OPS`
- `cacheInvalidations`: `detailFullCacheInvalidations(addressCount, containerCount)`
- `cacheInvalidationBudget`: `DETAIL_FULL_MAX_CACHE_INVALIDATIONS`

```json
{"level":"info","msg":"Detail-full sync D1 op-budget utilization","route":"sync.detailFull","ms":null,"customerId":5,"addressCount":3,"containerCount":2,"d1Ops":3,"d1OpsBudget":900,"cacheInvalidations":6,"cacheInvalidationBudget":950}
```

Pinned by `test/detailFullOpBudgetUtilization.test.ts`.

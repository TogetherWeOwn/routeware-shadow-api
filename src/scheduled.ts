import {
  runDataSnapshotSync,
  runDataSnapshotSyncChainedHttp
} from "./lib/d1SnapshotSync";

export async function scheduled(
  _controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  void _controller;
  ctx.waitUntil(
    (async () => {
      try {
        const publicBase = env.SHADOW_API_PUBLIC_BASE?.trim();
        const r = publicBase
          ? await runDataSnapshotSyncChainedHttp(publicBase, env)
          : await runDataSnapshotSync(env);
        if (!publicBase) {
          console.warn(
            "data snapshot: SHADOW_API_PUBLIC_BASE is unset; cron uses a single invocation and may hit D1 per-invocation limits. Set it to this Worker URL (e.g. https://name.workers.dev)."
          );
        }
        const c = r.customer
          ? `customer: ${r.customer.upserted} upserted, ${r.customer.rowCount} rows; `
          : "";
        const a = r.address
          ? `address: ${r.address.upserted} upserted, ${r.address.rowCount} rows; `
          : "";
        const t = r.container
          ? `container: ${r.container.upserted} upserted, ${r.container.rowCount} rows`
          : "";
        if (c || a || t) {
          console.log(`data snapshot sync: ${c}${a}${t}`);
        } else {
          console.log("data snapshot sync: no report paths configured");
        }
      } catch (e) {
        console.error("scheduled data snapshot sync failed", e);
      }
    })()
  );
}

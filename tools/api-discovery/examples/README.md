# Example request bodies (shadow API / `wrangler dev`)

These files are **starting points** for `route-map.json` and curl export. Your tenant may require different fields; prefer bodies from **`out/harvest.ndjson`** after recording.

- **`customers-read.post.example.json`** — non-empty `filter` (avoids “You need to filter.”).
- **`get-customer-detail-full.post.example.json`** — set `CustomerID` to a real id.
- **`app-settings-get.post.example.json`** — common `appSettingsGet` body.
- **`save-customer-long-form.post.example.urlencoded`** — Ext.NET/MVC **create or update** (`SaveCustomerLongForm`). The Worker normally **injects** `__RequestVerificationToken` using the Routeware session (omit the field or use a placeholder). `CustomerID=0` for create; set `CustomerID` for update. Use `Enabled=false` to disable instead of delete. Set `CUSTOMER_SAVE_AUTO_TOKEN=false` to require a real token from the client.
- **`customer-types-read.post.example.urlencoded`** — `EnabledOnly=true` for customer type dropdowns.

## After recording

```bash
npm run discovery:process
# or: cd tools/api-discovery && npm run process
```

That writes **`out/curl-examples.sh`** using recorded bodies when present, otherwise these files.

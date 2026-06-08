// One-off diagnostic: read live schema via PostgREST OpenAPI root.
// Usage: node scripts/diag-live-schema-access.mjs [table ...]
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = readFileSync(resolve(__dirname, "..", ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const url = get("NEXT_PUBLIC_SUPABASE_URL");
const key = get("SUPABASE_SERVICE_ROLE_KEY");

const res = await fetch(`${url}/rest/v1/`, {
  headers: { apikey: key, Authorization: `Bearer ${key}` },
});
console.log("[0] OpenAPI root status:", res.status);
if (!res.ok) process.exit(1);
const spec = await res.json();

const defs = spec.definitions ?? {};
const names = Object.keys(defs).sort();
console.log(`[1] exposed relations in 'public': ${names.length}`);

const detail = process.argv.slice(2);
if (!detail.length) {
  for (const n of names) console.log("  " + n);
} else {
  for (const t of detail) {
    const d = defs[t];
    if (!d) { console.log(`\n[${t}] NOT FOUND`); continue; }
    const req = new Set(d.required ?? []);
    console.log(`\n[${t}] (${Object.keys(d.properties ?? {}).length} cols):`);
    for (const [col, p] of Object.entries(d.properties ?? {})) {
      const pg = p.format ?? p.type;
      console.log(`  ${col}\t${pg}\t${req.has(col) ? "not null" : "nullable"}${p.description?.includes("Primary Key") ? "\tPK" : ""}`);
    }
  }
}

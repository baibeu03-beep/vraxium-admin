// One-off diagnostic: list 2026-winter W1~W8 from live DB (PostgREST direct).
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = readFileSync(resolve(__dirname, "..", ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const url = get("NEXT_PUBLIC_SUPABASE_URL");
const key = get("SUPABASE_SERVICE_ROLE_KEY");

const headers = { apikey: key, Authorization: `Bearer ${key}` };

// 1) discover season keys containing winter
const seasonsRes = await fetch(
  `${url}/rest/v1/weeks?select=season_key&order=season_key`,
  { headers: { ...headers, Prefer: "count=exact" } }
);
const allRows = await seasonsRes.json();
const keys = [...new Set(allRows.map((r) => r.season_key))];
console.log("[0] distinct season_key in weeks:", JSON.stringify(keys));

const winterKeys = keys.filter((k) => k && k.toLowerCase().includes("winter"));
console.log("[1] winter-like keys:", JSON.stringify(winterKeys));

for (const sk of winterKeys) {
  const res = await fetch(
    `${url}/rest/v1/weeks?season_key=eq.${encodeURIComponent(sk)}&order=week_number&select=*`,
    { headers }
  );
  console.log(`\n[2] weeks for season_key=${sk} (status ${res.status}):`);
  const rows = await res.json();
  for (const w of rows) {
    console.log(JSON.stringify(w));
  }
}

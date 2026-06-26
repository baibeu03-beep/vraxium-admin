// 검증: 고객 weekly-growth 현재시즌 휴식 = 시즌 스코프(user_season_statuses) — direct(DB) == HTTP.
//   node scripts/verify-customer-weekly-growth-season.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(get("NEXT_PUBLIC_SUPABASE_URL"), get("SUPABASE_SERVICE_ROLE_KEY"));
const CUST = "http://localhost:3001";
let fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

// 현재 시즌 season_key
const today = new Date().toISOString().slice(0, 10);
const { data: wk } = await sb.from("weeks").select("season_key").lte("start_date", today).gte("end_date", today).order("start_date", { ascending: false }).limit(1).maybeSingle();
const curKey = wk?.season_key ?? null;
console.log(`현재 시즌=${curKey} (오늘=${today})`);

// 샘플: 전현성(여름-only 휴식·봄활동), 강지원(봄 휴식), 현유빈(봄활동·여름휴식)
const samples = [
  { name: "전현성", org: "oranke" },
  { name: "강지원", org: "encre" },
  { name: "현유빈", org: "encre" },
];

for (const s of samples) {
  const { data: prof } = await sb.from("user_profiles").select("user_id,growth_status").eq("organization_slug", s.org).eq("display_name", s.name).limit(1).maybeSingle();
  if (!prof) { ck(`${s.name} 프로필`, false, "없음"); continue; }
  const uid = prof.user_id;
  // direct: 현재 시즌 휴식 여부(시즌 스코프)
  const { data: ss } = await sb.from("user_season_statuses").select("status").eq("user_id", uid).eq("season_key", curKey).eq("status", "rest").limit(1);
  const directRest = (ss?.length ?? 0) > 0;
  // HTTP
  const res = await fetch(`${CUST}/api/cluster4/weekly-growth?userId=${uid}`);
  const j = await res.json();
  const label = j?.data?.seasonSummary?.statusLabel ?? "(none)";
  const httpRest = label === "시즌 휴식";
  console.log(`  ${s.name}(${uid.slice(0,8)}) growth=${prof.growth_status} | 현재시즌휴식(direct)=${directRest} | HTTP statusLabel="${label}"`);
  ck(`${s.name}: direct 휴식==HTTP 휴식 (시즌 스코프 일치)`, directRest === httpRest, `direct=${directRest} http=${httpRest}`);
}

console.log("─".repeat(64));
console.log(fail === 0 ? "✅ 고객 weekly-growth 시즌 스코프 direct==HTTP PASS" : `❌ ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);

// 2026-winter 휴식주 legacy 정정 적용기 (PostgREST, service role).
//   db/migrations/2026-06-05_winter_rest_week_sot_fix.sql 과 동일 변경.
//   기본 dry-run. 실제 적용은 --apply.
//     node scripts/apply-winter-rest-week-sot-fix.mjs [--apply]
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const APPLY = process.argv.includes("--apply");
const __dirname = dirname(fileURLToPath(import.meta.url));
const env = readFileSync(resolve(__dirname, "..", ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const url = get("NEXT_PUBLIC_SUPABASE_URL");
const key = get("SUPABASE_SERVICE_ROLE_KEY");
const H = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
};

async function rest(method, path, body) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

// ── §1 사전 확인 + 가드 ──────────────────────────────────────────────────
const weeks = await rest(
  "GET",
  "weeks?season_key=eq.2026-winter&week_number=in.(5,8)&select=id,week_number,start_date,end_date,is_official_rest,holiday_name&order=week_number",
);
const w5 = weeks.find((w) => w.week_number === 5);
const w8 = weeks.find((w) => w.week_number === 8);
console.log("[1-1] W5:", JSON.stringify(w5));
console.log("[1-1] W8:", JSON.stringify(w8));

const orw = await rest(
  "GET",
  "official_rest_weeks?year=eq.2026&select=id,year,week_number,reason&order=week_number",
);
console.log("[1-2] official_rest_weeks(2026):", JSON.stringify(orw));

const periods = await rest(
  "GET",
  "official_rest_periods?is_active=eq.true&start_date=lte.2026-02-22&end_date=gte.2026-02-16&select=name,start_date,end_date,is_active",
);
console.log("[1-3] official_rest_periods overlap W8:", JSON.stringify(periods));

// 가드 (멱등 재실행 차단)
if (!w5 || !w8) throw new Error("중단: W5/W8 행을 찾지 못함");
if (w5.is_official_rest !== true || w8.is_official_rest !== false) {
  throw new Error(
    `중단: 현재값 기대(W5=true, W8=false)와 다름 (W5=${w5.is_official_rest}, W8=${w8.is_official_rest}) — 이미 적용?`,
  );
}
const orw5 = orw.find((r) => r.week_number === 5);
if (!orw5) throw new Error("중단: official_rest_weeks(2026,5) 부재");
if (orw.some((r) => r.week_number === 8))
  throw new Error("중단: official_rest_weeks(2026,8) 이미 존재 — UNIQUE 충돌 위험");
if (periods.length !== 1)
  throw new Error(`중단: W8 overlap 활성 휴식기간 기대 1건, 실제 ${periods.length}건`);

console.log("\n[가드 통과] 변경 예정:");
console.log(`  weeks ${w5.id} (W5): is_official_rest true→false, holiday_name '${w5.holiday_name}'→null`);
console.log(`  weeks ${w8.id} (W8): is_official_rest false→true, holiday_name null→'설 연휴'`);
console.log(`  official_rest_weeks id=${orw5.id}: week_number 5→8`);

if (!APPLY) {
  console.log("\nDRY-RUN — 변경 없음. 적용하려면 --apply.");
  process.exit(0);
}

// ── §2 적용 ──────────────────────────────────────────────────────────────
const u1 = await rest("PATCH", `weeks?id=eq.${w5.id}&is_official_rest=is.true`, {
  is_official_rest: false,
  holiday_name: null,
  updated_at: new Date().toISOString(),
});
if (u1.length !== 1) throw new Error(`W5 갱신 행수 기대 1, 실제 ${u1.length}`);
console.log("[2-1] W5 →", JSON.stringify({ is_official_rest: u1[0].is_official_rest, holiday_name: u1[0].holiday_name }));

const u2 = await rest("PATCH", `weeks?id=eq.${w8.id}&is_official_rest=is.false`, {
  is_official_rest: true,
  holiday_name: "설 연휴",
  updated_at: new Date().toISOString(),
});
if (u2.length !== 1) throw new Error(`W8 갱신 행수 기대 1, 실제 ${u2.length}`);
console.log("[2-2] W8 →", JSON.stringify({ is_official_rest: u2[0].is_official_rest, holiday_name: u2[0].holiday_name }));

const u3 = await rest(
  "PATCH",
  `official_rest_weeks?id=eq.${orw5.id}&week_number=eq.5`,
  { week_number: 8 },
);
if (u3.length !== 1) throw new Error(`official_rest_weeks 갱신 행수 기대 1, 실제 ${u3.length}`);
console.log("[2-3] official_rest_weeks →", JSON.stringify(u3[0]));

// ── §3 사후 검증 ─────────────────────────────────────────────────────────
const after = await rest(
  "GET",
  "weeks?season_key=eq.2026-winter&select=week_number,start_date,end_date,is_official_rest,holiday_name&order=week_number",
);
console.log("\n[3-1] winter 전체 (정정 후):");
for (const w of after) console.log("  " + JSON.stringify(w));
const restWeeks = after.filter((w) => w.is_official_rest);
if (restWeeks.length !== 1 || restWeeks[0].week_number !== 8) {
  throw new Error(`검증 실패: 휴식 플래그 주차 기대 [8], 실제 ${JSON.stringify(restWeeks.map((w) => w.week_number))}`);
}
console.log("\n✅ 적용 + 검증 완료: W5=정상, W8=공식 휴식(설 연휴), 휴식 플래그 단 1건.");

// One-off diagnostic (read-only): growth_status 수동값 vs 자동 계산 expectedGrowthStatus 전수 대조 (2026-06-07)
// Usage: node scripts/diag-growth-status-auto-audit.mjs
//
// 자동 계산 후보 규칙(제안 — growthCore.resolveGrowthStatus 의 계산 분기 + 수동 3종 분리):
//   [manual] graduated / suspended / paused          → 운영 선언 (이벤트 원천 없음)
//   [auto]   seasonal_rest  = user_season_statuses(status='rest', season_key=현재시즌)
//   [auto]   weekly_rest    = user_week_statuses(현재 ISO 주차, status='personal_rest')
//   [auto]   official_rest  = 현재 주차가 공식휴식 (weeks.is_official_rest ∨ official_rest_periods overlap)
//   [auto]   onboarding     = h <= 1
//   [auto]   graduating/extra_growth = a >= org threshold (미졸업)
//   [auto]   active         = default
// 근사치 주의: a ≈ user_growth_stats.approved_weeks, h ≈ user_growth_stats.cumulative_weeks
//   (화면 SoT 는 snapshot 카드 fold — 미공표 tallying 제외/verdict flip 반영이라 약간 다를 수 있음)
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = readFileSync(resolve(__dirname, "..", ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const url = get("NEXT_PUBLIC_SUPABASE_URL");
const key = get("SUPABASE_SERVICE_ROLE_KEY");

async function qAll(path) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${url}/rest/v1/${path}${path.includes("?") ? "&" : "?"}limit=1000&offset=${from}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) { console.log(`  !! ${path} -> ${res.status}`, JSON.stringify(body).slice(0, 200)); break; }
    out.push(...body);
    if (body.length < 1000) break;
  }
  return out;
}

const THRESH = { oranke: 25, encre: 30, phalanx: 30 };
const todayIso = "2026-06-07"; // 실행일 (KST 기준 점검일)

// ── 원천 로딩 ────────────────────────────────────────────────────────
const [profiles, gstats, markers, sdefs, weeks, restPeriods] = await Promise.all([
  qAll("user_profiles?select=user_id,display_name,growth_status,status,organization_slug,activity_started_at,activity_ended_at"),
  qAll("user_growth_stats?select=user_id,approved_weeks,cumulative_weeks"),
  qAll("test_user_markers?select=user_id"),
  qAll("season_definitions?select=season_key,season_type,start_date,end_date"),
  qAll("weeks?select=id,start_date,end_date,season_key,week_number,is_official_rest"),
  qAll("official_rest_periods?select=id,start_date,end_date,is_active"),
]);
console.log(`profiles=${profiles.length} gstats=${gstats.length} testers=${markers.length} weeks=${weeks.length} restPeriods=${restPeriods.length}`);

const gmap = new Map(gstats.map((g) => [g.user_id, g]));
const testerIds = new Set(markers.map((m) => m.user_id));

// ── 현재 시즌 / 현재 주차 판정 ──────────────────────────────────────
const curSeason = sdefs.find((s) => s.start_date?.slice(0, 10) <= todayIso && todayIso <= s.end_date?.slice(0, 10)) ?? null;
console.log(`현재 시즌: ${curSeason ? `${curSeason.season_key} (${curSeason.start_date?.slice(0,10)}~${curSeason.end_date?.slice(0,10)})` : "(없음)"}`);

const curWeek = weeks.find((w) => w.start_date <= todayIso && (w.end_date ?? w.start_date) >= todayIso) ?? null;
const curWeekOfficialByPeriod = restPeriods.some(
  (p) => p.is_active !== false && p.start_date?.slice(0, 10) <= todayIso && todayIso <= p.end_date?.slice(0, 10),
);
const curWeekOfficial = Boolean(curWeek?.is_official_rest) || curWeekOfficialByPeriod;
console.log(`현재 주차: ${curWeek ? `${curWeek.season_key} W${curWeek.week_number} (${curWeek.start_date}~${curWeek.end_date}) official_rest=${curWeek.is_official_rest}` : "(weeks 행 없음)"} | rest_period overlap=${curWeekOfficialByPeriod} → 공식휴식=${curWeekOfficial}`);

// 현재 ISO 주차 (uws year/week_number 매칭용)
function isoWeekOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}
const { year: curYear, week: curIsoWeek } = isoWeekOf(todayIso);
console.log(`현재 ISO 주차: ${curYear}-W${curIsoWeek}`);

// 현재 주차 uws (개인휴식 신청 여부)
const curUws = await qAll(`user_week_statuses?select=user_id,status&year=eq.${curYear}&week_number=eq.${curIsoWeek}`);
const curUwsMap = new Map(curUws.map((r) => [r.user_id, r.status]));
console.log(`현재 주차 uws rows: ${curUws.length}`);

// 현재 시즌 시즌휴식 신청
const curSeasonRest = curSeason
  ? await qAll(`user_season_statuses?select=user_id,status&season_key=eq.${encodeURIComponent(curSeason.season_key)}&status=eq.rest`)
  : [];
const seasonRestIds = new Set(curSeasonRest.map((r) => r.user_id));
console.log(`현재 시즌 휴식 신청(uss status=rest): ${curSeasonRest.length}`);

// ── expected 계산 ────────────────────────────────────────────────────
function computeExpected(p) {
  const g = gmap.get(p.user_id);
  const a = g?.approved_weeks ?? 0;
  const h = g?.cumulative_weeks ?? 0;
  const th = THRESH[p.organization_slug] ?? null;
  // 수동 3종은 그대로 인정 (override 로 분리될 후보)
  if (p.growth_status === "graduated") return { key: "graduated", manual: true, a, h, th };
  if (p.growth_status === "suspended") return { key: "suspended", manual: true, a, h, th };
  if (p.growth_status === "paused") return { key: "paused", manual: true, a, h, th };
  // 자동 계산 분기
  if (seasonRestIds.has(p.user_id)) return { key: "seasonal_rest", manual: false, a, h, th };
  if (curUwsMap.get(p.user_id) === "personal_rest") return { key: "weekly_rest", manual: false, a, h, th };
  if (curWeekOfficial) return { key: "official_rest", manual: false, a, h, th };
  if (h <= 1) return { key: "onboarding", manual: false, a, h, th };
  if (th !== null && a >= th) return { key: "threshold_met", manual: false, a, h, th }; // graduating|extra_growth 후보
  return { key: "active", manual: false, a, h, th };
}

// ── 대조 ────────────────────────────────────────────────────────────
const rows = [];
for (const p of profiles) {
  const exp = computeExpected(p);
  rows.push({
    userId: p.user_id,
    name: p.display_name,
    org: p.organization_slug,
    tester: testerIds.has(p.user_id),
    db: p.growth_status,
    accountStatus: p.status,
    expected: exp.key,
    a: exp.a, h: exp.h, th: exp.th,
    endedAt: p.activity_ended_at?.slice(0, 10) ?? null,
  });
}

function dump(title, list, fmt) {
  console.log(`\n=== ${title} — ${list.length}건 ===`);
  for (const r of list.slice(0, 30)) console.log("  " + fmt(r));
  if (list.length > 30) console.log(`  ... 외 ${list.length - 30}건`);
}

const f = (r) => `${r.tester ? "[T]" : "[실]"} ${r.name} (${r.org ?? "?"}) db=${r.db ?? "NULL"} → expected=${r.expected} (a=${r.a}/th=${r.th ?? "-"} h=${r.h})${r.endedAt ? ` ended=${r.endedAt}` : ""}`;

// A. graduated/graduating 인데 임계 미달
dump("A. db=graduated 인데 a < threshold (졸업인데 기준 미달)",
  rows.filter((r) => r.db === "graduated" && r.th !== null && r.a < r.th), f);
dump("B. db=graduating 인데 a < threshold (절차 중인데 기준 미달 — 보고된 19주 케이스)",
  rows.filter((r) => r.db === "graduating" && r.th !== null && r.a < r.th), f);
// C. 임계 충족인데 졸업 계열 아님
dump("C. a >= threshold 인데 db ∉ {graduated,graduating,suspended,paused} (자동이면 graduating/extra_growth)",
  rows.filter((r) => r.th !== null && r.a >= r.th && !["graduated", "graduating", "suspended", "paused"].includes(r.db)), f);
// D. weekly_rest 프로필 vs 현재주차 개인휴식 불일치
dump("D. db=weekly_rest 인데 현재주차 uws ≠ personal_rest (주차 지나도 프로필 방치)",
  rows.filter((r) => r.db === "weekly_rest" && r.expected !== "weekly_rest"), f);
dump("E. 현재주차 personal_rest 신청인데 db ≠ weekly_rest (신청했는데 프로필 미반영)",
  rows.filter((r) => r.expected === "weekly_rest" && r.db !== "weekly_rest"), f);
// F. seasonal_rest 양방향
dump("F. db=seasonal_rest 인데 현재시즌 휴식 신청 없음",
  rows.filter((r) => r.db === "seasonal_rest" && r.expected !== "seasonal_rest"), f);
dump("G. 현재시즌 휴식 신청인데 db ≠ seasonal_rest",
  rows.filter((r) => r.expected === "seasonal_rest" && r.db !== "seasonal_rest"), f);
// H. graduating 임계 충족 (정상 절차 중 — 참고)
dump("H. (참고) db=graduating 이고 a >= threshold (자동화 시에도 동일 표시 가능)",
  rows.filter((r) => r.db === "graduating" && r.th !== null && r.a >= r.th), f);
// I. activity_ended_at 정합
dump("I. activity_ended_at 있는데 db ∉ {graduated,suspended,paused}",
  rows.filter((r) => r.endedAt && !["graduated", "suspended", "paused"].includes(r.db)), f);
dump("J. db ∈ {graduated,suspended} 인데 activity_ended_at 없음",
  rows.filter((r) => !r.endedAt && ["graduated", "suspended"].includes(r.db)), f);
// K. NULL growth_status
dump("K. db=NULL (생성 경로 밖에서 만들어진 행)",
  rows.filter((r) => r.db === null), f);

// 요약 매트릭스
console.log("\n=== 요약: db × expected 매트릭스 (실사용자/테스터 분리) ===");
for (const tester of [false, true]) {
  const sub = rows.filter((r) => r.tester === tester);
  const m = new Map();
  for (const r of sub) {
    const k = `${r.db ?? "NULL"} → ${r.expected}`;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  console.log(`-- ${tester ? "테스터" : "실사용자"} (${sub.length}명)`);
  for (const [k, c] of [...m.entries()].sort()) console.log(`  ${k}: ${c}`);
}

writeFileSync(
  resolve(__dirname, "..", "claudedocs", "growth-status-auto-audit-20260607.json"),
  JSON.stringify({ generatedAt: todayIso, curSeason: curSeason?.season_key ?? null, curWeekOfficial, rows }, null, 2),
);
console.log("\nsaved: claudedocs/growth-status-auto-audit-20260607.json");

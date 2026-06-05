// One-off diagnostic: cluster3 클럽 강화 품계 — direct 계산 vs 운영 HTTP vs 프론트 demo 경로 비교.
// Usage: node scripts/diag-club-rank-verify.mjs [userId ...]
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = readFileSync(resolve(__dirname, "..", ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const url = get("NEXT_PUBLIC_SUPABASE_URL");
const key = get("SUPABASE_SERVICE_ROLE_KEY");
const internalKey = get("INTERNAL_API_KEY");
const ADMIN_BASE = process.env.DIAG_ADMIN_BASE ?? "https://vraxium-admin.vercel.app";
const FRONT_BASE = process.env.DIAG_FRONT_BASE ?? "https://vraxium.vercel.app";

async function qAll(path) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${url}/rest/v1/${path}${path.includes("?") ? "&" : "?"}limit=1000&offset=${from}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!r.ok) throw new Error(`${path} -> ${r.status}`);
    const b = await r.json();
    out.push(...b);
    if (b.length < 1000) break;
  }
  return out;
}

// ── direct 재현: lib/cluster3ClubRankData.ts getClubRank 와 동일 산식 ──
const RANK_GRADES = [
  [1, 10, "정승"], [11, 20, "정1품"], [21, 30, "정2품"], [31, 40, "정3품"], [41, 50, "정4품"],
  [51, 60, "정5품"], [61, 70, "정6품"], [71, 80, "정7품"], [81, 90, "정8품"], [91, 100, "정9품"],
];
const resolveGrade = (avg) => {
  const c = Math.ceil(avg);
  return RANK_GRADES.find(([lo, hi]) => c >= lo && c <= hi)?.[2] ?? "정9품";
};

const allPoints = await qAll(
  "user_weekly_points?select=user_id,year,week_number,points,advantages,penalty&order=year.asc,week_number.asc,user_id.asc",
);
const byWeek = new Map();
for (const r of allPoints) {
  const k = `${r.year}-${r.week_number}`;
  if (!byWeek.has(k)) byWeek.set(k, []);
  byWeek.get(k).push(r);
}

const uwsFirst = await qAll("user_week_statuses?select=user_id,year,week_number&order=year.asc,week_number.asc");
const firstWeekByUser = new Map();
for (const r of uwsFirst) if (!firstWeekByUser.has(r.user_id)) firstWeekByUser.set(r.user_id, r);

const profiles = await qAll("user_profiles?select=user_id,display_name,growth_status,organization_slug");
const profMap = new Map(profiles.map((p) => [p.user_id, p]));
const frozenRows = await qAll("user_club_rank_frozen?select=user_id,avg_percentile,rank_grade").catch(() => []);
const frozenMap = new Map(frozenRows.map((f) => [f.user_id, f]));

function directClubRank(userId) {
  const prof = profMap.get(userId);
  const frozen = frozenMap.get(userId);
  if (prof && (prof.growth_status === "graduated" || prof.growth_status === "suspended") && frozen) {
    return { avgPercentile: Number(frozen.avg_percentile), rankGrade: frozen.rank_grade, isFrozen: true };
  }
  const fw = firstWeekByUser.get(userId) ?? null;
  const details = [];
  for (const [, rows] of byWeek) {
    const scored = rows
      .map((r) => ({ u: r.user_id, s: r.points * 1 + r.advantages * 3 - r.penalty * 5, y: r.year, w: r.week_number }))
      .sort((a, b) => b.s - a.s);
    const total = scored.length;
    let rank = 1;
    let targetRank = null, target = null;
    for (let i = 0; i < scored.length; i++) {
      if (i > 0 && scored[i].s < scored[i - 1].s) rank = i + 1;
      if (scored[i].u === userId) { targetRank = rank; target = scored[i]; }
    }
    if (targetRank == null) continue;
    const pct = total <= 1 ? 1 : Math.ceil(((targetRank - 1) / (total - 1)) * 99) + 1;
    const onb = fw !== null && target.y === fw.year && target.w === fw.week_number;
    details.push({ y: target.y, w: target.w, pct, onb });
  }
  const eligible = details.filter((d) => !d.onb);
  if (eligible.length === 0) return { avgPercentile: null, rankGrade: null, isFrozen: false };
  const rawAvg = eligible.reduce((a, d) => a + d.pct, 0) / eligible.length;
  const avg = Math.ceil(rawAvg * 100) / 100;
  return { avgPercentile: avg, rankGrade: resolveGrade(avg), isFrozen: false, weeks: details.length, eligible: eligible.length };
}

// ── 대상 사용자 선택 ──
let targets = process.argv.slice(2);
if (targets.length === 0) {
  const withPoints = new Set(allPoints.map((p) => p.user_id));
  const real = profiles.find((p) => p.growth_status === "active" && !p.display_name.startsWith("T") && withPoints.has(p.user_id));
  const tester = profiles.find((p) => p.growth_status === "active" && p.display_name.startsWith("T") && withPoints.has(p.user_id));
  const grad = profiles.find((p) => p.growth_status === "graduated" && withPoints.has(p.user_id));
  targets = [real, tester, grad].filter(Boolean).map((p) => p.user_id);
}

for (const uid of targets) {
  const prof = profMap.get(uid);
  console.log(`\n=== ${prof?.display_name ?? uid} (${prof?.growth_status}, ${prof?.organization_slug}) ${uid} ===`);
  const direct = directClubRank(uid);
  console.log("  [direct ]", JSON.stringify(direct));

  // 운영 admin HTTP (internal key)
  try {
    const r = await fetch(`${ADMIN_BASE}/api/cluster3/club-rank?userId=${uid}`, {
      headers: { "x-internal-api-key": internalKey },
    });
    const b = await r.json().catch(() => null);
    const d = b?.data ?? b;
    console.log(`  [adminHTTP ${r.status}]`, JSON.stringify({ avgPercentile: d?.avgPercentile, rankGrade: d?.rankGrade, isFrozen: d?.isFrozen }));
    if (r.ok) {
      const match = d?.avgPercentile === direct.avgPercentile && d?.rankGrade === direct.rankGrade;
      console.log(`  [match  ] direct vs adminHTTP: ${match ? "일치 ✓" : "불일치 ✗"}`);
    }
  } catch (e) {
    console.log("  [adminHTTP] fetch 실패:", e.message);
  }

  // 프론트 demo 경로 (gradeStats.avgPercentile = club-rank proxy)
  try {
    const r = await fetch(`${FRONT_BASE}/api/profile?demoUserId=${uid}`);
    const b = await r.json().catch(() => null);
    const gs = b?.gradeStats;
    console.log(`  [frontDemo ${r.status}]`, gs ? JSON.stringify(gs) : JSON.stringify(b)?.slice(0, 160));
  } catch (e) {
    console.log("  [frontDemo] fetch 실패:", e.message);
  }
}

// user_grade_stats 캐시와 direct 비교 (화면 gradeLabel 폴백 경로)
console.log("\n=== user_grade_stats 캐시 vs direct (전체 비교, 상이만 출력) ===");
const cache = await qAll("user_grade_stats?select=user_id,avg_percentile,grade,grade_label");
let diff = 0;
for (const c of cache) {
  const d = directClubRank(c.user_id);
  if (d.avgPercentile == null) continue;
  const dAvg = Number(d.avgPercentile.toFixed(2));
  if (Math.abs(Number(c.avg_percentile) - dAvg) > 0.011 || (d.rankGrade && c.grade_label && c.grade_label.replace(/\s/g, "") !== d.rankGrade.replace(/\s/g, ""))) {
    diff++;
    const p = profMap.get(c.user_id);
    if (diff <= 15) console.log(`  ✗ ${p?.display_name ?? c.user_id}: cache=${c.avg_percentile}/${c.grade_label} direct=${dAvg}/${d.rankGrade}`);
  }
}
console.log(`캐시-직접계산 상이: ${diff}/${cache.length}`);

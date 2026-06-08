// B7 apply 사후 검증 (read-only): 행수/threshold/W8/publish/demoUserId/snapshot stale.
//   node scripts/verify-b7-apply.mjs
import { readFileSync } from "node:fs";
const env = readFileSync(".env.local", "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const url = get("NEXT_PUBLIC_SUPABASE_URL");
const key = get("SUPABASE_SERVICE_ROLE_KEY");
const ADMIN = "https://vraxium-admin.vercel.app";
const H = { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact" };
const q = async (p) => {
  const res = await fetch(`${url}/rest/v1/${p}`, { headers: H });
  if (!res.ok) throw new Error(`${p} → ${res.status}`);
  return { rows: await res.json(), total: Number(res.headers.get("content-range")?.split("/")[1] ?? -1) };
};

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const runLog = JSON.parse(readFileSync("claudedocs/b7-apply-2026-06-06T01-23-18.json", "utf8"));
const dryrun = JSON.parse(readFileSync("claudedocs/backfill-seasons-weeks-dryrun-20260605.json", "utf8"));

// 1. 행수/시즌 분포
const weeks = await q("weeks?select=id,season_key,week_number,start_date,is_official_rest,holiday_name,check_threshold,result_published_at&order=start_date&limit=1000");
check("weeks 총 153행", weeks.total === 153, `실제 ${weeks.total}`);
const seasons = await q("seasons?select=id,name,season_index&order=season_index");
check("seasons 13행 (기존 1 + insert 12)", seasons.total === 13, `실제 ${seasons.total}`);
const bySeason = new Map();
for (const w of weeks.rows) bySeason.set(w.season_key, (bySeason.get(w.season_key) ?? 0) + 1);
console.log("  시즌별 주차:", [...bySeason.entries()].sort().map(([k, n]) => `${k}:${n}`).join(" "));

// 2. 감사 25주 threshold = 37/35
const audit = dryrun.b8AuditWeekSet.weeks;
let thrOk = 0;
for (const a of audit) {
  const w = weeks.rows.find((x) => x.start_date === a.start_date);
  if (w && w.check_threshold === a.check_threshold) thrOk++;
}
check("감사 25주 check_threshold = confirmStar(37/35)", thrOk === 25, `${thrOk}/25`);

// 3. W8 공식 휴식 유지 (winter 휴식 플래그 단 1건)
const winterRest = weeks.rows.filter((w) => w.season_key === "2026-winter" && w.is_official_rest);
check("2026-winter W8 공식 휴식 유지 (단 1건)",
  winterRest.length === 1 && winterRest[0].week_number === 8 && winterRest[0].holiday_name === "설 연휴",
  JSON.stringify(winterRest.map((w) => ({ w: w.week_number, h: w.holiday_name }))));

// 4. publish: 신규 insert 103행 전부 result_published_at NULL + 기존 publish 보존
const insertedIds = new Set(runLog.insertedWeekIds);
const insertedPub = weeks.rows.filter((w) => insertedIds.has(w.id) && w.result_published_at != null);
check("신규 insert 103행 result_published_at 전부 NULL", insertedPub.length === 0, `${insertedPub.length}건 위반`);
const pubCount = weeks.rows.filter((w) => w.result_published_at != null).length;
// 기존 50행 중 publish 보유 = autumn 17 + winter 9 + spring 12 + summer 8 = 46
check("publish 보유 수 = 46 (변동 0)", pubCount === 46, `실제 ${pubCount}`);

// 5. conflict 7 + 병행작업 8 스킵 — 라이브 보존 확인
const conflictStarts = runLog.conflictsSkipped.map((c) => c.start);
check("conflict 7건 run log 기록", conflictStarts.length === 7, conflictStarts.join(","));
const concurrentKept = weeks.rows.filter((w) => w.season_key === "2025-summer" && w.check_threshold === 0);
check("병행작업 8행(2025-summer) threshold 0 보존", concurrentKept.length === 8, `${concurrentKept.length}/8`);

// 6. snapshot stale 0
const snaps = await q("cluster4_weekly_card_snapshots?select=user_id,dto_version,is_stale&limit=1000");
const stale = snaps.rows.filter((s) => s.is_stale === true).length;
const wrongVer = snaps.rows.filter((s) => s.dto_version !== 18).length;
check(`snapshot ${snaps.total}개 — is_stale=true 0건·전부 v18`, stale === 0 && wrongVer === 0, `stale=${stale} wrongVer=${wrongVer}`);

// 7. demoUserId 경로 == 일반(userId+internal key) 경로 — 동일 테스터 deep compare
const reseed = JSON.parse(readFileSync("claudedocs/reseed-tester-check-37-20260606.json", "utf8"));
const testerId = reseed.updated[0].userId;
const internal = await fetch(`${ADMIN}/api/cluster4/weekly-cards?userId=${testerId}`, {
  headers: { "x-internal-api-key": get("INTERNAL_API_KEY") },
});
const demo = await fetch(`${ADMIN}/api/cluster4/weekly-cards?demoUserId=${testerId}`);
check("HTTP 200 (internal·demo)", internal.ok && demo.ok, `internal=${internal.status} demo=${demo.status}`);
if (internal.ok && demo.ok) {
  const a = (await internal.json()).data ?? [];
  const b = (await demo.json()).data ?? [];
  const sameLen = a.length === b.length;
  let diffs = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) diffs++;
  }
  check(`demoUserId 응답 == userId 응답 (카드 ${a.length}장 deep equal)`, sameLen && diffs === 0, `len ${a.length}/${b.length} diffs=${diffs}`);
  // checkGate.required 가 37 로 반영됐는지 (감사 주차 카드 1장 표본)
  const auditStartSet = new Set(audit.map((x) => x.start_date));
  const sample = a.find((c) => auditStartSet.has(c.startDate) && c.experienceGrowth?.checkGate);
  check("HTTP 카드 checkGate.required = 신기준(37/35)",
    sample != null && (sample.experienceGrowth.checkGate.required === 37 || sample.experienceGrowth.checkGate.required === 35),
    sample ? JSON.stringify(sample.experienceGrowth.checkGate) : "표본 없음");
}

// 8. 롤백 가능성: run log 무결성
check("rollback 키 무결 (seasons 12 · weeks 103 · updates 25 + prior 값)",
  runLog.insertedSeasonIds.length === 12 && runLog.insertedWeekIds.length === 103 &&
  runLog.updatedRows.length === 25 && runLog.updatedRows.every((u) => u.prior === null && u.applied != null));

console.log(`\n결과: ✅ ${pass} / ❌ ${fail}`);
process.exit(fail > 0 ? 1 : 0);

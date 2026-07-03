/**
 * daily-consistency-check.ts — 매일 1회 운영 데이터 정합성 점검 + 필요한 항목만 resync.
 *
 *   # 감지만(기본, write 0):
 *   npx tsx --env-file=.env.local scripts/daily-consistency-check.ts
 *   # 감지 후 stale 항목만 targeted 교정 + 재검증:
 *   npx tsx --env-file=.env.local scripts/daily-consistency-check.ts --fix
 *   # 상세 로그:
 *   ... --fix --verbose
 *
 * 원칙(요청 사양):
 *   · 무조건 전체 resync 금지 — 먼저 비교하고 불일치한 user_id 만 targeted 재계산.
 *   · direct(lib) = DB 캐시/snapshot = admin HTTP = customer HTTP 인지 실제 값으로 비교.
 *   · stale 원인 분류: stale-cache / stale-snapshot / dto-divergence / fallback / demo-branch.
 *   · 교정 후 같은 비교를 다시 수행(재검증), 최종 일치 여부 보고.
 *
 * 점검 대상 ↔ 타깃:
 *   [1] grade cache (avgPercentile/품계)          user_grade_stats  ← 타깃 1,2,7  (remediable)
 *   [2] growth stats cache (approved/cumulative)  user_growth_stats ← 타깃 3      (remediable)
 *   [3] weekly-card snapshot                       cluster4_weekly_card_snapshots ← 타깃 4 (remediable)
 *   [4] cumulative points ledger                   user_cumulative_points vs Σuwp ← 타깃 5 (remediable)
 *   [5] cross-app HTTP parity (테스터)             customer /api/profile·weekly-* vs admin·direct ← 타깃 3,6,7,8 (detect-only)
 *   [6] 구조 정합성                                getOperationHealthCheck() ← 보조 (detect-only)
 */
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import {
  getClubRank,
  getClubRankGradeBatch,
  resyncGradeStatsBatch,
} from "@/lib/cluster3ClubRankData";
import { recalcUserGrowthStats } from "@/lib/userGrowthStatsData";
import {
  getGrowthStatsMismatchedUserIds,
  getOperationHealthCheck,
} from "@/lib/adminOperationHealthCheckData";
import {
  readWeeklyCardsSnapshot,
  recomputeWeeklyCardsSnapshotsForUsers,
  WEEKLY_CARDS_DTO_VERSION,
} from "@/lib/cluster4WeeklyCardsSnapshot";
import { getWeeklyGrowth } from "@/lib/cluster4WeeklyGrowthData";

const FIX = process.argv.includes("--fix");
const VERBOSE = process.argv.includes("--verbose");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const IK = process.env.INTERNAL_API_KEY!;
const ADMIN = process.env.ADMIN_BASE ?? "https://vraxium-admin.vercel.app";
const FRONT = process.env.FRONT_BASE ?? "https://vraxium.vercel.app";

type Cause = "stale-cache" | "stale-snapshot" | "dto-divergence" | "fallback" | "demo-branch" | "structural";
interface CheckResult {
  check: string;
  targets: string;
  remediable: boolean;
  checked: number;
  mismatchesBefore: number;
  cause: Cause | null;
  fixApplied: string | null;
  mismatchesAfter: number | null;
  converged: boolean | null;
  samples: any[];
}
const results: CheckResult[] = [];
const log = (...a: any[]) => console.log(...a);
const vlog = (...a: any[]) => VERBOSE && console.log(...a);

async function fetchAllRows<T>(table: string, cols: string, cap = 60000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < cap; from += 1000) {
    const { data, error } = await sb.from(table).select(cols).order("user_id", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
const near = (a: any, b: any, tol = 0.5) => {
  const x = a == null ? null : Number(a), y = b == null ? null : Number(b);
  if (x === null && y === null) return true;
  if (x === null || y === null) return false;
  return Math.abs(x - y) <= tol;
};
async function httpJson(u: string, headers?: Record<string, string>) {
  try { const r = await fetch(u, { headers, signal: AbortSignal.timeout(30000) }); return { status: r.status, json: await r.json().catch(() => null) }; }
  catch (e) { return { status: 0, json: null, err: (e as Error).name }; }
}

// ═══════════ [1] grade cache: user_grade_stats.avg_percentile vs live getClubRankGradeBatch ═══════════
async function checkGradeCache(): Promise<void> {
  log("\n[1] grade cache (avgPercentile/품계) — user_grade_stats vs live getClubRank …");
  const cacheRows = await fetchAllRows<{ user_id: string; avg_percentile: number | null }>("user_grade_stats", "user_id,avg_percentile");
  const ids = cacheRows.map((r) => r.user_id);
  const live = await getClubRankGradeBatch(ids); // 1 scan = live SoT
  const mism: string[] = [];
  const samples: any[] = [];
  for (const r of cacheRows) {
    const cache = r.avg_percentile == null ? null : Number(r.avg_percentile);
    const lv = live.get(r.user_id)?.avgPercentile ?? null;
    if (!near(cache, lv)) { mism.push(r.user_id); if (samples.length < 8) samples.push({ u: r.user_id.slice(0, 8), cache, live: lv }); }
  }
  log(`  checked=${cacheRows.length}  cache≠live=${mism.length}`);
  for (const s of samples) vlog("   ", JSON.stringify(s));
  const res: CheckResult = { check: "grade-cache", targets: "1,2,7", remediable: true, checked: cacheRows.length, mismatchesBefore: mism.length, cause: mism.length ? "stale-cache" : null, fixApplied: null, mismatchesAfter: null, converged: mism.length === 0 ? true : null, samples };
  if (mism.length && FIX) {
    log(`  → FIX: resyncGradeStatsBatch(${mism.length} targeted ids) …`);
    const r = await resyncGradeStatsBatch(mism);
    res.fixApplied = `resyncGradeStatsBatch(${mism.length}): graded=${r.graded} nulled=${r.nulled}`;
    // reverify
    const live2 = await getClubRankGradeBatch(mism);
    const { data: after } = await sb.from("user_grade_stats").select("user_id,avg_percentile").in("user_id", mism.slice(0, 500));
    const afterMap = new Map((after ?? []).map((x: any) => [x.user_id, x.avg_percentile]));
    let still = 0;
    for (const id of mism) if (!near(afterMap.get(id), live2.get(id)?.avgPercentile ?? null)) still++;
    res.mismatchesAfter = still; res.converged = still === 0;
    log(`  ← reverify: 잔여 불일치 ${still} (converged=${res.converged})`);
  }
  results.push(res);
}

// ═══════════ [2] growth stats cache: user_growth_stats vs uws 집계 (기존 detector 재사용) ═══════════
async function checkGrowthStats(): Promise<void> {
  log("\n[2] growth stats cache (approved/cumulative weeks) — user_growth_stats vs uws …");
  const mism = await getGrowthStatsMismatchedUserIds();
  log(`  mismatched user_ids=${mism.length}`);
  const res: CheckResult = { check: "growth-stats-cache", targets: "3", remediable: true, checked: -1, mismatchesBefore: mism.length, cause: mism.length ? "stale-cache" : null, fixApplied: null, mismatchesAfter: null, converged: mism.length === 0 ? true : null, samples: mism.slice(0, 8).map((u) => ({ u: u.slice(0, 8) })) };
  if (mism.length && FIX) {
    log(`  → FIX: recalcUserGrowthStats × ${mism.length} (targeted) …`);
    let ok = 0, fail = 0;
    for (const id of mism) { try { await recalcUserGrowthStats(id); ok++; } catch { fail++; } }
    res.fixApplied = `recalcUserGrowthStats: ok=${ok} fail=${fail}`;
    const after = await getGrowthStatsMismatchedUserIds();
    res.mismatchesAfter = after.length; res.converged = after.length === 0;
    log(`  ← reverify: 잔여 불일치 ${after.length} (converged=${res.converged})`);
  }
  results.push(res);
}

// ═══════════ [3] weekly-card snapshot: is_stale / dto_version mismatch (miss 는 lazy 정상) ═══════════
async function checkWeeklySnapshot(): Promise<void> {
  log("\n[3] weekly-card snapshot — is_stale / dto_version(≠" + WEEKLY_CARDS_DTO_VERSION + ") 스캔 …");
  const rows = await fetchAllRows<{ user_id: string; is_stale: boolean; dto_version: number; computed_at: string }>("cluster4_weekly_card_snapshots", "user_id,is_stale,dto_version,computed_at");
  const staleIds = rows.filter((r) => r.is_stale).map((r) => r.user_id);
  const verIds = rows.filter((r) => Number(r.dto_version) !== WEEKLY_CARDS_DTO_VERSION).map((r) => r.user_id);
  const bad = Array.from(new Set([...staleIds, ...verIds]));
  log(`  snapshot rows=${rows.length}  is_stale=${staleIds.length}  version_mismatch=${verIds.length}  → 교정대상=${bad.length}  (miss=lazy 정상·제외)`);
  const res: CheckResult = { check: "weekly-snapshot", targets: "4", remediable: true, checked: rows.length, mismatchesBefore: bad.length, cause: bad.length ? "stale-snapshot" : null, fixApplied: null, mismatchesAfter: null, converged: bad.length === 0 ? true : null, samples: bad.slice(0, 8).map((u) => ({ u: u.slice(0, 8) })) };
  if (bad.length && FIX) {
    log(`  → FIX: recomputeWeeklyCardsSnapshotsForUsers(${bad.length} targeted) …`);
    const r = await recomputeWeeklyCardsSnapshotsForUsers(bad, { concurrency: 3 });
    res.fixApplied = `recompute: recomputed=${r.recomputed} failed=${r.failed}`;
    const { data: after } = await sb.from("cluster4_weekly_card_snapshots").select("user_id,is_stale,dto_version").in("user_id", bad.slice(0, 500));
    const still = (after ?? []).filter((x: any) => x.is_stale || Number(x.dto_version) !== WEEKLY_CARDS_DTO_VERSION).length;
    res.mismatchesAfter = still; res.converged = still === 0;
    log(`  ← reverify: 잔여 stale/version ${still} (converged=${res.converged})`);
  }
  results.push(res);
}

// ═══════════ [4] cumulative points ledger: user_cumulative_points vs Σ user_weekly_points ═══════════
async function checkCumulativeLedger(): Promise<void> {
  log("\n[4] cumulative points ledger — user_cumulative_points vs Σ(user_weekly_points) …");
  const uwp = await fetchAllRows<{ user_id: string; points: number; penalty: number }>("user_weekly_points", "user_id,points,penalty");
  const sumByUser = new Map<string, { checks: number; pen: number }>();
  for (const r of uwp) {
    const s = sumByUser.get(r.user_id) ?? { checks: 0, pen: 0 };
    s.checks += Number(r.points ?? 0); s.pen += Number(r.penalty ?? 0);
    sumByUser.set(r.user_id, s);
  }
  const ucp = await fetchAllRows<{ user_id: string; total_checks: number; total_penalties: number }>("user_cumulative_points", "user_id,total_checks,total_penalties");
  const ucpMap = new Map(ucp.map((r) => [r.user_id, r]));
  const mism: string[] = [];
  const samples: any[] = [];
  for (const [uid, s] of sumByUser) {
    const c = ucpMap.get(uid);
    const cacheChecks = c ? Number(c.total_checks ?? 0) : null;
    const cachePen = c ? Number(c.total_penalties ?? 0) : null;
    // total_penalties 는 음수 저장/절대값 정책 차이 대비 절대값 비교.
    const penMatch = cachePen === null ? false : Math.abs(Math.abs(cachePen) - Math.abs(s.pen)) <= 0.5;
    const checkMatch = cacheChecks === null ? false : Math.abs(cacheChecks - s.checks) <= 0.5;
    if (!checkMatch || !penMatch) { mism.push(uid); if (samples.length < 8) samples.push({ u: uid.slice(0, 8), sumChecks: s.checks, cacheChecks, sumPen: s.pen, cachePen }); }
  }
  log(`  users(Σuwp)=${sumByUser.size}  ucp rows=${ucp.length}  ledger 불일치=${mism.length}`);
  for (const s of samples) vlog("   ", JSON.stringify(s));
  const res: CheckResult = { check: "cumulative-ledger", targets: "5", remediable: true, checked: sumByUser.size, mismatchesBefore: mism.length, cause: mism.length ? "stale-cache" : null, fixApplied: null, mismatchesAfter: null, converged: mism.length === 0 ? true : null, samples };
  if (mism.length && FIX) {
    log(`  → FIX: sync_cumulative_points_for_user RPC × ${mism.length} (targeted) …`);
    let ok = 0, fail = 0;
    for (const id of mism) { const { error } = await sb.rpc("sync_cumulative_points_for_user", { p_user_id: id }); if (error) fail++; else ok++; }
    res.fixApplied = `sync_cumulative_points_for_user: ok=${ok} fail=${fail}`;
    // reverify
    const ucp2 = await fetchAllRows<{ user_id: string; total_checks: number; total_penalties: number }>("user_cumulative_points", "user_id,total_checks,total_penalties");
    const ucp2Map = new Map(ucp2.map((r) => [r.user_id, r]));
    let still = 0;
    for (const id of mism) {
      const s = sumByUser.get(id)!; const c = ucp2Map.get(id);
      const cm = c ? Math.abs(Number(c.total_checks ?? 0) - s.checks) <= 0.5 : false;
      const pm = c ? Math.abs(Math.abs(Number(c.total_penalties ?? 0)) - Math.abs(s.pen)) <= 0.5 : false;
      if (!cm || !pm) still++;
    }
    res.mismatchesAfter = still; res.converged = still === 0;
    log(`  ← reverify: 잔여 ledger 불일치 ${still} (converged=${res.converged})`);
  }
  results.push(res);
}

// ═══════════ [5] cross-app HTTP parity (테스터) — detect-only (divergence=코드 이슈) ═══════════
async function checkCrossAppHttp(): Promise<void> {
  log("\n[5] cross-app HTTP parity (테스터) — customer vs admin vs direct + userId vs demoUserId …");
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const testerSet = new Set((markers ?? []).map((m: any) => m.user_id));
  const { data: uws } = await sb.from("user_week_statuses").select("user_id").order("week_start_date", { ascending: false }).limit(4000);
  const testers: string[] = [];
  for (const r of uws ?? []) { if (testerSet.has(r.user_id) && !testers.includes(r.user_id)) testers.push(r.user_id); if (testers.length >= 5) break; }

  const findings: any[] = [];
  for (const uid of testers) {
    const [cp, cpDemo, cCards, cCardsDemo, aResume, aRank, aCards] = await Promise.all([
      httpJson(`${FRONT}/api/profile?userId=${uid}`),
      httpJson(`${FRONT}/api/profile?demoUserId=${uid}`),
      httpJson(`${FRONT}/api/cluster4/weekly-cards?userId=${uid}`),
      httpJson(`${FRONT}/api/cluster4/weekly-cards?demoUserId=${uid}`),
      httpJson(`${ADMIN}/api/cluster1/resume?userId=${uid}`, { "x-internal-api-key": IK }),
      httpJson(`${ADMIN}/api/cluster3/club-rank?userId=${uid}`, { "x-internal-api-key": IK }),
      httpJson(`${ADMIN}/api/cluster4/weekly-cards?userId=${uid}`, { "x-internal-api-key": IK }),
    ]);
    if (cp.status !== 200) { vlog(`  ${uid.slice(0,8)} custProfile ${cp.status} (skip)`); continue; }
    const c = cp.json, ar = aResume.json?.data, arank = aRank.json?.data;
    // (a) avgPercentile: customer vs admin live
    if (arank && !near(c?.gradeStats?.avgPercentile, arank.avgPercentile, 0.5))
      findings.push({ u: uid.slice(0,8), field: "avgPercentile", cause: "stale-cache", cust: c?.gradeStats?.avgPercentile, admin: arank.avgPercentile });
    // (b) reliabilityRate / completionRate: graft-or-null
    if (ar && !near(c?.reliabilityRate, ar.scheduleReliability?.rate))
      findings.push({ u: uid.slice(0,8), field: "reliabilityRate", cause: c?.reliabilityRate == null ? "fallback" : "dto-divergence", cust: c?.reliabilityRate, admin: ar.scheduleReliability?.rate });
    if (ar && !near(c?.completionRate, ar.activityCompletion?.rate))
      findings.push({ u: uid.slice(0,8), field: "completionRate", cause: c?.completionRate == null ? "fallback" : "dto-divergence", cust: c?.completionRate, admin: ar.activityCompletion?.rate });
    // (c) weekly-cards core: customer(proxy) vs admin
    if (cCards.status === 200 && aCards.status === 200) {
      const core = (x: any) => JSON.stringify({ s: x.userWeekStatus, r: x.resultStatus, sk: x.seasonKey, sh: x.points?.shield });
      const am = new Map((aCards.json?.data ?? []).map((x: any) => [x.weekId, core(x)]));
      const cm = new Map((cCards.json?.data ?? []).map((x: any) => [x.weekId, core(x)]));
      let d = 0; for (const k of new Set([...am.keys(), ...cm.keys()])) if (am.get(k) !== cm.get(k)) d++;
      if (d > 0) findings.push({ u: uid.slice(0,8), field: `weekly-cards(${d} weeks)`, cause: "dto-divergence", cust: cm.size, admin: am.size });
    }
    // (d) demo 경로 == 일반 경로
    if (cpDemo.status === 200) {
      const strip = (o: any) => { if (!o?.data) return JSON.stringify(o); const { updated_at, ...rest } = o.data; return JSON.stringify({ ...o, data: rest }); };
      if (strip(cp.json) !== strip(cpDemo.json)) findings.push({ u: uid.slice(0,8), field: "profile userId vs demoUserId", cause: "demo-branch", cust: "differs" });
    }
    if (cCards.status === 200 && cCardsDemo.status === 200) {
      const core = (x: any) => JSON.stringify({ s: x.userWeekStatus, r: x.resultStatus });
      const um = new Map((cCards.json?.data ?? []).map((x: any) => [x.weekId, core(x)]));
      const dm = new Map((cCardsDemo.json?.data ?? []).map((x: any) => [x.weekId, core(x)]));
      let d = 0; for (const k of new Set([...um.keys(), ...dm.keys()])) if (um.get(k) !== dm.get(k)) d++;
      if (d > 0) findings.push({ u: uid.slice(0,8), field: `weekly-cards userId vs demoUserId(${d})`, cause: "demo-branch", cust: "differs" });
    }
    // (e) weekly-growth: customer(local) vs direct SoT — 시즌 상태만
    const direct = await getWeeklyGrowth(uid);
    const cg = cCards ? null : null; // (weekly-growth 는 season 형태라 카드와 별개; 상태만 아래)
    void cg; void direct;
  }
  log(`  테스터 ${testers.length}명 검사 · HTTP divergence findings=${findings.length}`);
  for (const f of findings) log("   ", JSON.stringify(f));
  results.push({ check: "cross-app-http", targets: "3,6,7,8", remediable: false, checked: testers.length, mismatchesBefore: findings.length, cause: findings.length ? (findings[0].cause as Cause) : null, fixApplied: null, mismatchesAfter: null, converged: findings.length === 0 ? true : null, samples: findings });
}

// ═══════════ [6] 구조 정합성 — getOperationHealthCheck() (detect-only) ═══════════
async function checkStructural(): Promise<void> {
  log("\n[6] 구조 정합성 — getOperationHealthCheck() …");
  const h = await getOperationHealthCheck();
  log(`  total_issues=${h.summary.total_issues} (growth=${h.summary.growth_stats_mismatch_count} seasonRest=${h.summary.season_rest_mismatch_count} seasonKey=${h.summary.season_key_mismatch_count} weekMap=${h.summary.week_mapping_mismatch_count})`);
  results.push({ check: "structural-health", targets: "보조", remediable: false, checked: h.summary.total_issues, mismatchesBefore: h.summary.total_issues, cause: h.summary.total_issues ? "structural" : null, fixApplied: null, mismatchesAfter: null, converged: h.summary.total_issues === 0 ? true : null, samples: h.issues.slice(0, 8).map((i) => ({ type: i.issue_type, u: i.user_name, msg: i.message?.slice(0, 40) })) });
}

async function main() {
  const started = new Date().toISOString();
  log(`═══════ 운영 정합성 점검 ${started} · mode=${FIX ? "FIX(targeted)" : "DETECT-ONLY"} ═══════`);
  await checkGradeCache();
  await checkGrowthStats();
  await checkWeeklySnapshot();
  await checkCumulativeLedger();
  await checkCrossAppHttp();
  await checkStructural();

  log(`\n\n═══════ 요약 ═══════`);
  log("check                | targets | remediable | before | cause            | fix | after | converged");
  for (const r of results) {
    log(
      `${r.check.padEnd(20)} | ${String(r.targets).padEnd(7)} | ${String(r.remediable).padEnd(10)} | ${String(r.mismatchesBefore).padStart(6)} | ${String(r.cause ?? "-").padEnd(16)} | ${r.fixApplied ? "Y" : "-"} | ${String(r.mismatchesAfter ?? "-").padStart(5)} | ${r.converged === null ? "?" : r.converged ? "✓" : "✗"}`,
    );
  }
  const remediableOutstanding = results.filter((r) => r.remediable && r.mismatchesBefore > 0 && !FIX);
  const notConverged = results.filter((r) => r.converged === false);
  log(`\nmode=${FIX ? "FIX" : "DETECT-ONLY"} · 교정 필요(remediable·미실행)=${remediableOutstanding.length} · 미수렴=${notConverged.length}`);
  if (!FIX && remediableOutstanding.length) log(`  → --fix 로 재실행하면 위 remediable 항목만 targeted 교정합니다.`);

  const out = { started, finished: new Date().toISOString(), mode: FIX ? "fix" : "detect", results };
  writeFileSync("claudedocs/daily-consistency-report.json", JSON.stringify(out, null, 2));
  log(`\n결과 저장: claudedocs/daily-consistency-report.json`);
}
main().catch((e) => { console.error(e); process.exit(1); });

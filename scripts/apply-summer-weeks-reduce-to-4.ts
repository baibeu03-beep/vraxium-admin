/**
 * 2025-summer 추가분 축소: 8주 → 4주 (a=34 → 30, 2026-06-06 방향 수정).
 *
 *   npx tsx --env-file=.env.local scripts/apply-summer-weeks-reduce-to-4.ts          # dry-run
 *   npx tsx --env-file=.env.local scripts/apply-summer-weeks-reduce-to-4.ts --apply  # 실반영
 *
 * 배경: 졸업 임계 30 대비 +8주(a=34)는 과보정 — W1~W4 만 유지해 a=30 정합.
 *   "4주/8주" 표시는 기획상 허용(2026-06-06 지시). graduated 는 유지(30>=30 invariant 충족).
 *
 * 처리(W5~W8 = 2025-07-28 · 08-04 · 08-11 · 08-18, 전부 2026-06-06 본 작업에서 생성된 합성분):
 *   1) 안전 assert — 해당 4주를 참조하는 데이터가 본 작업 산출물뿐인지 전수 확인:
 *      uws(6명 24행 외 0) · cluster4_lines(통합 4행 외 0) · 타깃(우리 24 외 0) ·
 *      user_weekly_points(해당 iso 주차 0행)
 *   2) 삭제: 평가 → 제출 → 타깃 → 라인 → uws → weeks (참조 역순)
 *   3) recalcUserGrowthStats + weekly-cards snapshot 재계산 (6명)
 *   4) 실사용자 지문(전/후) diff=0
 *
 * 비대상 보호: 삭제는 전부 id 화이트리스트 기반(사전 조회분만), oranke 3명·실사용자 무접촉.
 * 멱등: 이미 삭제된 행은 0건 매치 — 재실행 안전.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { recalcUserGrowthStats } from "@/lib/userGrowthStatsData";
import { recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const LOG_PATH = "claudedocs/tester-summer-weeks-20260606.json";

const REMOVE_STARTS = ["2025-07-28", "2025-08-04", "2025-08-11", "2025-08-18"] as const;
const SIX = [
  ["T윤도현", "bf3b4305-751a-49e3-88ad-95a20e5c4dad"],
  ["T임다인", "42864260-e4ea-4150-a87f-cff545b02af1"],
  ["T장유준", "4a81b6d1-e488-4f14-8530-0cad60fe4f0d"],
  ["T윤태현", "05ff6b96-b3e7-4050-97f1-080633f183d3"],
  ["T임건우", "e4dcb97e-a515-4ec5-a91e-32ca4e629dae"],
  ["T장시현", "cc1b58e6-b14d-45a0-b389-2df3c27a0b25"],
] as const;
const SIX_IDS = new Set(SIX.map((s) => s[1]));

const APPLY = process.argv.includes("--apply");

async function pageAll<T>(
  table: string,
  select: string,
  filter?: (q: any) => any,
  orderCol = "id",
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(select).order(orderCol, { ascending: true }).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function realUserFingerprint(excludeIds: Set<string>): Promise<{ hash: string; counts: Record<string, number> }> {
  const [uws, profiles, points, snaps] = await Promise.all([
    pageAll<any>("user_week_statuses", "user_id,week_start_date,status", undefined, "user_id"),
    pageAll<any>("user_profiles", "user_id,growth_status,activity_started_at,activity_ended_at", undefined, "user_id"),
    pageAll<any>("user_weekly_points", "user_id,year,week_number,points", undefined, "user_id"),
    pageAll<any>("cluster4_weekly_card_snapshots", "user_id,is_stale", undefined, "user_id"),
  ]);
  const pick = (rows: any[]) => rows.filter((r) => !excludeIds.has(r.user_id));
  const u = pick(uws).map((r) => `${r.user_id}|${r.week_start_date}|${r.status}`).sort();
  const p = pick(profiles).map((r) => `${r.user_id}|${r.growth_status}|${r.activity_started_at}|${r.activity_ended_at}`).sort();
  const w = pick(points).map((r) => `${r.user_id}|${r.year}|${r.week_number}|${r.points}`).sort();
  const s = pick(snaps).map((r) => `${r.user_id}|${r.is_stale}`).sort();
  const hash = createHash("sha256").update([u.join("\n"), p.join("\n"), w.join("\n"), s.join("\n")].join("\n#\n")).digest("hex");
  return { hash, counts: { uws: u.length, profiles: p.length, points: w.length, snapshots: s.length } };
}

async function main() {
  console.log(`모드: ${APPLY ? "APPLY" : "DRY-RUN"} | 제거 대상: 2025-summer W5~W8 (${REMOVE_STARTS.join(", ")})`);

  const fpBefore = await realUserFingerprint(SIX_IDS);
  console.log(`실사용자 지문 before: ${JSON.stringify(fpBefore.counts)} hash=${fpBefore.hash.slice(0, 16)}…`);

  // ── 0. 대상 weeks 행 ─────────────────────────────────────────────────
  const { data: weeks, error: wErr } = await sb
    .from("weeks")
    .select("id,start_date,season_key,week_number,iso_year,iso_week")
    .in("start_date", [...REMOVE_STARTS]);
  if (wErr) throw new Error(`weeks: ${wErr.message}`);
  const weekRows = (weeks ?? []) as any[];
  for (const w of weekRows) {
    if (w.season_key !== "2025-summer") throw new Error(`예상 밖 season_key: ${w.start_date}=${w.season_key}`);
  }
  console.log(`weeks 대상: ${weekRows.length}행 (W${weekRows.map((w) => w.week_number).sort().join(",W")})`);
  const weekIds = weekRows.map((w) => w.id);

  // ── 1. 안전 assert — 참조 데이터가 본 작업 산출물뿐인지 ───────────────
  // uws: 해당 4주의 전 사용자 행 = 6명 × 4 = 24행만 존재해야 함
  const uwsRows = weekRows.length
    ? await pageAll<any>("user_week_statuses", "id,user_id,week_start_date,status", (q) =>
        q.in("week_start_date", [...REMOVE_STARTS]),
      )
    : [];
  const uwsForeign = uwsRows.filter((r) => !SIX_IDS.has(r.user_id));
  if (uwsForeign.length > 0) {
    throw new Error(`해당 주차에 비대상 사용자 uws 존재(${uwsForeign.length}행) — 중단: ${uwsForeign.slice(0, 3).map((r: any) => r.user_id).join(",")}`);
  }
  console.log(`uws 대상: ${uwsRows.length}행 (전부 6명 소속 ✓, status=${[...new Set(uwsRows.map((r: any) => r.status))].join(",")})`);

  // lines: 해당 week_id 의 라인 전수 — 통합 라인(우리 생성) 외 없어야 함
  const lines = weekIds.length
    ? await pageAll<any>("cluster4_lines", "id,week_id,line_code,experience_line_master_id", (q) =>
        q.in("week_id", weekIds),
      )
    : [];
  const foreignLines = lines.filter((l) => !String(l.line_code ?? "").startsWith("EXBS-UN"));
  if (foreignLines.length > 0) throw new Error(`해당 주차에 통합 외 라인 존재 — 중단: ${foreignLines.map((l: any) => l.line_code).join(",")}`);
  console.log(`lines 대상: ${lines.length}행 (전부 EXBS-UN ✓)`);
  const lineIds = lines.map((l) => l.id);

  // targets: 해당 라인의 타깃 전수 — 전부 6명 소속이어야 함
  const targets = lineIds.length
    ? await pageAll<any>("cluster4_line_targets", "id,line_id,target_user_id", (q) => q.in("line_id", lineIds))
    : [];
  const foreignTargets = targets.filter((t) => !SIX_IDS.has(t.target_user_id));
  if (foreignTargets.length > 0) throw new Error(`해당 라인에 비대상 타깃 존재(${foreignTargets.length}) — 중단`);
  console.log(`targets 대상: ${targets.length}행 (전부 6명 ✓)`);
  const targetIds = targets.map((t) => t.id);

  // 제출/평가 (타깃 기준)
  const subs = targetIds.length
    ? await pageAll<any>("cluster4_line_submissions", "id,line_target_id,user_id", (q) => q.in("line_target_id", targetIds))
    : [];
  const evals = targetIds.length
    ? await pageAll<any>("cluster4_experience_line_evaluations", "id,line_target_id,user_id", (q) => q.in("line_target_id", targetIds))
    : [];
  console.log(`submissions: ${subs.length} | evaluations: ${evals.length}`);

  // user_weekly_points: 해당 iso 주차 행 0 이어야 함 (본 작업은 포인트 미생성)
  const isoPairs = weekRows.map((w) => ({ y: w.iso_year, wk: w.iso_week }));
  for (const { y, wk } of isoPairs) {
    const { count, error } = await sb
      .from("user_weekly_points")
      .select("id", { count: "exact", head: true })
      .eq("year", y)
      .eq("week_number", wk);
    if (error) throw new Error(`points 확인 실패: ${error.message}`);
    if ((count ?? 0) > 0) throw new Error(`iso ${y}-W${wk} 에 user_weekly_points ${count}행 존재 — 중단`);
  }
  console.log(`user_weekly_points: 해당 iso 주차 0행 ✓`);

  if (!APPLY) {
    console.log(`\n(dry-run) 삭제 예정: evals ${evals.length} → subs ${subs.length} → targets ${targets.length} → lines ${lines.length} → uws ${uwsRows.length} → weeks ${weekRows.length}, 이후 6명 recalc+snapshot`);
    return;
  }

  // ── 2. 삭제 (참조 역순, id 화이트리스트) ─────────────────────────────
  const delByIds = async (table: string, ids: string[]) => {
    for (let i = 0; i < ids.length; i += 200) {
      const c = ids.slice(i, i + 200);
      const { error } = await sb.from(table).delete().in("id", c);
      if (error) throw new Error(`${table} DELETE 실패: ${error.message}`);
    }
    console.log(`  ${table}: ${ids.length}행 삭제`);
  };
  await delByIds("cluster4_experience_line_evaluations", evals.map((e) => e.id));
  await delByIds("cluster4_line_submissions", subs.map((s) => s.id));
  await delByIds("cluster4_line_targets", targetIds);
  await delByIds("cluster4_lines", lineIds);
  await delByIds("user_week_statuses", uwsRows.map((r) => r.id));
  await delByIds("weeks", weekIds);

  // ── 3. 재계산 (6명) ──────────────────────────────────────────────────
  for (const [name, uid] of SIX) {
    await recalcUserGrowthStats(uid);
    await recomputeAndStoreWeeklyCardsSnapshot(uid);
    console.log(`재계산 완료: ${name}`);
  }

  // ── 4. 사후 지문 ─────────────────────────────────────────────────────
  const fpAfter = await realUserFingerprint(SIX_IDS);
  const diffOk = fpAfter.hash === fpBefore.hash;
  console.log(`\n실사용자 지문 diff: ${diffOk ? "✓ 0 (일치)" : "✗ 변경 감지!"} hash=${fpAfter.hash.slice(0, 16)}…`);

  const log: any = existsSync(LOG_PATH) ? JSON.parse(readFileSync(LOG_PATH, "utf8")) : { runs: [] };
  log.runs.push({
    runAt: new Date().toISOString(),
    mode: "REDUCE-TO-4 (W5~W8 삭제)",
    removedWeekStarts: [...REMOVE_STARTS],
    removed: {
      weeks: weekIds,
      lines: lineIds,
      targets: targetIds.length,
      submissions: subs.length,
      evaluations: evals.length,
      uws: uwsRows.map((r: any) => ({ id: r.id, uid: r.user_id, weekStart: r.week_start_date })),
    },
    fpBefore: { ...fpBefore.counts, hash: fpBefore.hash },
    fpAfter: { ...fpAfter.counts, hash: fpAfter.hash },
    realUserDiffZero: diffOk,
  });
  writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
  console.log(`로그 기록: ${LOG_PATH}`);
  if (!diffOk) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * 2025-summer PMS 정본 복원 — W1~W8 전체 구조 (2026-06-07 운영 확정).
 *
 *   npx tsx --env-file=.env.local scripts/apply-summer-pms-restore.ts            # PREVIEW (쓰기 0)
 *   npx tsx --env-file=.env.local scripts/apply-summer-pms-restore.ts --apply    # 실제 적용
 *   npx tsx --env-file=.env.local scripts/apply-summer-pms-restore.ts --rollback <runlog>
 *
 * 계약:
 *   - 정본 = pms weekssettings (B7 run log concurrentSkipped 보존본):
 *     W1~8 starts 06-30~08-18(+7d), confirmStar 24/24/34/34/37/37/35/37, 전부 미공표, rest=false.
 *   - W1~4: insert (라이브 부재 — 06-07 00:30 병행 이동으로 삭제된 구간). B7 insert 컨벤션 미러.
 *   - W5~8: update — check_threshold 0→37/37/35/37 만.
 *     ⚠ result_published_at 은 무접촉 (2026-06-07 운영 확정 개정): W5~8 = 졸업 인정 주차로
 *     publish(start+7d) 고정 — lib/summerWeeksPublishGuard.ts 가 preflight·쓰기 모두 차단한다.
 *     (종전 "pms 미공표 정본" 적용이 표시 a 30→26 회귀를 유발해 06-07 publish 복구로 정정됨.
 *      fix-summer-w5-8-publish-restore.ts 참고. PMS 의 '미공표' 속성은 이 4행에 적용하지 않는다.)
 *   - 테스터 6명 top-up uws 24행(W5~8) **무접촉** — 졸업 충족 데이터 보존.
 *     졸업 판정 = user_growth_stats.approved_weeks(uws success 카운트, 전환 제외)·growth_status enum —
 *     publish/threshold 무관(lib/userGrowthStatsData.ts·lib/growthCore.ts) → 복원으로 불변.
 *     v18 check 게이트는 uwp 행 단위(checks_migrated) — 테스터 summer uwp 0행 → enforced=false, threshold 무관.
 *   - 실사용자 이관 판단에서 테스터 top-up 제외: 이관 파이프라인은 test_user_markers 사용자를
 *     충돌/검증 모수에서 제외한다 (lib/pmsMigration.ts 계약 — 본 스크립트는 주차 구조만 복원).
 *   - 표시 영향(수용): W5~8 미공표 전환 → 테스터 summer 카드 '확정'→'집계 중' (resultStatus 가
 *     result_published_at 파생). 졸업/누적 인정 수치는 불변.
 *   - apply 후 필수: 테스터 6명 snapshot 명시 invalidate+재계산 (snapshot-only 구조 유지,
 *     demoUserId/일반 동일 로더라 경로 분기 없음) → verify-reseed 패턴 재검증 + 1092 dry-run 재실행.
 */
import { writeFileSync, readFileSync } from "fs";
import { randomUUID } from "crypto";
import { createClient } from "@supabase/supabase-js";
import { recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import {
  assertProtectedPublishWrite,
  assertSummerW58PublishGuard,
} from "@/lib/summerWeeksPublishGuard";

const APPLY = process.argv.includes("--apply");
const ROLLBACK_LOG = process.argv.includes("--rollback")
  ? process.argv[process.argv.indexOf("--rollback") + 1]
  : null;
if (APPLY && ROLLBACK_LOG) throw new Error("--apply 와 --rollback 동시 지정 불가");

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// ── pms 정본 (B7 run log concurrentSkipped — claudedocs/b7-apply-2026-06-06T01-23-18.json) ──
const PMS_SUMMER: { week: number; start: string; end: string; threshold: number }[] = [
  { week: 1, start: "2025-06-30", end: "2025-07-06", threshold: 24 },
  { week: 2, start: "2025-07-07", end: "2025-07-13", threshold: 24 },
  { week: 3, start: "2025-07-14", end: "2025-07-20", threshold: 34 },
  { week: 4, start: "2025-07-21", end: "2025-07-27", threshold: 34 },
  { week: 5, start: "2025-07-28", end: "2025-08-03", threshold: 37 },
  { week: 6, start: "2025-08-04", end: "2025-08-10", threshold: 37 },
  { week: 7, start: "2025-08-11", end: "2025-08-17", threshold: 35 },
  { week: 8, start: "2025-08-18", end: "2025-08-24", threshold: 37 },
];
const SEASON_KEY = "2025-summer";
const tsOf = (d: string) => `${d}T00:00:00+00:00`;
function isoWeekOf(dateIso: string): { isoYear: number; isoWeek: number } {
  const d = new Date(`${dateIso}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const isoYear = d.getUTCFullYear();
  const jan1 = new Date(Date.UTC(isoYear, 0, 1));
  const isoWeek = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + 1) / 7);
  return { isoYear, isoWeek };
}

async function summerTesterUserIds(): Promise<string[]> {
  const starts = PMS_SUMMER.map((w) => w.start);
  const { data, error } = await sb
    .from("user_week_statuses")
    .select("user_id")
    .in("week_start_date", starts)
    .limit(1000);
  if (error) throw new Error(error.message);
  return [...new Set((data ?? []).map((r: any) => r.user_id as string))];
}

async function rollback(logPath: string) {
  const log = JSON.parse(readFileSync(logPath, "utf8"));
  console.log(`── ROLLBACK (${logPath}) ──`);
  for (const id of log.insertedWeekIds as string[]) {
    const { error } = await sb.from("weeks").delete().eq("id", id);
    if (error) throw new Error(`week ${id} 삭제 실패: ${error.message}`);
  }
  console.log(`weeks insert ${log.insertedWeekIds.length}건 삭제`);
  for (const u of log.updatedRows as { weekId: string; start?: string; col: string; prior: unknown; applied: unknown }[]) {
    // 보호 구간 publish 쓰기 의도 차단 (rollback 경로 — 기대값(start+7d) 복원만 허용).
    if (u.col === "result_published_at") {
      let start = u.start ?? null;
      if (!start) {
        const { data: wk } = await sb.from("weeks").select("start_date").eq("id", u.weekId).maybeSingle();
        start = (wk as { start_date?: string } | null)?.start_date ?? "";
      }
      assertProtectedPublishWrite({ start, col: u.col, value: u.prior });
    }
    const { error } = await sb.from("weeks").update({ [u.col]: u.prior }).eq("id", u.weekId);
    if (error) throw new Error(`week ${u.weekId} ${u.col} 원복 실패: ${error.message}`);
  }
  console.log(`weeks update ${log.updatedRows.length}건 원복 — snapshot 재계산을 별도 수행하세요`);
}

async function main() {
  if (ROLLBACK_LOG) return rollback(ROLLBACK_LOG);

  // ── preflight (fail-closed) ──
  // 2025-summer W5~8 publish 보호 가드 (2026-06-07 운영 확정) — dry-run 포함 즉시 중단.
  await assertSummerW58PublishGuard(sb);
  const { data: live, error } = await sb
    .from("weeks")
    .select("id,week_number,start_date,end_date,check_threshold,result_published_at,is_official_rest,season_id,season_key")
    .eq("season_key", SEASON_KEY)
    .order("start_date");
  if (error) throw new Error(error.message);
  const drift: string[] = [];
  const liveByStart = new Map((live ?? []).map((w: any) => [w.start_date, w]));

  if ((live ?? []).length !== 4) drift.push(`summer 라이브 ${live?.length}행 (기대 4 = W5~8)`);
  for (const p of PMS_SUMMER.slice(4)) {
    const w = liveByStart.get(p.start);
    if (!w) drift.push(`W${p.week}(${p.start}) 라이브 부재`);
    else {
      if (w.week_number !== p.week) drift.push(`${p.start} week_number ${w.week_number}≠${p.week}`);
      if (w.check_threshold !== 0) drift.push(`${p.start} threshold ${w.check_threshold}≠0 (기대 합성값)`);
      if (w.result_published_at == null) drift.push(`${p.start} 이미 미공표 — 상태 가정 불일치`);
      if (w.is_official_rest) drift.push(`${p.start} 휴식 플래그 — 기대 false`);
    }
  }
  for (const p of PMS_SUMMER.slice(0, 4)) {
    if (liveByStart.has(p.start)) drift.push(`W${p.week}(${p.start}) 이미 존재 — insert 대상 아님`);
  }
  // W1~4 구간 잔존 사용자 행 (병행 이동의 고아 검출)
  const oldStarts = PMS_SUMMER.slice(0, 4).map((p) => p.start);
  for (const t of ["user_week_statuses", "user_weekly_points"]) {
    const { count, error: e } = await sb
      .from(t)
      .select("user_id", { count: "exact", head: true })
      .in("week_start_date", oldStarts);
    if (e) throw new Error(e.message);
    if ((count ?? 0) !== 0) drift.push(`${t} W1~4 구간 ${count}행 잔존 — 고아 정리 선행 필요`);
  }
  if (drift.length) {
    console.error("⛔ preflight drift — 중단:");
    for (const d of drift) console.error("  - " + d);
    process.exit(1);
  }
  const seasonId = (live ?? [])[0].season_id as string;
  console.log("✅ preflight 통과 — summer = W5~8 4행(thr0·공표), W1~4 부재·사용자 행 0");

  // ── 페이로드 ──
  const inserts = PMS_SUMMER.slice(0, 4).map((p) => {
    const { isoYear, isoWeek } = isoWeekOf(p.start);
    return {
      id: randomUUID(),
      season_id: seasonId,
      season_key: SEASON_KEY,
      week_number: p.week,
      week_index: isoWeek,
      start_date: p.start,
      end_date: p.end,
      started_at: tsOf(p.start),
      ended_at: tsOf(p.end),
      iso_year: isoYear,
      iso_week: isoWeek,
      is_official_rest: false,
      holiday_name: null,
      check_threshold: p.threshold,
      // result_published_at 없음 — pms 미공표 정본 (insert 시 NULL)
    };
  });
  const updates = PMS_SUMMER.slice(4).flatMap((p) => {
    const w = liveByStart.get(p.start)!;
    return [
      { weekId: w.id as string, start: p.start, col: "check_threshold", prior: w.check_threshold, applied: p.threshold },
      // result_published_at 항목 제거 (2026-06-07 개정): W5~8 publish 는 보호 대상 —
      // 졸업 인정 주차 정책(start+7d 고정). summerWeeksPublishGuard 가 쓰기 의도도 차단한다.
    ];
  });

  // ── 테스터 졸업 영향 preview ──
  const testers = await summerTesterUserIds();
  const { data: gs } = await sb
    .from("user_growth_stats")
    .select("user_id,approved_weeks,cumulative_weeks")
    .in("user_id", testers);
  const { data: profs } = await sb
    .from("user_profiles")
    .select("user_id,display_name,growth_status")
    .in("user_id", testers);
  const profBy = new Map((profs ?? []).map((p: any) => [p.user_id, p]));
  console.log(`\n── 테스터 top-up 보유자 ${testers.length}명 — 졸업 상태/카운트 (복원 후 불변 예상) ──`);
  for (const g of gs ?? []) {
    const p = profBy.get(g.user_id);
    console.log(
      `  ${p?.display_name ?? g.user_id.slice(0, 8)}: growth_status='${p?.growth_status}' approved=${g.approved_weeks} cumulative=${g.cumulative_weeks}`,
    );
  }
  console.log("  불변 근거: uws 무접촉 + approved_weeks 식이 publish/threshold 비참조 + 테스터 summer uwp 0행(enforced=false)");

  if (!APPLY) {
    console.log("\n── PREVIEW (쓰기 0) ──");
    console.log(`weeks insert ${inserts.length} (W1~4):`);
    for (const i of inserts) console.log(`  W${i.week_number} ${i.start_date}~${i.end_date} thr=${i.check_threshold} pub=NULL`);
    console.log(`weeks update ${updates.length}건 (W5~8 컬럼 단위):`);
    for (const u of updates) console.log(`  ${u.start} ${u.col}: ${JSON.stringify(u.prior)} → ${JSON.stringify(u.applied)}`);
    console.log(`\napply 시 후속 계약: 테스터 ${testers.length}명 snapshot invalidate+재계산 → 졸업 재확인 → 1092 dry-run 재실행`);
    console.log("DRY-RUN — 변경 없음. 적용하려면 --apply.");
    return;
  }

  // ── 적용 ──
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runLog: Record<string, unknown> = {
    appliedAt: new Date().toISOString(),
    script: "apply-summer-pms-restore.ts",
    insertedWeekIds: inserts.map((i) => i.id),
    insertedRows: inserts,
    updatedRows: updates,
    testers,
  };
  const { error: insErr } = await sb.from("weeks").insert(inserts);
  if (insErr) throw new Error(`insert 실패: ${insErr.message}`);
  console.log(`weeks insert ${inserts.length} 완료`);
  for (const u of updates) {
    // 보호 구간 publish 쓰기 의도 차단 (이중 방어 — 페이로드에서 이미 제외됨).
    assertProtectedPublishWrite({ start: u.start, col: u.col, value: u.applied });
    let q = sb.from("weeks").update({ [u.col]: u.applied }).eq("id", u.weekId);
    // 현재값 가드
    q = u.prior === null ? q.is(u.col, null) : q.eq(u.col, u.prior as any);
    const { data: upd, error: updErr } = await q.select("id");
    if (updErr) throw new Error(`update ${u.start} ${u.col} 실패: ${updErr.message}`);
    if ((upd ?? []).length !== 1) throw new Error(`update ${u.start} ${u.col}: 갱신 ${upd?.length}행 (가드 불일치)`);
  }
  console.log(`weeks update ${updates.length}건 완료`);

  // snapshot 무효화 + 명시 재계산 (B7 apply 와 동일 패턴 — recomputeAndStoreWeeklyCardsSnapshot)
  const { error: stErr } = await sb
    .from("cluster4_weekly_card_snapshots")
    .update({ is_stale: true })
    .in("user_id", testers);
  if (stErr) throw new Error(`snapshot 무효화 실패: ${stErr.message}`);
  let snapOk = 0;
  const snapFailed: string[] = [];
  for (const uid of testers) {
    try {
      await recomputeAndStoreWeeklyCardsSnapshot(uid);
      snapOk++;
    } catch (e) {
      snapFailed.push(uid);
      console.error(`  ❌ snapshot 재계산 실패 ${uid}:`, (e as Error).message);
    }
  }
  runLog.snapshotRecompute = { users: testers.length, ok: snapOk, failed: snapFailed };
  console.log(`snapshot 재계산: ${snapOk}/${testers.length}${snapFailed.length ? ` (실패 ${snapFailed.length})` : ""}`);

  const out = `claudedocs/summer-pms-restore-${stamp}.json`;
  writeFileSync(out, JSON.stringify(runLog, null, 1));
  console.log(`run log → ${out}`);
  console.log("후속: 테스터 snapshot 재계산 → verify-reseed 패턴 재검증 → 1092 dry-run 재실행");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

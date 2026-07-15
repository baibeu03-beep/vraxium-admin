/**
 * 액트 소프트 취소 검증 — 로컬/테스트 DB 전용.
 * ─────────────────────────────────────────────────────────────────────
 * ⚠ 운영 데이터를 수정하지 마세요. MUTATE 모드는 반드시 전용 테스트 원장 행(AWARD_ID)에만 쓰세요.
 *
 * 실행:
 *   기본(읽기 전용 불변식 점검):
 *     tsx --env-file=.env.local scripts/verify-crew-week-act-cancel.ts USER_ID WEEK_ID
 *   취소 왕복(전용 테스트 award 1건):
 *     MUTATE=1 tsx --env-file=.env.local scripts/verify-crew-week-act-cancel.ts USER_ID WEEK_ID AWARD_ID
 *
 * 점검 항목:
 *   [R1] cancelled 컬럼(마이그레이션) 적용 여부.
 *   [R2] user_weekly_points == 원장(active only) 합 — cancelled 제외가 반영됐는지(공통 레이어).
 *   [M1] 소프트 취소 → 재집계 후: points(A)·penalty(C) 감소, 최종 B(adv−pen) 복원.
 *   [M2] 부활 방지: 동일 (source,ref_id,user_id) upsert 재실행 후에도 cancelled_at 보존.
 *   [M3] 원복(un-cancel) → 재집계 후 원래 합계로 복귀(무손실).
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { processPointAwardsHasCancelColumns } from "@/lib/processPointAwardsCancelState";
import { recomputeWeeklyPointsForUsers, softCancelActAwards } from "@/lib/processPointAccrual";

const [userId, weekId, awardId] = process.argv.slice(2);
const MUTATE = process.env.MUTATE === "1";

async function loadWeekIso(id: string) {
  const { data } = await supabaseAdmin
    .from("weeks")
    .select("id,iso_year,iso_week,start_date")
    .eq("id", id)
    .maybeSingle();
  return data as { id: string; iso_year: number; iso_week: number; start_date: string } | null;
}

async function ledgerSums(uid: string, year: number, wk: number, activeOnly: boolean) {
  let q = supabaseAdmin
    .from("process_point_awards")
    .select("point_check,point_advantage,point_penalty,cancelled_at")
    .eq("user_id", uid)
    .eq("year", year)
    .eq("week_number", wk);
  if (activeOnly) q = q.is("cancelled_at", null);
  const { data } = await q;
  const rows = (data ?? []) as { point_check: number; point_advantage: number; point_penalty: number }[];
  return {
    a: rows.reduce((s, r) => s + (r.point_check || 0), 0),
    b: rows.reduce((s, r) => s + (r.point_advantage || 0), 0),
    c: rows.reduce((s, r) => s + (r.point_penalty || 0), 0),
    n: rows.length,
  };
}

async function uwp(uid: string, year: number, wk: number) {
  const { data } = await supabaseAdmin
    .from("user_weekly_points")
    .select("points,advantages,penalty")
    .eq("user_id", uid)
    .eq("year", year)
    .eq("week_number", wk)
    .maybeSingle();
  const r = (data ?? { points: 0, advantages: 0, penalty: 0 }) as {
    points: number;
    advantages: number;
    penalty: number;
  };
  return { a: r.points, b: r.advantages, c: r.penalty, finalB: (r.advantages ?? 0) - (r.penalty ?? 0) };
}

async function main() {
  if (!userId || !weekId) {
    console.error("usage: ... USER_ID WEEK_ID [AWARD_ID]  (MUTATE=1 for cancel roundtrip)");
    process.exit(2);
  }

  const hasCancel = await processPointAwardsHasCancelColumns();
  console.log(`[R1] cancel columns applied: ${hasCancel ? "YES" : "NO (migration 2026-07-15 필요)"}`);
  if (!hasCancel) process.exit(hasCancel ? 0 : 2);

  const week = await loadWeekIso(weekId);
  if (!week) {
    console.error("week not found:", weekId);
    process.exit(2);
  }
  const { iso_year: y, iso_week: w } = week;

  const active = await ledgerSums(userId, y, w, true);
  const points = await uwp(userId, y, w);
  const r2 =
    active.a === points.a && active.b === points.b && active.c === points.c;
  console.log(
    `[R2] uwp == active-ledger sum: ${r2 ? "PASS" : "FAIL"} ` +
      `(ledger A/B/C=${active.a}/${active.b}/${active.c}, uwp=${points.a}/${points.b}/${points.c}, finalB=${points.finalB})`,
  );

  if (!MUTATE) {
    console.log("read-only 완료. 취소 왕복은 MUTATE=1 + AWARD_ID 로 실행.");
    return;
  }
  if (!awardId) {
    console.error("MUTATE 모드는 전용 테스트 AWARD_ID 가 필요합니다.");
    process.exit(2);
  }

  const before = await uwp(userId, y, w);
  const { data: awRow } = await supabaseAdmin
    .from("process_point_awards")
    .select("id,source,ref_id,user_id,year,week_number,point_check,point_advantage,point_penalty,cancelled_at")
    .eq("id", awardId)
    .maybeSingle();
  if (!awRow) {
    console.error("award not found:", awardId);
    process.exit(2);
  }
  const aw = awRow as {
    id: string; source: string; ref_id: string; user_id: string; year: number; week_number: number;
    point_check: number; point_advantage: number; point_penalty: number; cancelled_at: string | null;
  };
  console.log(`대상 award A/B/C=${aw.point_check}/${aw.point_advantage}/${aw.point_penalty}, cancelled=${Boolean(aw.cancelled_at)}`);

  // [M1] soft-cancel → 재집계.
  const res = await softCancelActAwards({
    awardIds: [awardId], userId, weekId, cancelledBy: userId, reason: "verify-script",
  });
  const afterCancel = await uwp(userId, y, w);
  const m1 =
    afterCancel.a === before.a - aw.point_check &&
    afterCancel.c === before.c - aw.point_penalty &&
    afterCancel.finalB === before.finalB - aw.point_advantage + aw.point_penalty;
  console.log(
    `[M1] cancel recompute: ${m1 ? "PASS" : "FAIL"} (cancelledCount=${res.cancelledCount}, ` +
      `A ${before.a}→${afterCancel.a}, C ${before.c}→${afterCancel.c}, finalB ${before.finalB}→${afterCancel.finalB})`,
  );

  // [M2] 부활 방지 — 동일 키 upsert 재실행 후에도 cancelled_at 보존.
  await supabaseAdmin.from("process_point_awards").upsert(
    {
      source: aw.source, ref_id: aw.ref_id, user_id: aw.user_id, year: aw.year, week_number: aw.week_number,
      point_check: aw.point_check, point_advantage: aw.point_advantage, point_penalty: aw.point_penalty,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "source,ref_id,user_id" },
  );
  const { data: reRow } = await supabaseAdmin
    .from("process_point_awards").select("cancelled_at").eq("id", awardId).maybeSingle();
  const stillCancelled = Boolean((reRow as { cancelled_at: string | null } | null)?.cancelled_at);
  console.log(`[M2] resurrection guard (upsert preserves cancelled_at): ${stillCancelled ? "PASS" : "FAIL"}`);

  // [M3] 원복(un-cancel) → 재집계 → 원래 합계 복귀.
  await supabaseAdmin
    .from("process_point_awards")
    .update({ cancelled_at: null, cancelled_by: null, cancel_reason: null, updated_at: new Date().toISOString() })
    .eq("id", awardId);
  await recomputeWeeklyPointsForUsers([userId], weekId);
  const restored = await uwp(userId, y, w);
  const m3 = restored.a === before.a && restored.b === before.b && restored.c === before.c;
  console.log(`[M3] restore after un-cancel: ${m3 ? "PASS" : "FAIL"} (A/B/C ${restored.a}/${restored.b}/${restored.c} vs ${before.a}/${before.b}/${before.c})`);

  console.log(`\n결과: ${[m1, stillCancelled, m3].every(Boolean) ? "ALL PASS" : "FAILURE 있음"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * 실무 경험 평점 Point A — 원장 정합(reconcileLineResultAwardForUser) 검증.
 *
 *   npx tsx --env-file=.env.local scripts/verify-line-rating-award-reconcile.ts
 *
 * 대상은 **QA 테스트 라인(is_qa_test=true)** 의 이미 정합된 (user, line) 뿐이며, 호출은 멱등이다
 * (같은 성공 판정으로 같은 값을 재-upsert). 실사용자/운영 라인은 건드리지 않는다.
 *
 * 검증:
 *   ① 마이그레이션(2026-07-27_..._line_rating_source.sql) 적용 여부 프로브
 *   ② 미적용 환경: 평점 원장 실패가 격리되고 **기존 강화 지급(source='line')은 그대로 유지**되는가
 *      (graceful degradation — 무회귀)
 *   ③ 적용 환경: 평점 = rating 그대로 point_check 에 기록 · point_advantage/penalty = 0
 *   ④ 멱등 — 2회 연속 호출 후 원장 행 수/값 불변
 *   ⑤ 회수 — isSuccess=false 로 호출하면 평점 원장이 취소되고, 다시 true 면 복원
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- 검증 스크립트 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { reconcileLineResultAwardForUser } from "@/lib/processPointAccrual";
import { EXPERIENCE_RATING_AWARD_MIN_RATING } from "@/lib/experienceRatingPolicy";

let failed = 0;
const ck = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
  if (!ok) failed++;
};

async function awards(userId: string, lineId: string) {
  const { data } = await supabaseAdmin
    .from("process_point_awards")
    .select("source,point_check,point_advantage,point_penalty,cancelled_at")
    .eq("user_id", userId)
    .eq("ref_id", lineId)
    .in("source", ["line", "line_rating"]);
  const out: Record<string, any> = {};
  for (const r of (data ?? []) as any[]) out[r.source] = r;
  return out;
}

async function main() {
  // ① 마이그레이션 적용 프로브 — source='line_rating' 행을 select 할 수 있는지가 아니라,
  //    CHECK 제약이 허용하는지를 봐야 한다. 기존 행 조회로는 알 수 없으므로 실제 정합 결과로 판정한다.
  const { data: existingRating } = await supabaseAdmin
    .from("process_point_awards")
    .select("id")
    .eq("source", "line_rating")
    .limit(1);
  const hadRatingRows = ((existingRating ?? []) as any[]).length > 0;
  console.log(`기존 line_rating 원장 행: ${hadRatingRows ? "있음" : "없음"}`);

  // 대상 = QA 테스트 experience 라인 중 평점 >= 4 이고 대상자가 있는 (user, line).
  const { data: qaLines } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id,part_type,is_qa_test,experience_line_master_id")
    .eq("part_type", "experience")
    .eq("is_qa_test", true)
    .eq("is_active", true)
    .limit(50);
  const lineIds = ((qaLines ?? []) as any[]).map((l) => l.id);
  if (lineIds.length === 0) {
    console.log("⚠ QA 테스트 experience 라인이 없어 원장 쓰기 검증을 건너뜁니다(무해 종료).");
    process.exit(0);
  }

  const { data: tgts } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("id,line_id,week_id,target_user_id")
    .in("line_id", lineIds)
    .eq("target_mode", "user")
    .not("target_user_id", "is", null);
  const targets = (tgts ?? []) as any[];
  if (targets.length === 0) {
    console.log("⚠ QA 라인 대상자가 없어 건너뜁니다(무해 종료).");
    process.exit(0);
  }

  const { data: evs } = await supabaseAdmin
    .from("cluster4_experience_line_evaluations")
    .select("line_target_id,user_id,rating,evaluated_by")
    .in("line_target_id", targets.map((t) => t.id).slice(0, 100));
  const evByTarget = new Map(((evs ?? []) as any[]).map((e) => [`${e.line_target_id}:${e.user_id}`, e]));

  const pick = targets.find((t) => {
    const e = evByTarget.get(`${t.id}:${t.target_user_id}`);
    return e && e.evaluated_by != null && (e.rating ?? 0) >= EXPERIENCE_RATING_AWARD_MIN_RATING;
  });
  if (!pick) {
    console.log("⚠ 평점 4점 이상인 QA 대상자가 없어 건너뜁니다(무해 종료).");
    process.exit(0);
  }
  const ev = evByTarget.get(`${pick.id}:${pick.target_user_id}`)!;
  const userId = pick.target_user_id as string;
  const lineId = pick.line_id as string;
  const weekId = pick.week_id as string;
  console.log(`대상: line=${lineId.slice(0, 8)} user=${userId.slice(0, 8)} rating=${ev.rating}\n`);

  const before = await awards(userId, lineId);

  // ② / ③ 성공 정합 1회.
  await reconcileLineResultAwardForUser(userId, lineId, weekId, true, null);
  const after1 = await awards(userId, lineId);

  const migrated = after1.line_rating != null && after1.line_rating.cancelled_at == null;
  console.log(`마이그레이션 적용 판정: ${migrated ? "적용됨" : "미적용(평점 원장 생성 실패 — 격리됨)"}\n`);

  // 무회귀 — 기존 강화 지급이 평점 처리 때문에 사라지거나 바뀌지 않았는가.
  ck(
    "기존 강화 지급(source='line') 보존 — 평점 처리 실패/성공과 무관",
    JSON.stringify(before.line ?? null) === JSON.stringify(after1.line ?? null) ||
      (after1.line != null && after1.line.cancelled_at == null),
    { before: before.line ?? null, after: after1.line ?? null },
  );

  if (!migrated) {
    ck("미적용 환경에서 예외가 호출부로 전파되지 않음(정합 호출 자체는 성공)", true);
    console.log(
      "\n⚠ db/migrations/2026-07-27_process_point_awards_line_rating_source.sql 미적용 —",
      "\n  평점 Point A 는 아직 적립되지 않습니다. Supabase SQL Editor 에서 적용 후 재실행하세요.",
    );
    console.log(failed === 0 ? "\nALL PASS (미적용 환경 무회귀 확인)" : `\n${failed} FAIL`);
    process.exit(failed === 0 ? 0 : 1);
  }

  // ── 적용 환경 검증 ────────────────────────────────────────────────────────
  ck("평점 = point_check 그대로", after1.line_rating.point_check === ev.rating, {
    rating: ev.rating, point_check: after1.line_rating.point_check,
  });
  ck("평점은 Point B/C 로 지급하지 않음",
    after1.line_rating.point_advantage === 0 && after1.line_rating.point_penalty === 0,
    { b: after1.line_rating.point_advantage, c: after1.line_rating.point_penalty });
  ck("강화 지급과 평점 지급이 별도 행으로 공존(이중 지급 아님·키 분리)",
    after1.line != null && after1.line_rating != null,
    { line: after1.line?.point_check, line_rating: after1.line_rating?.point_check });

  // ④ 멱등.
  await reconcileLineResultAwardForUser(userId, lineId, weekId, true, null);
  const after2 = await awards(userId, lineId);
  ck("멱등 — 2회 호출 후 값 불변",
    JSON.stringify({ a: after1.line_rating.point_check, b: after1.line.point_check }) ===
      JSON.stringify({ a: after2.line_rating.point_check, b: after2.line.point_check }),
    { first: after1.line_rating.point_check, second: after2.line_rating.point_check });

  // ⑤ 회수 → 복원.
  await reconcileLineResultAwardForUser(userId, lineId, weekId, false, null);
  const revoked = await awards(userId, lineId);
  ck("강화 실패 → 평점 원장 회수(cancelled_at)", revoked.line_rating?.cancelled_at != null, {
    cancelled_at: revoked.line_rating?.cancelled_at ?? null,
  });
  ck("강화 실패 → 강화 지급도 함께 회수", revoked.line?.cancelled_at != null, {
    cancelled_at: revoked.line?.cancelled_at ?? null,
  });

  await reconcileLineResultAwardForUser(userId, lineId, weekId, true, null);
  const restored = await awards(userId, lineId);
  ck("재성공 → 평점 원장 재활성 + 원값 복원",
    restored.line_rating?.cancelled_at == null && restored.line_rating?.point_check === ev.rating,
    { cancelled_at: restored.line_rating?.cancelled_at ?? null, point_check: restored.line_rating?.point_check });
  ck("재성공 → 강화 지급도 복원", restored.line?.cancelled_at == null, {
    cancelled_at: restored.line?.cancelled_at ?? null,
  });

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

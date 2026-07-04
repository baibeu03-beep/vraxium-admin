/**
 * Action Control ↩ 실행 취소 — 변동(비정규) 액트 rollbackIrregularAct 직접(in-process) 검증.
 *
 *   [MG] 수동 부여 rollback = 실행 전(부재) 복원: 행 삭제 + 포인트 회수 + 대상 유저 snapshot 재계산.
 *   [RR] 링크 신청 rollback = 실행 전(검수 전 대기) 복원: status pending·scheduled_check_at=null·
 *        completed_at=null(행 유지) + recipients 삭제 → 다시 즉시 검수 가능(재테스트).
 *   [BLK] 예약 검수 시각 경과로 '표시상 자동 완료'(DB pending·워커 미실행)된 링크 신청 → 409 거부.
 *   [ISO] rollback 은 대상 유저만 snapshot 재계산(무관 유저 computed_at 불변) — 일반/데모 경로 무영향.
 *
 *   test 스코프 · encre 테스트 유저 · 합성 픽스처(무흔적 cleanup). org/mode 무관 동일 로직(여기선 test).
 *   npx tsx --env-file=.env.local scripts/verify-action-control-irregular-rollback.ts
 */
import { createClient } from "@supabase/supabase-js";
import {
  createManualGrant,
  getIrregularBoard,
  rollbackIrregularAct,
} from "@/lib/adminProcessIrregularData";
import { runDueProcessCheckSweep } from "@/lib/processCheckDueSweep";
import { ProcessMasterError } from "@/lib/adminProcessesData";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});
let pass = 0,
  fail = 0;
const ck = (l: string, ok: boolean, d = "") => {
  console.log(`${ok ? "✅" : "❌"} ${l}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};
const T = "process_irregular_acts";
const RECIP = "process_check_review_recipients";
const UWP = "user_weekly_points";
const SNAP = "cluster4_weekly_card_snapshots";
const QA_ADMIN = "c28b2409-4118-49fc-a42e-68e18dbd194c";
const ORG = "encre";
const TAG = "[QA] ac-irr-rollback";

async function dbRow(id: string) {
  const { data } = await sb
    .from(T)
    .select("id,status,completed_at,scheduled_check_at,kind")
    .eq("id", id)
    .maybeSingle();
  return data as { id: string; status: string; completed_at: string | null; scheduled_check_at: string | null; kind: string } | null;
}
async function recipCount(id: string) {
  const { count } = await sb.from(RECIP).select("id", { count: "exact", head: true }).eq("source", "irregular").eq("ref_id", id);
  return count ?? 0;
}
async function uwpPoints(userId: string, year: number, week: number) {
  const { data } = await sb.from(UWP).select("points,advantages,penalty").eq("user_id", userId).eq("year", year).eq("week_number", week).maybeSingle();
  return (data as { points: number; advantages: number; penalty: number } | null) ?? null;
}
async function snapComputedAt(userId: string) {
  const { data } = await sb.from(SNAP).select("computed_at").eq("user_id", userId).maybeSingle();
  return (data as { computed_at: string | null } | null)?.computed_at ?? null;
}

async function main() {
  // 전제 — encre 테스트 유저 2명(대상·대조). 쓰기 주차는 서비스가 결정(현재 주차)하므로
  //   생성 행에서 역추적한다(직접 주차 지정 금지 — 과거 주차 조회전용 가드에 걸림).
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const ids = (markers ?? []).map((r) => r.user_id);
  const { data: profs } = await sb.from("user_profiles").select("user_id").in("user_id", ids).eq("organization_slug", ORG).limit(2);
  const testers = (profs ?? []).map((p) => (p as { user_id: string }).user_id);
  if (testers.length < 2) {
    console.log("⚠ 전제 부족(encre 테스트 유저 2명) — skip");
    process.exit(0);
  }
  const target = testers[0];
  const control = testers[1];
  const seeded: string[] = [];

  try {
    // ── [MG] 수동 부여 rollback = 삭제 + 포인트 회수 + snapshot 재계산 ──────────────
    const control0 = await snapComputedAt(control);
    const mg = await createManualGrant({
      organization: ORG,
      mode: "test",
      adminId: QA_ADMIN,
      actName: `${TAG} 수동`,
      targetUserIds: [target],
      pointA: 5,
      pointB: 2,
      pointC: 0,
      crewReaction: "partial",
      pointMode: "ab",
    });
    seeded.push(mg.id);
    // 서비스가 쓴 실제 주차를 역추적 → 이후 RR/BLK 시드·uwp 조회에 재사용.
    const { data: mgWk } = await sb.from(T).select("week_id").eq("id", mg.id).maybeSingle();
    const writeWeekId = (mgWk as { week_id: string } | null)?.week_id ?? null;
    const { data: wkRow } = await sb.from("weeks").select("iso_year,iso_week").eq("id", writeWeekId).maybeSingle();
    const wk = wkRow as { iso_year: number; iso_week: number } | null;
    if (!writeWeekId || !wk) {
      ck("[전제] 현재 쓰기 주차 역추적", false, `weekId=${writeWeekId}`);
      throw new Error("write week resolve failed");
    }
    const mgDb0 = await dbRow(mg.id);
    const uwp0 = await uwpPoints(target, wk.iso_year, wk.iso_week);
    ck("[MG] 생성 completed · recipients 1", mgDb0?.status === "completed" && (await recipCount(mg.id)) === 1, `status=${mgDb0?.status}`);
    ck("[MG] 적립 반영(uwp points≥5)", (uwp0?.points ?? 0) >= 5, `uwp=${JSON.stringify(uwp0)}`);

    const rbMg = await rollbackIrregularAct(mg.id, ORG, "test");
    const mgDb1 = await dbRow(mg.id);
    const uwp1 = await uwpPoints(target, wk.iso_year, wk.iso_week);
    ck("[MG] rollback status=deleted · 행 삭제", rbMg.status === "deleted" && mgDb1 === null);
    ck("[MG] recipients 삭제", (await recipCount(mg.id)) === 0 && rbMg.recipientsDeleted === 1);
    ck("[MG] 포인트 회수(uwp points 감소)", (uwp1?.points ?? 0) === Math.max(0, (uwp0?.points ?? 0) - 5), `before=${uwp0?.points} after=${uwp1?.points}`);
    ck("[MG] revokedUserIds 대상 포함 · snapshot 재계산 보고", rbMg.revokedUserIds.includes(target) && (rbMg.recompute?.recomputed ?? 0) >= 1, JSON.stringify(rbMg.recompute));
    const control1 = await snapComputedAt(control);
    ck("[ISO] 무관(대조) 유저 snapshot computed_at 불변", control0 === control1, `${control0} == ${control1}`);
    seeded.pop(); // 이미 삭제됨

    // ── [RR] 링크 신청 rollback = 검수 전 대기 복원(행 유지·scheduled null·재테스트) ──
    const future = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const ins = await sb
      .from(T)
      .insert({
        organization_slug: ORG,
        week_id: writeWeekId,
        kind: "review_request",
        act_name: `${TAG} 검수`,
        applicant_admin_id: QA_ADMIN,
        applicant_admin_name: "QA",
        crew_reaction: "all",
        point_a: 0,
        point_b: 0,
        point_c: 0,
        review_link: "https://cafe.naver.com/qa-ac-irr",
        scheduled_check_at: future,
        status: "pending",
        scope_mode: "test",
        attempt_count: 0,
      })
      .select("id")
      .maybeSingle();
    const rrId = (ins.data as { id: string } | null)?.id ?? null;
    if (!rrId) {
      ck("[RR] 시드 실패 — skip", false, ins.error?.message);
    } else {
      seeded.push(rrId);
      // 즉시 검수(우회 + 주입 매칭) → 체크 완료 + recipients.
      const done = await runDueProcessCheckSweep({
        scope: "qa",
        onlyIds: [rrId],
        ignoreSchedule: true,
        ignoreRetryGate: true,
        accrue: null,
        crawlAndMatch: async () => ({ matched: [{ userId: target, nickname: "qa" }], review: [] }),
      });
      const rrDone = await dbRow(rrId);
      ck("[RR] 즉시 검수 → completed · recipients≥1", done.succeeded === 1 && rrDone?.status === "completed" && (await recipCount(rrId)) >= 1, `status=${rrDone?.status}`);

      const rbRr = await rollbackIrregularAct(rrId, ORG, "test");
      const rrBack = await dbRow(rrId);
      ck("[RR] rollback status=pending · 행 유지", rbRr.status === "pending" && rrBack !== null && rrBack.status === "pending");
      ck("[RR] scheduled_check_at=null · completed_at=null(재테스트 가능 상태)", rrBack?.scheduled_check_at === null && rrBack?.completed_at === null);
      ck("[RR] recipients 삭제", (await recipCount(rrId)) === 0);

      // 재테스트 — 다시 즉시 검수 가능(완료로 복귀).
      const redo = await runDueProcessCheckSweep({
        scope: "qa",
        onlyIds: [rrId],
        ignoreSchedule: true,
        ignoreRetryGate: true,
        accrue: null,
        crawlAndMatch: async () => ({ matched: [{ userId: target, nickname: "qa" }], review: [] }),
      });
      ck("[RR] 재검수(재테스트) → 다시 completed", redo.succeeded === 1 && (await dbRow(rrId))?.status === "completed");
    }

    // ── [BLK] 예약 검수 시각 경과(표시상 자동 완료·DB pending) → rollback 409 거부 ──
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const insBlk = await sb
      .from(T)
      .insert({
        organization_slug: ORG,
        week_id: writeWeekId,
        kind: "review_request",
        act_name: `${TAG} 자동완료`,
        applicant_admin_id: QA_ADMIN,
        applicant_admin_name: "QA",
        crew_reaction: "all",
        point_a: 0,
        point_b: 0,
        point_c: 0,
        review_link: "https://cafe.naver.com/qa-ac-irr-blk",
        scheduled_check_at: past,
        status: "pending",
        scope_mode: "test",
        attempt_count: 0,
      })
      .select("id")
      .maybeSingle();
    const blkId = (insBlk.data as { id: string } | null)?.id ?? null;
    if (blkId) {
      seeded.push(blkId);
      // 보드 DTO 상 autoCompleted=true(표시 완료) 확인.
      const board = await getIrregularBoard(ORG, "test", writeWeekId);
      const blkRow = (board.acts ?? []).find((a) => a.id === blkId);
      ck("[BLK] 보드 DTO autoCompleted=true(표시 완료·DB pending)", blkRow?.autoCompleted === true && blkRow?.status === "completed" && blkRow?.rawStatus === "pending");
      let threw = 0;
      try {
        await rollbackIrregularAct(blkId, ORG, "test");
      } catch (e) {
        threw = e instanceof ProcessMasterError ? e.status : -1;
      }
      ck("[BLK] rollback → 409 거부(되돌릴 실행 없음)", threw === 409, `status=${threw}`);
      ck("[BLK] DB 무변경(pending 유지)", (await dbRow(blkId))?.status === "pending");
    }
  } finally {
    if (seeded.length) {
      await sb.from(RECIP).delete().in("ref_id", seeded);
      await sb.from(T).delete().in("id", seeded);
    }
    const { count } = await sb
      .from(T)
      .select("id", { count: "exact", head: true })
      .like("act_name", `${TAG}%`);
    ck("[cleanup] 시드 삭제(무흔적)", (count ?? 0) === 0);
  }
  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

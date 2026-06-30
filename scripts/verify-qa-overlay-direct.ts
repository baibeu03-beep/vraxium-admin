/**
 * QA 오버레이 Phase A 직접(direct) 검증 — 실데이터 기반(시드 없음).
 *
 *   Section A (공표·검수): 미공표 주차에 QA 공표/검수 → qa_weeks_state 에만 기록, 운영 weeks 불변,
 *     growthLoader 가 테스트 유저에게만 공표 반영(read path), OFF 시 복귀.
 *   Section B (체크기준 → snapshot 카드 flip): 테스트 유저의 실제 공표완료·체크강제 성공 주차에
 *     QA check_threshold 를 earned 초과로 올려 카드 성공→실패 flip 을 관측(테스트 유저 snapshot 만
 *     QA 반영), 실유저 snapshot 불변, OFF 시 성공 복귀.
 *
 *   ⚠ "공표→집계중 flip" 은 '종료된 비휴식 미공표 주차'가 있어야 카드에 보이는데, 운영은 종료 즉시
 *     공표하므로 그런 주차가 현재 데이터에 없다(미공표 주차는 전부 진행중/휴식). 따라서 공표는
 *     테이블+read-path 로 검증하고, 카드 flip 은 동치 메커니즘인 체크기준(Section B)으로 관측한다.
 *
 *   선행: db/migrations/2026-06-30_qa_overlay_state.sql 적용.
 *   npx tsx --env-file=.env.local scripts/verify-qa-overlay-direct.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  resolveStateScopeForUser,
  applyQaWeekPublishOverlay,
  readQaWeekState,
} from "@/lib/operationalState";
import {
  publishWeekResult,
  markWeekResultReviewed,
  updateWeekCheckThreshold,
} from "@/lib/adminWeekRecognitionsData";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";
import { loadGrowthInput } from "@/lib/growthLoader";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`);
  if (!ok) failed++;
}
async function getWeekRow(weekId: string) {
  const { data } = await supabaseAdmin
    .from("weeks")
    .select("id,start_date,result_published_at,result_reviewed_at,check_threshold")
    .eq("id", weekId).maybeSingle();
  return data as any;
}
async function snapCards(userId: string): Promise<any[]> {
  const { data } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots").select("cards").eq("user_id", userId).maybeSingle();
  return ((data as any)?.cards ?? []) as any[];
}
async function snapComputedAt(userId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots").select("computed_at").eq("user_id", userId).maybeSingle();
  return (data as { computed_at: string } | null)?.computed_at ?? null;
}
async function recompute(userId: string) {
  await recomputeWeeklyCardsSnapshotsForUsers([userId], { concurrency: 1 });
}

async function main() {
  {
    const { error } = await supabaseAdmin.from("qa_weeks_state").select("week_id", { head: true, count: "exact" });
    if (error) { console.log(`❌ qa_weeks_state 미존재(${error.message}) — 마이그레이션 적용 후 재실행.`); process.exit(2); }
  }
  const testIds = await fetchTestUserMarkerIds();
  if (testIds.size === 0) { console.log("❌ test_user_markers 비어있음."); process.exit(2); }
  const testUser = [...testIds][0];
  const { data: realRows } = await supabaseAdmin
    .from("user_week_statuses").select("user_id").not("user_id", "in", `(${[...testIds].join(",")})`).limit(1);
  const realUser = (realRows?.[0] as { user_id: string } | undefined)?.user_id ?? null;

  // 1) 스코프 파생.
  check("scope(testUser)=qa", (await resolveStateScopeForUser(testUser)) === "qa", { testUser });
  if (realUser) check("scope(realUser)=operating", (await resolveStateScopeForUser(realUser)) === "operating", { realUser });

  // 2) overlay(operating) 무조회 단위.
  const fake = [{ id: "00000000-0000-0000-0000-000000000000", result_published_at: null }];
  check("overlay(operating) 원본 반환(무조회)", (await applyQaWeekPublishOverlay(fake, "operating")) === fake);

  // ── Section A: 공표/검수 (미공표 주차, 테이블 + read-path) ───────────────
  const { data: unpub } = await supabaseAdmin
    .from("weeks").select("id,start_date,result_published_at").is("result_published_at", null)
    .order("start_date", { ascending: false }).limit(1);
  const pubTarget = (unpub?.[0] as any) ?? null;
  if (!pubTarget) {
    console.log("⚠ 미공표 주차 없음 — Section A(공표/검수) 생략.");
  } else {
    console.log(`   [A] publish target week=${pubTarget.start_date} id=${pubTarget.id}`);
    const realComputedA = realUser ? await snapComputedAt(realUser) : null;
    try {
      // QA 공표.
      const pub = await publishWeekResult(pubTarget.id, "qa", null);
      check("[A] QA publish 응답 published_at 존재", Boolean(pub.result_published_at));
      check("[A] qa_weeks_state.result_published_at 기록", Boolean((await readQaWeekState(pubTarget.id))?.result_published_at));        // 항목4
      check("[A] 운영 weeks.result_published_at 불변(NULL)", ((await getWeekRow(pubTarget.id))?.result_published_at ?? null) == null); // 항목5
      const { data: logPub } = await supabaseAdmin.from("qa_action_log").select("action").eq("week_id", pubTarget.id).eq("action", "publish");
      check("[A] qa_action_log publish 기록", (logPub?.length ?? 0) >= 1);
      // read-path: 테스트 유저=공표 / 실유저=NULL.
      const tuW = (await loadGrowthInput(testUser, { includeWeeks: true })).weeks?.find((w) => w.id === pubTarget.id);
      check("[A] 테스트 유저 growthLoader 공표 반영(QA)", Boolean(tuW?.result_published_at));                                          // 항목7(read)
      if (realUser) {
        const ruW = (await loadGrowthInput(realUser, { includeWeeks: true })).weeks?.find((w) => w.id === pubTarget.id);
        check("[A] 실유저 growthLoader 공표 미반영(NULL)", (ruW?.result_published_at ?? null) == null);                                 // 항목10
      }
      // QA 검수(공표 후 가능).
      const rev = await markWeekResultReviewed(pubTarget.id, "qa", null);
      check("[A] QA review reviewed_at 존재", Boolean(rev.result_reviewed_at));
      check("[A] qa_weeks_state.result_reviewed_at 기록", Boolean((await readQaWeekState(pubTarget.id))?.result_reviewed_at));
      check("[A] 운영 weeks.result_reviewed_at 불변(NULL)", ((await getWeekRow(pubTarget.id))?.result_reviewed_at ?? null) == null);
      if (realUser) check("[A] 실유저 snapshot computed_at 불변", (await snapComputedAt(realUser)) === realComputedA);                  // 항목6
    } finally {
      await supabaseAdmin.from("qa_weeks_state").delete().eq("week_id", pubTarget.id);
      await supabaseAdmin.from("qa_action_log").delete().eq("week_id", pubTarget.id);
    }
    // OFF 복귀(read-path).
    const tuWoff = (await loadGrowthInput(testUser, { includeWeeks: true })).weeks?.find((w) => w.id === pubTarget.id);
    check("[A] OFF 후 테스트 유저 공표 baseline 복귀(NULL)", (tuWoff?.result_published_at ?? null) == null);                            // 항목8
  }

  // ── Section B: check_threshold → snapshot 카드 flip (실데이터) ───────────
  await recompute(testUser);
  const cards0 = await snapCards(testUser);
  const succWeek = cards0.find(
    (c) => c?.userWeekStatus === "success" && c?.experienceGrowth?.checkGate?.enforced === true && c?.experienceGrowth?.checkGate?.passed === true,
  );
  if (!succWeek) {
    console.log("⚠ 체크강제 성공 주차 미발견 — Section B(카드 flip) 생략.");
  } else {
    const wId = succWeek.weekId;
    const earned = succWeek.experienceGrowth.checkGate.earned as number;
    console.log(`   [B] flip target week=${succWeek.startDate} id=${wId} earned=${earned}`);
    const realCardsB = realUser ? JSON.stringify(await snapCards(realUser)) : "";
    const weekBefore = await getWeekRow(wId);
    try {
      // QA 기준값을 earned 초과로 → 그 주차만 fail 로 flip.
      await updateWeekCheckThreshold(wId, { check_threshold: earned + 50 }, "qa", null);
      check("[B] qa_weeks_state.check_threshold 기록", (await readQaWeekState(wId))?.check_threshold === earned + 50);
      check("[B] 운영 weeks.check_threshold 불변", ((await getWeekRow(wId))?.check_threshold ?? null) === (weekBefore?.check_threshold ?? null));
      await recompute(testUser);
      const cardAfter = (await snapCards(testUser)).find((c) => c.weekId === wId);
      check("[B] 테스트 유저 snapshot 카드 flip(성공→실패, QA 반영)", cardAfter?.userWeekStatus === "fail", { status: cardAfter?.userWeekStatus, label: cardAfter?.statusLabel }); // 항목7
      if (realUser) {
        check("[B] 실유저 snapshot 불변", JSON.stringify(await snapCards(realUser)) === realCardsB);                                    // 항목6/10
      }
    } finally {
      await supabaseAdmin.from("qa_weeks_state").delete().eq("week_id", wId);
      await supabaseAdmin.from("qa_action_log").delete().eq("week_id", wId);
      await recompute(testUser);
    }
    const cardRevert = (await snapCards(testUser)).find((c) => c.weekId === wId);
    check("[B] OFF 후 테스트 유저 카드 성공 복귀", cardRevert?.userWeekStatus === "success", { status: cardRevert?.userWeekStatus });   // 항목8
    check("[B] OFF 후 운영 weeks.check_threshold 불변", ((await getWeekRow(wId))?.check_threshold ?? null) === (weekBefore?.check_threshold ?? null));
  }

  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });

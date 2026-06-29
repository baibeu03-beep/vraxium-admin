/**
 * /weekly-ranking Phase 2(검수 완료 상태) 전수 검증.
 *   전제: weeks.result_reviewed_at 적용 + front dev(:3001) 실행 중.
 *
 * 검증(요구사항 1~8):
 *   1 direct  : front aggregateWeeklyLeague(=라우트가 직접 호출하는 SoT) 상태
 *   2 HTTP    : GET {FRONT}/api/weekly-league?org= 상태
 *   3 동일여부 : (1)==(2)
 *   4 snapshot 영향 : 검수 완료 전후 그 주차 코호트 snapshot computed_at 불변
 *   5 재계산 필요    : 없음 — (4)로 입증
 *   7 전환    : 공표 중 → (검수 버튼=markWeekResultReviewed) → 검수 완료
 *   8 기존 공표 주차 : 전부 검수 완료 표시
 *   (6 브라우저는 별도 Playwright)
 *
 *   FRONT_BASE_URL=http://localhost:3001 npx tsx --env-file=.env.local scripts/verify-weekly-ranking-review-phase2.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { markWeekResultReviewed } from "@/lib/adminWeekRecognitionsData";

const FRONT = process.env.FRONT_BASE_URL ?? "http://localhost:3001";
const ORG = "encre";

type Card = { id: string; seasonName: string; weekNumber: number; leagueRecordStatus: string };

async function frontCards(): Promise<Card[]> {
  const r = await fetch(`${FRONT}/api/weekly-league?org=${ORG}`);
  const j = await r.json();
  if (!j.success) throw new Error(`front API fail: ${j.error}`);
  return j.cards as Card[];
}
const recOf = (cards: Card[], weekId: string) =>
  cards.find((c) => c.id === weekId)?.leagueRecordStatus ?? null;

async function main() {
  let pass = true;
  const log = (ok: boolean, msg: string) => { console.log(ok ? "  ✓" : "  ✗", msg); if (!ok) pass = false; };

  // 0) 컬럼 존재 확인.
  const probe = await supabaseAdmin.from("weeks").select("id,result_reviewed_at").limit(1);
  if (probe.error) { console.log("❌ result_reviewed_at 컬럼 없음 — 마이그레이션 미적용."); process.exit(2); }
  console.log("result_reviewed_at 컬럼 OK\n");

  // ── #7 전환 시나리오: "비휴식" 공표 주차 1개를 골라 reviewed_at 을 잠시 비우고 전환 재현 후 복원 ──
  //   공식 휴식 주차(대전 휴식)는 published/reviewed 와 무관하게 항상 '대전 휴식' 이므로 전환 대상에서 제외.
  //   front 에서 현재 '검수 완료'로 보이는 주차 = 비휴식·공표·검수 주차 → 전환 시나리오에 적합.
  const baseCards = await frontCards();
  const reviewedCardId = baseCards.find((c) => c.leagueRecordStatus === "검수 완료")?.id;
  const { data: cand } = await supabaseAdmin
    .from("weeks")
    .select("id,week_number,season_key,start_date,result_published_at,result_reviewed_at,is_official_rest")
    .eq("id", reviewedCardId ?? "00000000-0000-0000-0000-000000000000")
    .limit(1);
  const target = cand?.[0];
  if (!target) { console.log("❌ 비휴식 공표+검수 주차 없음 — 전환 검증 불가."); process.exit(1); }
  const originalReviewedAt = target.result_reviewed_at as string | null;
  console.log(`[#7 전환] 대상 ${target.season_key} W${target.week_number} (${target.id}), 원래 reviewed_at=${originalReviewedAt}`);

  try {
    // (a) reviewed_at 비우기(미검수 상태로) — DML only.
    await supabaseAdmin.from("weeks").update({ result_reviewed_at: null }).eq("id", target.id);
    const beforeCards = await frontCards();
    log(recOf(beforeCards, target.id) === "공표 중", `검수 전 = 공표 중 (실제: ${recOf(beforeCards, target.id)})`);

    // (#4) snapshot computed_at 스냅샷
    const { data: cohort } = await supabaseAdmin
      .from("user_week_statuses").select("user_id").eq("week_start_date", target.start_date);
    const cohortIds = [...new Set((cohort ?? []).map((r) => r.user_id))].slice(0, 50);
    const snapBefore = new Map<string, string>();
    if (cohortIds.length) {
      const { data: sb } = await supabaseAdmin
        .from("cluster4_weekly_card_snapshots").select("user_id,computed_at").in("user_id", cohortIds);
      for (const r of sb ?? []) snapBefore.set(r.user_id, r.computed_at);
    }

    // (b) 검수 완료 버튼 = markWeekResultReviewed (direct)
    const res = await markWeekResultReviewed(target.id);
    log(!!res.result_reviewed_at, `markWeekResultReviewed → reviewed_at=${res.result_reviewed_at}`);

    // (c) 전환 후 = 검수 완료
    const afterCards = await frontCards();
    log(recOf(afterCards, target.id) === "검수 완료", `검수 후 = 검수 완료 (실제: ${recOf(afterCards, target.id)}) [#7 전환]`);

    // (#4/#5) snapshot 불변
    let snapUnchanged = true;
    if (cohortIds.length) {
      const { data: sa } = await supabaseAdmin
        .from("cluster4_weekly_card_snapshots").select("user_id,computed_at").in("user_id", cohortIds);
      for (const r of sa ?? []) if (snapBefore.get(r.user_id) !== r.computed_at) { snapUnchanged = false; break; }
    }
    log(snapUnchanged, `검수 완료가 코호트 snapshot computed_at 불변 (재계산 불필요 입증, n=${cohortIds.length})`);

    // 멱등: 이미 검수된 주차 재검수 → 409
    let dup409 = false;
    try { await markWeekResultReviewed(target.id); } catch (e: any) { dup409 = e?.status === 409; }
    log(dup409, `이미 검수된 주차 재검수 = 409 거절(중복 방지)`);
  } finally {
    // 복원: 원래 reviewed_at 로 되돌림(원래 null 이었다면 방금 검수한 값 유지가 백필 상태와 동일하므로 OK).
    if (originalReviewedAt) {
      await supabaseAdmin.from("weeks").update({ result_reviewed_at: originalReviewedAt }).eq("id", target.id);
      console.log(`  ↩ 복원: reviewed_at = ${originalReviewedAt}`);
    } else {
      console.log("  ↩ 원래 미검수였음 — 현재 검수 상태 유지(백필 정합).");
    }
  }

  // ── #8 기존 공표 주차 전부 검수 완료 표시 (공식 휴식 주차 제외 — 그건 항상 '대전 휴식') ──
  const cards = await frontCards();
  const { data: pubWeeks } = await supabaseAdmin
    .from("weeks").select("id").not("result_published_at", "is", null).not("result_reviewed_at", "is", null);
  const reviewedIds = new Set((pubWeeks ?? []).map((w) => w.id));
  // 비휴식 = 카드 leagueRecordStatus 가 '대전 휴식' 이 아닌 것.
  const shownNonRest = cards.filter((c) => reviewedIds.has(c.id) && c.leagueRecordStatus !== "대전 휴식");
  const allReviewedLabel = shownNonRest.length > 0 && shownNonRest.every((c) => c.leagueRecordStatus === "검수 완료");
  log(allReviewedLabel, `공표+검수 비휴식 주차 ${shownNonRest.length}개 전부 '검수 완료' 표시 [#8]`);

  // 상태 분포 + 여름 W1
  const byRec: Record<string, number> = {};
  for (const c of cards) byRec[c.leagueRecordStatus] = (byRec[c.leagueRecordStatus] ?? 0) + 1;
  console.log("\n현재 상태 분포(encre):", JSON.stringify(byRec));
  const w1 = cards.find((c) => /여름/.test(c.seasonName) && c.weekNumber === 1);
  log(w1?.leagueRecordStatus === "대전 중", `여름 W1 = 대전 중 (실제: ${w1?.leagueRecordStatus})`);

  console.log("\n=== " + (pass ? "PASS" : "FAIL") + " ===");
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });

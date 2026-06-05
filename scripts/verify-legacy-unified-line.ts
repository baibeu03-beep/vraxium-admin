/**
 * 레거시 통합 라인 정책 검증 (direct function 레벨).
 *   npx tsx --env-file=.env.local scripts/verify-legacy-unified-line.ts <userId> [<userId2> ...]
 *
 * 검사 항목 (start_date < 2026-06-29 레거시 주차):
 *   1) 실무 경험 라인 = 통합 라인 1개만 (lineName/mainTitle 일치) — 휴식/전환 주차 제외
 *   2) 실무 정보/역량/경력 = not_applicable placeholder 만 (라인 없음)
 *   3) 활동 주차 카드 상태 = success/fail 둘 중 하나 (테스터 기준 — 실유저는 rest 허용)
 *   4) 통합 라인 enhancementStatus ↔ 평점 정합 (4↑/미평가=success, ≤3=fail)
 *   5) 비레거시(여름 W1 이후) 주차는 게이트 미적용 (현재 데이터 없음 — 통과 확인용)
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { LEGACY_UNIFIED_LINE_NAME, CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM } from "@/lib/lineAvailability";

const UNIFIED_MAIN_TITLE =
  "한 주 동안 클럽에서 진행한 중앙, 팀 활동 내역을 아우르는 통합 기록입니다. (26년 6월 이전)";

async function verifyUser(userId: string): Promise<boolean> {
  console.log(`\n===== ${userId} =====`);
  const cards = await getCluster4WeeklyCardsForProfileUser(userId);
  let ok = true;
  const issue = (msg: string) => {
    ok = false;
    console.log(`  ✗ ${msg}`);
  };

  for (const c of cards) {
    const legacy = c.startDate < CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM;
    if (!legacy) continue;
    const isRest = c.userWeekStatus === "personal_rest" || c.userWeekStatus === "official_rest";
    const isJudged = c.userWeekStatus === "success" || c.userWeekStatus === "fail";
    const exp = c.lines.filter((l) => l.partType === "experience");
    const realExp = exp.filter((l) => l.lineId != null);
    const others = c.lines.filter((l) => l.partType !== "experience");

    // 2) 정보/역량/경력 — placeholder(na)만
    for (const l of others) {
      if (l.lineId != null || l.enhancementStatus !== "not_applicable") {
        issue(
          `${c.startDate} ${l.partType} 라인 존재/판정 잔존: lineId=${l.lineId} enh=${l.enhancementStatus}`,
        );
      }
    }

    if (c.isTransition) continue;
    if (isRest) {
      if (realExp.length > 0)
        issue(`${c.startDate} 휴식 주차에 경험 라인 ${realExp.length}개`);
      continue;
    }

    // 1) 경험 = 통합 라인 1개만
    if (realExp.length !== 1) {
      issue(`${c.startDate} 경험 실라인 ${realExp.length}개 (기대 1): ${realExp.map((l) => l.lineName).join("|")}`);
      continue;
    }
    const u = realExp[0];
    if (u.lineName !== LEGACY_UNIFIED_LINE_NAME) issue(`${c.startDate} lineName=${u.lineName}`);
    if (u.mainTitle !== UNIFIED_MAIN_TITLE) issue(`${c.startDate} mainTitle=${u.mainTitle}`);
    // placeholder 경험 칸(슬롯 fail/void) 이 남아있으면 안 됨
    if (exp.length !== realExp.length + 0 && exp.some((l) => l.lineId == null && l.enhancementStatus !== "not_applicable")) {
      issue(`${c.startDate} 경험 placeholder 잔존: ${exp.length}칸`);
    }

    // 4) 평점 ↔ 강화상태
    const r = u.experienceRating;
    const expected = u.lineTargetId == null ? "fail" : r != null && r <= 3 ? "fail" : "success";
    if (u.enhancementStatus !== expected) {
      issue(
        `${c.startDate} enh=${u.enhancementStatus} (기대 ${expected}, rating=${r}, target=${u.lineTargetId ? "Y" : "n"})`,
      );
    }

    // 3) 판정 주차 상태 — 통합 라인 기준과 카드 상태 정합 (확정 주차만)
    if (isJudged) {
      const expectStatus = expected === "success" ? "success" : "fail";
      if (c.userWeekStatus !== expectStatus) {
        issue(`${c.startDate} 카드상태=${c.userWeekStatus} vs 통합라인 기대=${expectStatus}`);
      }
    }
  }

  // 요약 출력
  const legacyCards = cards.filter((c) => c.startDate < CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM);
  const judged = legacyCards.filter((c) => !c.isTransition);
  const sCount = judged.filter((c) => c.userWeekStatus === "success").length;
  const fCount = judged.filter((c) => c.userWeekStatus === "fail").length;
  const restCount = judged.filter(
    (c) => c.userWeekStatus === "personal_rest" || c.userWeekStatus === "official_rest",
  ).length;
  const tallying = judged.filter((c) => c.userWeekStatus === "tallying" || c.userWeekStatus === "running").length;
  console.log(
    `  카드 ${cards.length} (레거시 ${legacyCards.length}) | success=${sCount} fail=${fCount} rest=${restCount} 진행/집계=${tallying} | ${ok ? "✓ PASS" : "✗ FAIL"}`,
  );
  return ok;
}

async function main() {
  const ids = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!ids.length) {
    console.error("usage: verify-legacy-unified-line.ts <userId> [...]");
    process.exit(1);
  }
  let allOk = true;
  for (const id of ids) {
    try {
      if (!(await verifyUser(id))) allOk = false;
    } catch (e) {
      allOk = false;
      console.error(`  ✗ ERROR ${id}:`, (e as Error).message);
    }
  }
  console.log(allOk ? "\n전체 PASS" : "\n전체 FAIL");
  process.exit(allOk ? 0 : 1);
}
main();

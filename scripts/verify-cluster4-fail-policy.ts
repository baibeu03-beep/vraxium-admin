/**
 * 최종 정책 검증 (실 DB DTO 기준) — 2026-06-02.
 *
 *   npx tsx --env-file=.env.local scripts/verify-cluster4-fail-policy.ts
 *
 * PART 1) 실무 경험: 미참여 / 평점<=3 / 평점>=4 각각의
 *         enhancementStatus · enhancementReason · 허브 강화율(A/B) · 주차 성장률 실제 DTO.
 * PART 2) info/experience synthetic fail line 의 전체 필드 노출 점검
 *         (라인필드 + 카드 레벨 supervisor/company/organization/date·week).
 * PART 3) 소급 적용: 저장 스냅샷(구 정책) vs 즉시 재계산(신 정책) enhancementStatus 비교 +
 *         테스트 사용자 1명 실제 recompute→재조회로 DB 반영 확인.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import {
  readWeeklyCardsSnapshot,
  recomputeAndStoreWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";
import type {
  Cluster4LineDetailDto,
  Cluster4WeeklyCardDto,
} from "@/shared/cluster4.contracts";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

type Hit = { l: Cluster4LineDetailDto; c: Cluster4WeeklyCardDto };

async function sampleUserIds(limit: number): Promise<string[]> {
  const { data } = await sb
    .from("cluster4_line_targets")
    .select("target_user_id")
    .eq("target_mode", "user")
    .not("target_user_id", "is", null)
    .limit(3000);
  return [
    ...new Set(((data ?? []) as { target_user_id: string }[]).map((r) => r.target_user_id)),
  ].slice(0, limit);
}

function expLineSummary(line: Cluster4LineDetailDto, card: Cluster4WeeklyCardDto) {
  return {
    week: card.weekLabel,
    enhancementStatus: line.enhancementStatus,
    enhancementReason: line.enhancementReason,
    experienceRating: line.experienceRating,
    status: line.status,
    lineTargetId: line.lineTargetId,
    "허브강화율 experience B/A": `${line.numerator}/${line.denominator} (rate=${line.rate})`,
    "주차성장률 (전 허브) B/A": `${card.growthNumerator}/${card.growthDenominator} (rate=${card.weeklyGrowthRate})`,
  };
}

async function part1() {
  console.log("\n══════════════ PART 1) 실무 경험 3케이스 실제 DTO ══════════════");
  const users = await sampleUserIds(60);
  const missedArr: Hit[] = [];
  const le3Arr: Hit[] = [];
  const ge4Arr: Hit[] = [];

  for (const uid of users) {
    let cards: Cluster4WeeklyCardDto[];
    try {
      cards = await getCluster4WeeklyCardsForProfileUser(uid);
    } catch {
      continue;
    }
    for (const c of cards) {
      for (const l of c.lines) {
        if (l.partType !== "experience") continue;
        if (l.lineTargetId === null && l.enhancementStatus === "fail") missedArr.push({ l, c });
        if (l.lineTargetId !== null && l.experienceRating != null) {
          if (l.experienceRating <= 3) le3Arr.push({ l, c });
          else if (l.experienceRating >= 4) ge4Arr.push({ l, c });
        }
      }
    }
    if (missedArr.length && le3Arr.length && ge4Arr.length) break;
  }
  const missed = missedArr[0] ?? null;
  const le3 = le3Arr[0] ?? null;
  const ge4 = ge4Arr[0] ?? null;

  console.log("\n[미참여 = 라인 개설 + 본인 미배정]");
  console.log(missed ? expLineSummary(missed.l, missed.c) : "  표본 없음(미참여 experience 라인 없음)");
  console.log("\n[평점 3점 이하 = 본인 배정 + 마감 후 + rating<=3]");
  console.log(le3 ? expLineSummary(le3.l, le3.c) : "  표본 없음(rating<=3 배정 라인 없음 — 마감 전이면 pending 으로 분류)");
  console.log("\n[평점 4점 이상 = 본인 배정 + 마감 후 + rating>=4]");
  console.log(ge4 ? expLineSummary(ge4.l, ge4.c) : "  표본 없음(rating>=4 배정 라인 없음)");

  // 기대값 단언(표본 존재 시)
  if (missed) {
    console.log(
      `  → 미참여 기대: fail / target_missing_required → ${missed.l.enhancementStatus === "fail" && missed.l.enhancementReason === "target_missing_required" ? "✅" : "❌"}`,
    );
  }
  if (le3) {
    const closed = le3.l.submissionClosesAt && Date.now() > new Date(le3.l.submissionClosesAt).getTime();
    console.log(
      `  → rating<=3 기대(마감후): fail / experience_rating_fail (마감여부=${closed}) → ${
        closed ? (le3.l.enhancementStatus === "fail" && le3.l.enhancementReason === "experience_rating_fail" ? "✅" : "❌") : "마감 전이라 pending 정상"
      }`,
    );
  }
  if (ge4) {
    const closed = ge4.l.submissionClosesAt && Date.now() > new Date(ge4.l.submissionClosesAt).getTime();
    console.log(
      `  → rating>=4 기대(마감후): success → ${
        closed ? (ge4.l.enhancementStatus === "success" ? "✅" : "❌") : "마감 전이라 pending 정상"
      }`,
    );
  }
}

async function part2() {
  console.log("\n══════════════ PART 2) synthetic fail line 전체 필드 노출 ══════════════");
  const users = await sampleUserIds(60);
  const infoArr: Hit[] = [];
  const expArr: Hit[] = [];
  for (const uid of users) {
    let cards: Cluster4WeeklyCardDto[];
    try {
      cards = await getCluster4WeeklyCardsForProfileUser(uid);
    } catch {
      continue;
    }
    for (const c of cards) {
      for (const l of c.lines) {
        if (l.lineTargetId !== null || l.enhancementStatus !== "fail") continue;
        if (l.partType === "information") infoArr.push({ l, c });
        if (l.partType === "experience") expArr.push({ l, c });
      }
    }
    if (infoArr.length && expArr.length) break;
  }
  const infoFail = infoArr[0] ?? null;
  const expFail = expArr[0] ?? null;

  const dump = (name: string, hit: Hit | null) => {
    console.log(`\n──── ${name} synthetic fail line 전체 DTO ────`);
    if (!hit) {
      console.log("  표본 없음");
      return;
    }
    console.log("LINE FIELDS:", JSON.stringify(hit.l, null, 2));
    console.log("CARD-LEVEL (고객앱 표시) FIELDS:", JSON.stringify({
      weekId: hit.c.weekId,
      weekNumber: hit.c.weekNumber,
      weekLabel: hit.c.weekLabel,
      displayTitle: hit.c.displayTitle,
      startDate: hit.c.startDate,
      endDate: hit.c.endDate,
      teamName: hit.c.teamName,
      partName: hit.c.partName,
      roleLabel: hit.c.roleLabel,
      // line 레벨 sponsor-card(company/supervisor) — career 전용. info/experience 는 null 이 정상.
      companyName: hit.l.companyName,
      supervisorName: hit.l.supervisorName,
      careerProjectId: hit.l.careerProjectId,
    }, null, 2));
    // 핵심 4필드 + 노출성 점검
    const okContent = Boolean(hit.l.mainTitle) && hit.l.status !== "void";
    console.log(`  content 노출(보이드 아님): ${okContent ? "✅" : "❌"} | mainTitle=${JSON.stringify(hit.l.mainTitle)} lineCode=${JSON.stringify(hit.l.lineCode)} outputLinks=${hit.l.outputLinks.length} outputImages=${hit.l.outputImages.length}`);
    console.log("  ※ supervisor/company 는 career 전용 sponsor-card 필드 → info/experience 에서는 null 이 정상.");
    console.log("  ※ organization/date·week 는 카드 레벨 필드로 정상 노출(위 CARD-LEVEL 참고).");
  };
  dump("information", infoFail);
  dump("experience", expFail);
}

async function part3() {
  console.log("\n══════════════ PART 3) 소급 적용(스냅샷 재계산) ══════════════");
  // 미참여 fail 또는 신정책 영향 라인을 가진 사용자 1명 찾기 (fresh 기준).
  const users = await sampleUserIds(60);
  let target: { uid: string; fresh: Cluster4WeeklyCardDto[] } | null = null;
  for (const uid of users) {
    let fresh: Cluster4WeeklyCardDto[];
    try {
      fresh = await getCluster4WeeklyCardsForProfileUser(uid);
    } catch {
      continue;
    }
    const hasNewFail = fresh.some((c) =>
      c.lines.some((l) => l.lineTargetId === null && l.enhancementStatus === "fail" && (l.partType === "information" || l.partType === "experience" || l.partType === "competency")),
    );
    if (hasNewFail) {
      target = { uid, fresh };
      break;
    }
  }
  if (!target) {
    console.log("  표본 없음 — synthetic fail 보유 사용자 미발견");
    return;
  }

  // (a) 비파괴 before/after: 저장 스냅샷(구 정책) vs fresh(신 정책)
  const stored = await readWeeklyCardsSnapshot(target.uid);
  const failKey = (cards: Cluster4WeeklyCardDto[]) => {
    const s = new Set<string>();
    for (const c of cards)
      for (const l of c.lines)
        if (l.enhancementStatus === "fail")
          s.add(`${c.weekId}:${l.partType}:${l.lineId ?? l.lineTargetId ?? "syn"}`);
    return s;
  };
  const freshFails = failKey(target.fresh);
  console.log(`\n사용자 ${target.uid}`);
  console.log(`스냅샷 상태: ${stored.status}${"reason" in stored ? `(${stored.reason})` : ""}`);
  if (stored.status === "hit" || stored.status === "stale") {
    const storedFails = failKey(stored.cards);
    console.log(`저장 스냅샷(구) fail 라인 수: ${storedFails.size}`);
    console.log(`fresh(신 정책) fail 라인 수: ${freshFails.size}`);
    const newlyFail = [...freshFails].filter((k) => !storedFails.has(k));
    console.log(`신규로 fail 된 라인: ${newlyFail.length}건`);
    console.log(`  샘플: ${JSON.stringify(newlyFail.slice(0, 5))}`);
    console.log(`  → 소급 적용(구 스냅샷엔 없던 fail 이 fresh 에 존재): ${newlyFail.length > 0 ? "✅" : "ℹ️ 동일(이미 fail 이었거나 변화 없음)"}`);
  } else {
    console.log(`저장 스냅샷 없음 → fresh(신 정책) fail 라인 수: ${freshFails.size}`);
  }

  // (b) 테스트 사용자(display_name ILIKE '%T%') 1명에 실제 recompute → 재조회로 DB 반영 확인.
  const { data: tprof } = await sb
    .from("user_profiles")
    .select("user_id,display_name")
    .ilike("display_name", "%T%")
    .limit(50);
  let testUid: string | null = null;
  for (const p of (tprof ?? []) as { user_id: string }[]) {
    try {
      const cards = await getCluster4WeeklyCardsForProfileUser(p.user_id);
      if (cards.some((c) => c.lines.some((l) => l.lineTargetId === null && l.enhancementStatus === "fail" && (l.partType === "information" || l.partType === "experience" || l.partType === "competency")))) {
        testUid = p.user_id;
        break;
      }
    } catch {
      /* skip */
    }
  }
  if (!testUid) {
    console.log("\n(b) 테스트 사용자(%T%) 중 synthetic fail 보유자 없음 — 실 recompute write 생략(비파괴).");
    return;
  }
  console.log(`\n(b) 테스트 사용자 ${testUid} 실제 recompute → 재조회`);
  await recomputeAndStoreWeeklyCardsSnapshot(testUid);
  const after = await readWeeklyCardsSnapshot(testUid);
  if (after.status === "hit" || after.status === "stale") {
    const afterFails = failKey(after.cards);
    console.log(`  재계산 후 저장 스냅샷 상태=${after.status}, fail 라인 수=${afterFails.size}`);
    console.log(`  → 재계산 후 스냅샷에 fail enhancementStatus 반영: ${afterFails.size > 0 ? "✅" : "❌"}`);
  } else {
    console.log(`  재계산 후 스냅샷 읽기 상태=${after.status}`);
  }
}

async function main() {
  await part1();
  await part2();
  await part3();
  console.log("\n══════════════ 검증 종료 ══════════════");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

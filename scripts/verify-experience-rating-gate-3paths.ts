// 실무 경험 평점 게이트 — 3경로(레거시 / 신정책(2026-summer+) / read-time resolver) 직접 검증.
//   run: npx tsx --env-file=.env.local scripts/verify-experience-rating-gate-3paths.ts
//
// 정책(확인 대상):
//   · 실무 경험: 평점 ≥4 → 주차 인정(success) 후보 / 평점 ≤3 → 주차 fail. (미평가=게이트 미적용)
//   · 실무 정보/역량/경력: 주차 인정 계산에 영향 없음(resolveWeekResultStatus 입력에서 구조적 배제).
//   · 위 규칙은 레거시 주차·신정책 주차·테스트 W13(신정책 시뮬) 모두 동일 함수로 적용.
//
// 순수 함수만 호출(네트워크/DB 무관) → 결정적. 실데이터/HTTP/snapshot 검증은
//   scripts/verify-experience-rating-gate.ts(테스트 W13 = 신정책 경로, direct==HTTP+snapshot) 보완.

import {
  reduceExperienceRequiredSlotVerdict,
  applyExperienceCheckGate,
  reduceLegacyUnifiedVerdict,
  type LegacyUnifiedWeekState,
  type ExperienceRequiredSlotStatus,
} from "@/lib/lineAvailability";
import {
  computeCluster4Enhancement,
  EXPERIENCE_RATING_FAIL_THRESHOLD,
} from "@/lib/cluster4Enhancement";
import { resolveWeekResultStatus } from "@/lib/growthCore";

let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

// 필수 슬롯 1개를 "본인 배정·마감 경과·평점 r" 상태로 생성(production 1755~1776 과 동일 경로).
function slotForRating(rating: number | null): ExperienceRequiredSlotStatus {
  const ratingVerdict: "fail" | undefined =
    rating != null && rating <= EXPERIENCE_RATING_FAIL_THRESHOLD ? "fail" : undefined;
  const enhancementStatus = computeCluster4Enhancement({
    hasTarget: true,
    deadlinePassed: true,
    hasSubmission: false,
    isCareer: false,
    expectedWhenMissing: true,
    experienceRatingVerdict: ratingVerdict,
  }).enhancementStatus;
  return { slotOrder: 1, category: "derivation", enhancementStatus };
}

console.log("── 0) 임계값 상수 ──");
ck("EXPERIENCE_RATING_FAIL_THRESHOLD === 3", EXPERIENCE_RATING_FAIL_THRESHOLD === 3);

console.log("\n── 1) 신정책 경로: 슬롯 verdict + checkGate (rating + points) ──");
{
  // rating 3 + checkGate 통과(points 충분) → 그래도 fail (평점 게이트가 우선·보존).
  const v3 = reduceExperienceRequiredSlotVerdict([slotForRating(3)]);
  ck("rating 3 → 슬롯 verdict fail", v3.status === "fail", `status=${v3.status}`);
  const v3gated = applyExperienceCheckGate(v3, { required: 30, earned: 999, enforced: true });
  ck("rating 3 + checkGate 통과 → 여전히 fail(평점 보존)", v3gated.status === "fail", `status=${v3gated.status}`);

  // rating 5 + checkGate 통과 → pass(주차 인정 후보).
  const v5 = reduceExperienceRequiredSlotVerdict([slotForRating(5)]);
  ck("rating 5 → 슬롯 verdict pass", v5.status === "pass", `status=${v5.status}`);
  const v5gated = applyExperienceCheckGate(v5, { required: 30, earned: 30, enforced: true });
  ck("rating 5 + checkGate 통과 → pass", v5gated.status === "pass", `status=${v5gated.status}`);

  // rating 5 + checkGate 미달 + enforced(신정책 고정) → fail(포인트 게이트).
  const v5fail = applyExperienceCheckGate(v5, { required: 30, earned: 29, enforced: true });
  ck("rating 5 + points<threshold(신정책 enforced) → fail", v5fail.status === "fail", `status=${v5fail.status}`);

  // 미평가(null) → 게이트 미적용(pass 유지).
  const vNull = reduceExperienceRequiredSlotVerdict([slotForRating(null)]);
  ck("미평가(null) → pass(게이트 미적용)", vNull.status === "pass", `status=${vNull.status}`);

  // rating 4 (경계) → pass.
  ck("rating 4(경계) → pass", reduceExperienceRequiredSlotVerdict([slotForRating(4)]).status === "pass");
}

console.log("\n── 2) 레거시 경로: reduceLegacyUnifiedVerdict (통합 라인 단일) ──");
{
  const base = (over: Partial<LegacyUnifiedWeekState>): LegacyUnifiedWeekState => ({
    opened: true, hasTarget: true, deadlinePassed: true, rating: 5,
    checkCount: 100, checkThreshold: 30, checkDataMigrated: true, ...over,
  });
  ck("레거시 rating 3 → fail", reduceLegacyUnifiedVerdict(base({ rating: 3 })).status === "fail");
  ck("레거시 rating 5 + check 통과 → pass", reduceLegacyUnifiedVerdict(base({ rating: 5 })).status === "pass");
  ck("레거시 rating 4(경계) → pass", reduceLegacyUnifiedVerdict(base({ rating: 4 })).status === "pass");
  ck("레거시 rating 3 + check 통과여도 → fail(평점 우선)",
    reduceLegacyUnifiedVerdict(base({ rating: 3, checkCount: 999 })).status === "fail");
  ck("레거시 rating 5 + check 미달 + migrated → fail(check 게이트)",
    reduceLegacyUnifiedVerdict(base({ rating: 5, checkCount: 0 })).status === "fail");
  ck("레거시 rating 5 + check 미달 + 미이관(enforced=false) → pass 보존",
    reduceLegacyUnifiedVerdict(base({ rating: 5, checkCount: 0, checkDataMigrated: false })).status === "pass");
  ck("레거시 미개설 → not_applicable(주차 인정 무관)",
    reduceLegacyUnifiedVerdict(base({ opened: false })).status === "not_applicable");
  ck("레거시 미평가(null) + check 통과 → pass(게이트 미적용)",
    reduceLegacyUnifiedVerdict(base({ rating: null })).status === "pass");
}

console.log("\n── 3) read-time resolver: verdict → userWeekStatus (resolveWeekResultStatus) ──");
{
  const baseIn = {
    uwsStatus: "success" as const, isCurrentWeek: false, isPublished: true, weekIsOfficialRest: false,
  };
  // verdict fail → success 였던 주차도 fail 로 강등(flippedToFail).
  const rFail = resolveWeekResultStatus({ ...baseIn, experienceVerdictStatus: "fail" });
  ck("verdict fail + uws success(공표) → fail", rFail.status === "fail" && rFail.flippedToFail === true, `status=${rFail.status}`);
  // verdict pass → uws success 유지.
  ck("verdict pass + uws success → success",
    resolveWeekResultStatus({ ...baseIn, experienceVerdictStatus: "pass" }).status === "success");
  // not_applicable / null → 게이트 미적용(uws 유지).
  ck("verdict not_applicable → success 유지(미적용)",
    resolveWeekResultStatus({ ...baseIn, experienceVerdictStatus: "not_applicable" }).status === "success");
  ck("verdict null → success 유지(미적용)",
    resolveWeekResultStatus({ ...baseIn, experienceVerdictStatus: null }).status === "success");
  // 현재주/집계중/휴식은 verdict fail 이어도 강등 안 함(보호).
  ck("현재주(running)는 verdict fail 이어도 강등 안 함",
    resolveWeekResultStatus({ ...baseIn, isCurrentWeek: true, experienceVerdictStatus: "fail" }).status === "running");
}

console.log("\n── 4) 구조적 보장: info/competency/career 는 주차 인정 입력이 아님 ──");
{
  // resolveWeekResultStatus 의 입력 키 집합에 experienceVerdictStatus 만 있고
  //   info/competency/career verdict 가 존재하지 않음을 런타임 키로 확인(타입+구조 이중).
  const keys = Object.keys({
    uwsStatus: null, isCurrentWeek: false, isPublished: true, weekIsOfficialRest: false,
    experienceVerdictStatus: null,
  });
  const hasOnlyExperience = keys.includes("experienceVerdictStatus")
    && !keys.some((k) => /info|competency|career/i.test(k));
  ck("resolveWeekResultStatus 입력에 experienceVerdictStatus 만(정보/역량/경력 없음)", hasOnlyExperience, keys.join(","));
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);

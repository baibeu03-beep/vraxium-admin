/**
 * 크루 "라인 강화 내역" projection 단위 검증 (순수 함수 — DB/서버 불필요).
 *
 *   pnpm tsx scripts/verify-crew-line-enhancement-projection.ts
 *   (또는) npx tsx scripts/verify-crew-line-enhancement-projection.ts
 *
 * 검증 대상 = lib/crewLineEnhancementProjection.ts projectCrewLineEnhancement().
 * 요구 §11 케이스 1~7 + 불변식 + 관리자 전용 필드 비노출.
 */

import {
  projectCrewLineEnhancement,
  type CrewWeekLineEnhancementDetailDto,
} from "../lib/crewLineEnhancementProjection";
import type {
  CrewWeekLineDetailRow,
  CrewWeekLineSummaryDto,
} from "../lib/adminCrewWeekLineSummary";
import type { Cluster4LinePartType } from "../shared/cluster4.contracts";

let failures = 0;
let checks = 0;

function check(label: string, actual: unknown, expected: unknown) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`  ✗ ${label}\n      expected: ${e}\n      actual:   ${a}`);
  } else {
    console.log(`  ✓ ${label} = ${a}`);
  }
}

function ok(label: string, cond: boolean) {
  checks++;
  if (!cond) {
    failures++;
    console.error(`  ✗ ${label}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
}

const HUB_LABEL: Record<Cluster4LinePartType, string> = {
  information: "실무 정보",
  experience: "실무 경험",
  competency: "실무 역량",
  career: "실무 경력",
};

// 최소 필드만 지정하고 나머지는 기본값으로 채우는 행 팩토리.
function makeRow(p: Partial<CrewWeekLineDetailRow> & { partType: Cluster4LinePartType }): CrewWeekLineDetailRow {
  return {
    lineId: p.lineId ?? "line-1",
    lineTargetId: p.lineTargetId ?? null,
    partType: p.partType,
    type: p.type ?? "일반",
    hubLabel: p.hubLabel ?? HUB_LABEL[p.partType],
    lineName: p.lineName ?? "라인",
    displayLineCode: p.displayLineCode ?? null,
    clubOpen: p.clubOpen ?? true,
    isCompetencyPlaceholder: p.isCompetencyPlaceholder ?? false,
    isExperiencePlaceholder: p.isExperiencePlaceholder ?? false,
    experienceCategory: p.experienceCategory ?? null,
    enhancementStatus: p.enhancementStatus ?? "success",
    enhancementLabel: p.enhancementLabel ?? "강화 성공",
    enhancementReason: p.enhancementReason ?? "target_exists_after_deadline",
    submissionStatus: p.submissionStatus ?? "not_required",
    rating: p.rating ?? null,
    careerGradePoints: p.careerGradePoints ?? null,
    estimatedDurationMinutes: p.estimatedDurationMinutes ?? null,
    earnedA: p.earnedA ?? 0,
    earnedB: p.earnedB ?? 0,
    earnedC: p.earnedC ?? 0,
    possibleA: p.possibleA ?? 0,
    possibleB: p.possibleB ?? 0,
    possibleC: p.possibleC ?? 0,
    // ── 관리자 전용(투영에서 제거되어야 하는) 필드 ──
    overrideAllowed: p.overrideAllowed ?? true,
    eligible: p.eligible ?? true,
    effectiveCanEdit: p.effectiveCanEdit ?? true,
    submission: p.submission ?? ({ subtitle: "비밀" } as CrewWeekLineDetailRow["submission"]),
    submissionOpensAt: p.submissionOpensAt ?? "2026-01-01T00:00:00Z",
    submissionClosesAt: p.submissionClosesAt ?? "2026-01-02T00:00:00Z",
  };
}

function makeSummary(lineDetails: CrewWeekLineDetailRow[]): CrewWeekLineSummaryDto {
  return {
    organizationSlug: "phalanx",
    weeklyGrowthRate: 0,
    confirmed: true,
    isRestWeek: false,
    lines: { total: lineDetails.length, open: 0, unopened: 0 },
    results: { success: 0, failure: 0, notApplicable: 0, pending: 0 },
    points: {
      pointA: { earned: 0, possible: 0 },
      pointB: { earned: 0, possible: 0 },
      pointC: { earned: 0, possible: 0 },
    },
    lineDetails,
    canManageSecondEntry: true,
  };
}

function project(rows: CrewWeekLineDetailRow[]): CrewWeekLineEnhancementDetailDto {
  return projectCrewLineEnhancement({
    userId: "u-1",
    weekId: "w-1",
    summary: makeSummary(rows),
  });
}

// 배정(크루 대상) 행 / 비배정(클럽만 오픈) 행 헬퍼
const assigned = (p: Partial<CrewWeekLineDetailRow> & { partType: Cluster4LinePartType }) =>
  makeRow({ ...p, lineTargetId: p.lineTargetId ?? "t-1" });
const unassigned = (p: Partial<CrewWeekLineDetailRow> & { partType: Cluster4LinePartType }) =>
  makeRow({ ...p, lineTargetId: null });

// 모든 케이스 공통 불변식.
function assertInvariants(dto: CrewWeekLineEnhancementDetailDto, label: string) {
  const s = dto.summary;
  ok(
    `${label}: rows.length === clubOpenCount`,
    dto.rows.length === s.clubOpenCount,
  );
  ok(
    `${label}: clubOpen === success + failure + notApplicable + pending`,
    s.clubOpenCount === s.successCount + s.failureCount + s.notApplicableCount + s.pendingCount,
  );
  ok(
    `${label}: crewOpen === success + failure + pending`,
    s.crewOpenCount === s.successCount + s.failureCount + s.pendingCount,
  );
  ok(
    `${label}: notApplicable === clubOpen - crewOpen`,
    s.notApplicableCount === s.clubOpenCount - s.crewOpenCount,
  );
  const sum = (pick: (r: (typeof dto.rows)[number]) => number) =>
    dto.rows.reduce((n, r) => n + pick(r), 0);
  ok(`${label}: ΣrowsA.earned === summary A.earned`, sum((r) => r.pointA.earned) === s.pointA.earned);
  ok(`${label}: ΣrowsA.available === summary A.available`, sum((r) => r.pointA.available) === s.pointA.available);
  ok(`${label}: ΣrowsB.earned === summary B.earned`, sum((r) => r.pointB.earned) === s.pointB.earned);
  ok(`${label}: ΣrowsB.available === summary B.available`, sum((r) => r.pointB.available) === s.pointB.available);
  // v2 — C 도 A/B 와 동일한 Σ 규칙(값이 0 이어도 규칙은 같다).
  ok(`${label}: ΣrowsC.earned === summary C.earned`, sum((r) => r.pointC.earned) === s.pointC.earned);
  ok(`${label}: ΣrowsC.available === summary C.available`, sum((r) => r.pointC.available) === s.pointC.available);
}

console.log("\n[케이스 1] 클럽 오픈 8 / 크루 대상 5 (성공 4, 실패 1) / 해당 없음 3");
{
  const rows = [
    ...Array.from({ length: 4 }, (_, i) =>
      assigned({ partType: "information", lineId: `s${i}`, enhancementStatus: "success" }),
    ),
    assigned({ partType: "information", lineId: "f0", enhancementStatus: "fail" }),
    ...Array.from({ length: 3 }, (_, i) =>
      // 클럽 오픈 + 비배정 → 해당 없음(요구 §4). admin 원천은 fail 이어도 크루 표는 해당 없음.
      unassigned({ partType: "experience", lineId: `n${i}`, enhancementStatus: "fail" }),
    ),
  ];
  const dto = project(rows);
  check("clubOpenCount", dto.summary.clubOpenCount, 8);
  check("crewOpenCount", dto.summary.crewOpenCount, 5);
  check("successCount", dto.summary.successCount, 4);
  check("failureCount", dto.summary.failureCount, 1);
  check("notApplicableCount", dto.summary.notApplicableCount, 3);
  check("enhancementRate (4/5)", dto.summary.enhancementRate, 80);
  assertInvariants(dto, "케이스1");
}

console.log("\n[케이스 2] 전부 해당 없음 — 클럽 오픈 3 / 크루 대상 0");
{
  const rows = Array.from({ length: 3 }, (_, i) =>
    unassigned({ partType: "experience", lineId: `n${i}`, enhancementStatus: "fail" }),
  );
  const dto = project(rows);
  check("successCount", dto.summary.successCount, 0);
  check("failureCount", dto.summary.failureCount, 0);
  check("notApplicableCount", dto.summary.notApplicableCount, 3);
  check("crewOpenCount", dto.summary.crewOpenCount, 0);
  check("enhancementRate (분모 0 → 0, 100 금지)", dto.summary.enhancementRate, 0);
  assertInvariants(dto, "케이스2");
}

console.log("\n[케이스 3] 오픈 라인 없음 — 미오픈 master 행만 존재");
{
  // 미오픈(clubOpen=false) 정보 카탈로그 8행 → 크루 표에서 전부 제외되어야 한다(요구 §6).
  const rows = Array.from({ length: 8 }, (_, i) =>
    makeRow({
      partType: "information",
      lineId: null,
      lineTargetId: null,
      clubOpen: false,
      enhancementStatus: "not_applicable",
    }),
  );
  const dto = project(rows);
  check("rows.length (미오픈 master 제외)", dto.rows.length, 0);
  check("clubOpenCount", dto.summary.clubOpenCount, 0);
  check("crewOpenCount", dto.summary.crewOpenCount, 0);
  check("successCount", dto.summary.successCount, 0);
  check("failureCount", dto.summary.failureCount, 0);
  check("notApplicableCount", dto.summary.notApplicableCount, 0);
  check("enhancementRate", dto.summary.enhancementRate, 0);
  check("pointA", dto.summary.pointA, { earned: 0, available: 0 });
  check("pointB", dto.summary.pointB, { earned: 0, available: 0 });
  assertInvariants(dto, "케이스3");
}

console.log("\n[케이스 4] 포인트 합계 — 행별 earned/available 합 === summary");
{
  const rows = [
    assigned({ partType: "information", lineId: "a", earnedA: 2, possibleA: 2, earnedB: 1, possibleB: 3 }),
    assigned({ partType: "career", lineId: "b", enhancementStatus: "fail", earnedA: 0, possibleA: 1, earnedB: 0, possibleB: 2 }),
    // 해당 없음 행도 클럽 오픈이면 가능치가 있다 → "0 / N" (성공 행만 합산 금지).
    unassigned({ partType: "experience", lineId: "c", enhancementStatus: "fail", earnedA: 0, possibleA: 5, earnedB: 0, possibleB: 4 }),
  ];
  const dto = project(rows);
  check("summary.pointA", dto.summary.pointA, { earned: 2, available: 8 });
  check("summary.pointB", dto.summary.pointB, { earned: 1, available: 9 });
  check("해당없음 행 pointA (0 / N)", dto.rows[2].pointA, { earned: 0, available: 5 });
  assertInvariants(dto, "케이스4");
}

console.log("\n[케이스 5] 평점 — 허브별 SoT 선택(0 과 null 구분)");
{
  // v2(2026-07-17): 경력 평점 원천 = careerGradePoints(등급 S/A/B/C/D → 10/8/6/4/2).
  //   경험 rating 과 같은 0~10 축이라 같은 열에 나란히 표시한다. 정보/역량은 원천이 NULL 강제 → "-".
  const rows = [
    assigned({ partType: "experience", lineId: "e1", rating: 7 }),
    assigned({ partType: "experience", lineId: "e0", rating: 0 }), // 0 = 실제 평점(널 아님)
    assigned({ partType: "information", lineId: "i1", rating: null }),
    assigned({ partType: "competency", lineId: "c1", rating: null }),
    // 경력: rating 컬럼은 항상 null 이고 등급 환산 점수만 존재(B=6).
    assigned({ partType: "career", lineId: "r1", rating: null, careerGradePoints: 6 }),
    // 경력 미평가(grade 미입력) → 등급 점수 없음 → "-".
    assigned({ partType: "career", lineId: "r2", rating: null, careerGradePoints: null }),
    // 경력 D(2점) — 강화 실패 등급도 숫자로 그대로 표시한다(0 과 혼동 금지).
    assigned({ partType: "career", lineId: "r3", rating: null, careerGradePoints: 2 }),
  ];
  const dto = project(rows);
  check("experience rating 7", dto.rows[0].rating, 7);
  check("experience rating 0 (null 로 바뀌지 않음)", dto.rows[1].rating, 0);
  check("information rating null", dto.rows[2].rating, null);
  check("competency rating null", dto.rows[3].rating, null);
  check("career rating = 등급 환산 점수(B=6)", dto.rows[4].rating, 6);
  check("career 미평가 → null", dto.rows[5].rating, null);
  check("career D 등급 = 2 (숫자 유지)", dto.rows[6].rating, 2);
  // 계약 보증 — undefined 는 JSON 에서 키가 사라지므로 절대 흘리면 안 된다.
  check(
    "rating 은 항상 number|null (undefined 금지)",
    dto.rows.every((r) => r.rating === null || typeof r.rating === "number"),
    true,
  );
  check("rating 키가 전 행에 존재", dto.rows.every((r) => "rating" in r), true);
}

// ⚠ 실데이터로는 검증 불가능한 경로 — 원장 duration 이 전 행 NULL, 라인 C 지급 설정 컬럼도 부재라
//   실 HTTP 검증은 항상 "-"/0 만 본다. 값이 생겼을 때 파이프라인이 실제로 흐르는지는 여기서만 잡힌다.
console.log("\n[케이스 5-b] 소요 시간·포인트 C — 값이 존재할 때 그대로 흐르는가(원장 미설정 사각지대)");
{
  const rows = [
    assigned({ partType: "information", lineId: "d30", estimatedDurationMinutes: 30 }),
    assigned({ partType: "experience", lineId: "d60", estimatedDurationMinutes: 60 }),
    assigned({ partType: "competency", lineId: "d90", estimatedDurationMinutes: 90 }),
    assigned({ partType: "experience", lineId: "d120", estimatedDurationMinutes: 120 }),
    assigned({ partType: "career", lineId: "dnull", estimatedDurationMinutes: null }),
  ];
  const dto = project(rows);
  check("duration 30 통과", dto.rows[0].estimatedDurationMinutes, 30);
  check("duration 60 통과", dto.rows[1].estimatedDurationMinutes, 60);
  check("duration 90 통과", dto.rows[2].estimatedDurationMinutes, 90);
  check("duration 120 통과", dto.rows[3].estimatedDurationMinutes, 120);
  check("duration null 통과(미설정)", dto.rows[4].estimatedDurationMinutes, null);
  check("duration 키가 전 행에 존재", dto.rows.every((r) => "estimatedDurationMinutes" in r), true);

  // 포인트 C — 지급 규칙이 생겨 값이 들어오면 행/요약 모두에 반영되어야 한다(현재는 전부 0).
  const cRows = [
    assigned({ partType: "information", lineId: "c1", earnedC: 2, possibleC: 3 }),
    assigned({ partType: "experience", lineId: "c2", earnedC: 1, possibleC: 4 }),
    unassigned({ partType: "information", lineId: "c3", earnedC: 0, possibleC: 5 }), // 비대상 → 0 / N
  ];
  const cDto = project(cRows);
  check("행 pointC 통과(2/3)", cDto.rows[0].pointC, { earned: 2, available: 3 });
  check("비대상 행 pointC (0 / N)", cDto.rows[2].pointC, { earned: 0, available: 5 });
  check("summary.pointC = Σ rows", cDto.summary.pointC, { earned: 3, available: 12 });
  assertInvariants(cDto, "케이스5-b");
}

console.log("\n[케이스 6] 주차 성장 조건 — 실무 경험만 필수");
{
  const rows = [
    assigned({ partType: "experience", lineId: "e" }),
    assigned({ partType: "information", lineId: "i" }),
    assigned({ partType: "competency", lineId: "c" }),
    assigned({ partType: "career", lineId: "r" }),
  ];
  const dto = project(rows);
  check("experience", dto.rows[0].growthRequirement, "required");
  check("information", dto.rows[1].growthRequirement, "optional");
  check("competency", dto.rows[2].growthRequirement, "optional");
  check("career", dto.rows[3].growthRequirement, "optional");
  check("hub 매핑(experience)", dto.rows[0].hub, "practical_experience");
  check("hub 매핑(information)", dto.rows[1].hub, "practical_info");
  check("hub 매핑(competency)", dto.rows[2].hub, "practical_competency");
  check("hub 매핑(career)", dto.rows[3].hub, "practical_career");
}

console.log("\n[케이스 7] 중복 방지 — 같은 master 의 서로 다른 실제 오픈 라인은 각각 1행 유지");
{
  const rows = [
    assigned({ partType: "experience", lineId: "line-A", type: "도출", lineName: "도출 1/4" }),
    assigned({ partType: "experience", lineId: "line-B", type: "도출", lineName: "도출 2/4" }),
  ];
  const dto = project(rows);
  check("rows.length (병합 금지)", dto.rows.length, 2);
  ok("stableKey 고유", dto.rows[0].stableKey !== dto.rows[1].stableKey);
  check("라인명 보존", [dto.rows[0].lineName, dto.rows[1].lineName], ["도출 1/4", "도출 2/4"]);
}

console.log("\n[추가] 관리자 전용 필드 비노출 + 결과 라벨/톤");
{
  const rows = [
    assigned({ partType: "information", lineId: "a", enhancementStatus: "success" }),
    assigned({ partType: "information", lineId: "b", enhancementStatus: "fail" }),
    unassigned({ partType: "experience", lineId: "c", enhancementStatus: "fail" }),
    assigned({ partType: "information", lineId: "d", enhancementStatus: "pending" }),
  ];
  const dto = project(rows);
  const ADMIN_ONLY = [
    "overrideAllowed",
    "eligible",
    "effectiveCanEdit",
    "submission",
    "submissionOpensAt",
    "submissionClosesAt",
    "lineId",
    "lineTargetId",
    "enhancementReason",
    "submissionStatus",
    "isCompetencyPlaceholder",
    "isExperiencePlaceholder",
    "displayLineCode",
  ];
  const leaked = ADMIN_ONLY.filter((k) => dto.rows.some((r) => k in (r as Record<string, unknown>)));
  check("관리자 전용 필드 누출 없음", leaked, []);
  ok("DTO 최상위에 canManageSecondEntry 없음", !("canManageSecondEntry" in (dto as Record<string, unknown>)));

  check("success → 라벨/톤", [dto.rows[0].result, dto.rows[0].resultLabel, dto.rows[0].resultTone], ["success", "강화 성공", "success"]);
  check("fail → 라벨/톤", [dto.rows[1].result, dto.rows[1].resultLabel, dto.rows[1].resultTone], ["failure", "강화 실패", "danger"]);
  check("비배정 → 해당 없음", [dto.rows[2].result, dto.rows[2].resultLabel, dto.rows[2].resultTone], ["not_applicable", "해당 없음", "neutral"]);
  check("pending → 집계 전", [dto.rows[3].result, dto.rows[3].resultLabel, dto.rows[3].resultTone], ["pending", "집계 전", "neutral"]);
  // pending 이 섞여도 불변식 유지(미확정 주차).
  assertInvariants(dto, "pending 혼합");
}

console.log(`\n${failures === 0 ? "✅ PASS" : "❌ FAIL"} — ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);

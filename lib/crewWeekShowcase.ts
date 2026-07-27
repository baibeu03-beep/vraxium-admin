// 주차 결과(크루) — 크루 표 14컬럼 base row + 결과 overlay. **서버 전용**.
//
// 구조(중요):
//   base row  = 주차 크루 전원의 "기본 정보". 예비 검수 **전에도** 즉시 보인다.
//               크루명 · 학적 · 클래스 · 소속 팀 · 소속 파트 · 품계
//   overlay   = 예비(live) 또는 공표(snapshot) 결과. base row 에 **결합만** 한다(행 재생성 금지).
//               등수 · 성장 결과 · 액트 체크율 · 주차 성장률 · 포인트 A/B/C · 성장성공(주차)
//
// SoT:
//   클래스/팀/파트 = lib/positionResolver (week-effective). **셋을 같은 resolver 결과에서** 가져와
//                    시점이 섞이지 않게 한다(팀만 과거·파트만 현재 금지).
//   학적          = user_educations(대표) → user_profiles 폴백 (front leaderById 규칙과 동일)
//   품계          = getClubRankGradeBatch(live) — 고객 /api/cluster3/club-rank(getClubRank)과 동일
//                   산식·동일 배치 resolver. user_grade_stats 캐시는 참조하지 않는다(원천 혼입 금지).
//   액트 체크율    = shared/crewActSummary.buildCrewActSummary — **admin·front 공유 단일 SoT**
//                   (크루 앱 /cluster-4-card Detail Log "활동 완료율"과 같은 함수)
//   포인트 A/B/C   = user_weekly_points.points / advantages / penalty
//   등수          = 포인트 A desc · 동점 공동 · 다음 순위 건너뜀(고객 앱 CrewRankShowcase 규칙)
//
// null/0 계약: null = 아직 계산되지 않음("-") · 0 = 실제 0. `?? 0` 폴백 금지.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveRepresentativeEducations } from "@/lib/educationResolver";
import { resolveWeeklyPointsBatch } from "@/lib/pointResolver";
import type { OrganizationSlug } from "@/lib/organizations";
import {
  buildCrewActSummary,
  type CrewActSummaryRow,
} from "@/shared/crewActSummary";
import { isActPerformanceSource } from "@/lib/pointAwardSourcePolicy";
import { readWeeklyCardsSnapshotBatch } from "@/lib/cluster4WeeklyCardsSnapshot";
import { getClubRankGradeBatch } from "@/lib/cluster3ClubRankData";

// 품계 계산 결과의 **상태**. grade:null 하나로는 "정책상 대상 아님"과 "계산이 실패해서 못 구함"이
//   구분되지 않고, 후자가 공표되면 snapshot 에 null 품계가 그대로 굳는다. 셋을 명시적으로 가른다.
//   · resolved      : 계산 성공. 세 값 전부 채워짐.
//   · not-eligible  : 정책상 품계 없음(현재 시즌 rest 로 모집단 제외 · 산정 가능한 주차 없음).
//                     **정상 상태다 — 공표를 막지 않는다.**
//   · failed        : 계산 자체가 실패했거나(DB/타임아웃/예외) 대상자 결과가 누락·불완전.
//                     **공표를 차단한다.**
export type CrewShowcaseGradeResolution =
  | { status: "resolved"; avgPercentile: number; grade: number; gradeLabel: string }
  | { status: "not-eligible"; avgPercentile: null; grade: null; gradeLabel: null; reason: string }
  | { status: "failed"; avgPercentile: null; grade: null; gradeLabel: null; reason: string };

export type CrewShowcaseBaseRow = {
  userId: string;
  crewDisplayName: string | null;
  crewCode: string | null;
  schoolName: string | null;
  majorName: string | null;
  classLabel: string | null;
  teamName: string | null;
  partName: string | null;
  grade: number | null;
  gradeLabel: string | null;
  /** grade/gradeLabel 이 왜 그 값인지 — 공표 게이트의 판단 근거. */
  gradeResolution: CrewShowcaseGradeResolution;
};

export type CrewShowcaseOverlay = {
  userId: string;
  rank: number | null;
  /** 성장 결과 — 크루 결과 DTO의 result 를 그대로 쓴다(별도 판정 금지). */
  actCompletionRatePercent: number | null;
  actTotalCount: number | null;
  actSuccessCount: number | null;
  weeklyGrowthRatePercent: number | null;
  pointA: number | null;
  pointB: number | null;
  pointC: number | null;
  cumulativeSuccessWeeks: number | null;
};

// ── 학적 ────────────────────────────────────────────────────────────────────
async function loadEducation(
  userIds: string[],
): Promise<Map<string, { school: string | null; major: string | null }>> {
  const out = new Map<string, { school: string | null; major: string | null }>();
  if (userIds.length === 0) return out;
  const resolved = await resolveRepresentativeEducations(userIds);
  for (const [userId, education] of resolved) {
    out.set(userId, {
      school: education.schoolName,
      major: education.majorName,
    });
  }
  return out;
}

// ── 품계 ────────────────────────────────────────────────────────────────────
// 원천 = getClubRankGradeBatch(live) 단 하나. 고객 화면(/api/cluster3/club-rank → getClubRank)과
//   같은 산식·같은 모집단이므로 크루 표와 고객 앱의 품계가 갈리지 않는다.
//   ⚠ user_grade_stats 캐시를 폴백으로도 쓰지 않는다 — 계산 실패 시 세 값을 모두 null("-")로 둔다.
//     캐시로 절반만 메우면 백분위(live)와 품계(캐시)가 섞인 행이 만들어진다.
//   배치 1회(전체 포인트 1회 읽기) — 사용자 수와 무관하게 스캔 횟수 고정(N+1 아님).
const NOT_ELIGIBLE_REASON =
  "품계 산정 대상이 아닙니다(현재 시즌 휴식으로 모집단 제외 또는 산정 가능한 주차 없음).";

async function loadGrades(
  userIds: string[],
  options?: { forceRefresh?: boolean },
): Promise<Map<string, CrewShowcaseGradeResolution>> {
  const out = new Map<string, CrewShowcaseGradeResolution>();
  if (userIds.length === 0) return out;

  const allFailed = (reason: string) => {
    for (const uid of userIds) {
      out.set(uid, { status: "failed", avgPercentile: null, grade: null, gradeLabel: null, reason });
    }
    return out;
  };

  let batch: Map<string, { grade: number; label: string; avgPercentile: number | null } | null>;
  try {
    batch = await getClubRankGradeBatch(userIds, { forceRefresh: options?.forceRefresh });
  } catch (error) {
    // 계산 자체가 죽은 경우 — 전원 failed. 화면은 종전처럼 "-"로 뜨지만(fail-soft 유지),
    //   공표 게이트가 이 상태를 보고 snapshot 확정을 막는다.
    const reason = `품계 계산 실패: ${error instanceof Error ? error.message : String(error)}`;
    console.warn("[crew-week-showcase] 품계(live) 계산 실패", reason);
    return allFailed(reason);
  }

  for (const uid of userIds) {
    // 배치는 요청한 모든 userId 에 대해 entry 를 만든다(값이 null 이어도 key 는 존재).
    //   key 자체가 없다 = 계산기가 대상자를 빠뜨렸다는 뜻 → 정상 null 이 아니라 결함이다.
    if (!batch.has(uid)) {
      out.set(uid, {
        status: "failed",
        avgPercentile: null,
        grade: null,
        gradeLabel: null,
        reason: "품계 계산 결과에 해당 크루가 누락되었습니다.",
      });
      continue;
    }
    const g = batch.get(uid) ?? null;
    if (g === null) {
      // 정책상 정상 null — rest 모집단 제외 / 산정 주차 없음.
      out.set(uid, {
        status: "not-eligible",
        avgPercentile: null,
        grade: null,
        gradeLabel: null,
        reason: NOT_ELIGIBLE_REASON,
      });
      continue;
    }
    // 세 값은 전부 채워지거나 전부 null이어야 한다. 하나만 빈 행은 원천 혼입/부분 실패다.
    const missing: string[] = [];
    if (g.avgPercentile == null) missing.push("avgPercentile");
    if (g.grade == null) missing.push("grade");
    if (!g.label) missing.push("gradeLabel");
    if (missing.length > 0) {
      out.set(uid, {
        status: "failed",
        avgPercentile: null,
        grade: null,
        gradeLabel: null,
        reason: `품계 값이 불완전합니다(누락: ${missing.join(", ")}).`,
      });
      continue;
    }
    out.set(uid, {
      status: "resolved",
      avgPercentile: g.avgPercentile as number,
      grade: g.grade,
      gradeLabel: g.label,
    });
  }
  return out;
}

/** 공표 차단 대상(계산 실패) 행만 추린다. not-eligible 은 정상이므로 포함하지 않는다. */
export function collectGradeResolutionFailures(
  base: Map<string, CrewShowcaseBaseRow>,
): Array<{ userId: string; displayName: string | null; reason: string }> {
  const out: Array<{ userId: string; displayName: string | null; reason: string }> = [];
  for (const row of base.values()) {
    if (row.gradeResolution.status !== "failed") continue;
    out.push({
      userId: row.userId,
      displayName: row.crewDisplayName,
      reason: row.gradeResolution.reason,
    });
  }
  return out;
}

// ── 액트 체크율(활동 완료율) ────────────────────────────────────────────────
// 원천 = process_point_awards 원장(Detail Log 와 동일). 취소된 행은 제외한다.
//   집계는 **shared/crewActSummary.buildCrewActSummary** 를 그대로 쓴다(새 산식 금지).
export type ActRateResult = {
  ratePercent: number | null; // total=0 → null("-"), total>0 → 0~100
  total: number;
  success: number;
};

async function loadActRates(
  userIds: string[],
  isoYear: number,
  isoWeek: number,
): Promise<Map<string, ActRateResult>> {
  const out = new Map<string, ActRateResult>();
  if (userIds.length === 0) return out;

  const rowsByUser = new Map<string, CrewActSummaryRow[]>();
  for (const uid of userIds) rowsByUser.set(uid, []);

  // cancelled_at 컬럼 유무는 환경마다 다르므로 있으면 제외, 없으면 전체(기존 폴백 패턴).
  for (let i = 0; i < userIds.length; i += 300) {
    const slice = userIds.slice(i, i + 300);
    let data: Array<Record<string, unknown>> | null = null;
    const withCancel = await supabaseAdmin
      .from("process_point_awards")
      .select("user_id,source,point_check,point_advantage,point_penalty,cancelled_at")
      .in("user_id", slice)
      .eq("year", isoYear)
      .eq("week_number", isoWeek);
    if (withCancel.error) {
      const plain = await supabaseAdmin
        .from("process_point_awards")
        .select("user_id,source,point_check,point_advantage,point_penalty")
        .in("user_id", slice)
        .eq("year", isoYear)
        .eq("week_number", isoWeek);
      if (plain.error) {
        console.warn("[crew-week-showcase] process_point_awards 조회 실패", plain.error.message);
        return out;
      }
      data = plain.data as Array<Record<string, unknown>>;
    } else {
      data = (withCancel.data as Array<Record<string, unknown>>).filter(
        (r) => r.cancelled_at == null,
      );
    }

    for (const r of data ?? []) {
      const uid = r.user_id as string;
      const list = rowsByUser.get(uid);
      if (!list) continue;
      // ⚠ 액트 수행 집계 allowlist(strict) — lib/pointAwardSourcePolicy.ACT_PERFORMANCE_SOURCES.
      //   라인 지급('line' 강화 시 포인트 · 'line_rating' 평점 Point A)은 **액트 수행이 아니다** →
      //   체크 수·체크율에서 제외한다. 두 원장은 주차 총 Point A(user_weekly_points.points)에는
      //   그대로 합산되며(주차 성공 판정 입력), 상세 표시는 "라인 강화 내역" 탭이 담당한다.
      //   [2026-07-27 정정] 종전에는 source 필터가 없어 'line' 까지 액트로 셌다(2026-07-13 도입 이래).
      //     그 결과 액트 체크 건수·체크율이 부풀어 있었다 — 이번 정책으로 걷어낸다.
      //     실측 영향: 2026-summer W1 41/67명 · W2 31/61명 · W3 21/67명의 체크율/건수 변동
      //     (예: 건수 9→3 · 체크율 89%→67%). 값이 내려가는 것이 정정된 값이다.
      //   (Detail Log 액트 목록 cluster4ActLogsData 는 이미 같은 allowlist 를 쓰고 있었다.)
      if (!isActPerformanceSource(r.source as string)) continue;
      list.push({
        result: "checked",
        source: (r.source as string) === "irregular" ? "irregular" : "regular",
        kindKey: "unknown",
        pointA: Number(r.point_check ?? 0),
        pointB: Number(r.point_advantage ?? 0),
        pointC: Math.abs(Number(r.point_penalty ?? 0)),
      } as CrewActSummaryRow);
    }
  }

  for (const [uid, rows] of rowsByUser) {
    const s = buildCrewActSummary(rows);
    // ⚠ 빌더는 total=0 일 때 rate=0 을 돌려준다 → "액트 없음"과 "실제 0%"가 같아진다.
    //   저장/표시 계층에서만 구분한다(빌더 무수정): total=0 → null("-").
    out.set(uid, {
      ratePercent: s.total > 0 ? s.rate : null,
      total: s.total,
      success: s.success,
    });
  }
  return out;
}

// ── 포인트 A/B/C ────────────────────────────────────────────────────────────
// 공통 Resolver 단일 경로. 종전의 자체 합산(loadPoints — week_start_date 로 uwp 를
// 직접 읽고 b 에 raw advantages 를 그대로 넣던 경로)은 2026-07-26 제거했다:
// B 가 net(= raw − C) 이 아니라 화면 간 값이 갈리는 원인이었다.
async function loadResolvedPoints(
  userIds: string[],
  isoYear: number,
  isoWeek: number,
): Promise<Map<string, { a: number | null; b: number | null; c: number | null }>> {
  const out = new Map<string, { a: number | null; b: number | null; c: number | null }>();
  const points = await resolveWeeklyPointsBatch({
    userIds,
    year: isoYear,
    weekNumber: isoWeek,
  });
  for (const [userId, value] of points) {
    out.set(userId, { a: value.pointA, b: value.pointB, c: value.pointC });
  }
  return out;
}

// ── 등수 — 고객 앱 CrewRankShowcase 규칙 ────────────────────────────────────
// 포인트 A desc · 동점 공동 등수 · 다음 순위는 앞선 인원수만큼 건너뜀(표준 경쟁 순위).
//   front lib/weekly-league.ts:1443~1454 와 동일. 순수 함수.
export function computeRanks(
  entries: Array<{ userId: string; pointA: number | null }>,
): Map<string, number> {
  const out = new Map<string, number>();
  const sorted = [...entries].sort((a, b) => (b.pointA ?? 0) - (a.pointA ?? 0));
  sorted.forEach((x, i) => {
    const prev = i > 0 ? sorted[i - 1] : null;
    out.set(
      x.userId,
      prev && (prev.pointA ?? 0) === (x.pointA ?? 0) ? out.get(prev.userId)! : i + 1,
    );
  });
  return out;
}

/** 표시 정렬 — 등수 → 품계 레벨 asc → 주차 성장률 desc → 이름 ko-KR → userId. */
export function sortShowcaseRows<
  T extends {
    userId: string;
    crewDisplayName: string | null;
    rank: number | null;
    grade: number | null;
    weeklyGrowthRatePercent: number | null;
  },
>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) ||
      (a.grade ?? 10) - (b.grade ?? 10) ||
      (b.weeklyGrowthRatePercent ?? 0) - (a.weeklyGrowthRatePercent ?? 0) ||
      (a.crewDisplayName ?? "").localeCompare(b.crewDisplayName ?? "", "ko-KR") ||
      a.userId.localeCompare(b.userId),
  );
}

// ── 주차 성장률 · 성장성공(주차) ────────────────────────────────────────────
// 원천 = weekly-cards snapshot(고객 앱 CrewRankShowcase 의 GrowthMetricSnapshot 과 동일 SoT).
//   **읽기 전용** — snapshot 생성/재계산/무효화 로직은 건드리지 않는다(readWeeklyCardsSnapshotBatch).
//   stale/version_mismatch 여도 cards 배열이 있으면 그대로 쓴다(공용 조회 정책과 동일).
//   카드가 없으면(MISS·error) **null 유지** — 0 폴백 금지.
//
// ⚠ 필드명 함정(2026-07-23 실측): 카드 DTO 에는 `cumulativeSuccessWeeks` 가 **없다**.
//   고객 앱 /weekly-ranking 의 "N주"(CrewRankShowcase.cumulativeSuccessWeeks)는 front metricFromCard 가
//   `card.accumulatedApprovedWeeks` 를 그대로 옮겨 담은 값이다(front lib/weekly-league.ts).
//   여기서도 **같은 필드를 그대로 읽는다** — 누적 성공 주차를 새로 세지 않는다
//   (user_week_statuses 카운트 금지 · 현재 주차 성공 여부 가산 금지).
export type GrowthFromSnapshot = {
  weeklyGrowthRatePercent: number | null;
  cumulativeSuccessWeeks: number | null;
};

// front `rateValue()` 미러 — Cluster4RateDto → 0~100 정수. 값이 없으면 null(0 환원 금지).
//   front 는 rateValue(undefined)=0 으로 환원하지만, 어드민 표는 "미집계('-')"와 "실제 0"을 구분해야
//   하므로 여기서는 null 을 유지하고 상위 폴백(weeklyGrowthRate)에 판단을 넘긴다.
function rateValueOrNull(rate: unknown): number | null {
  if (rate == null || typeof rate !== "object") return null;
  const r = rate as { rate?: unknown; total?: unknown; count?: unknown };
  if (typeof r.rate === "number" && Number.isFinite(r.rate)) return Math.round(r.rate);
  const total = Number(r.total);
  const count = Number(r.count);
  if (!Number.isFinite(total) || !Number.isFinite(count)) return null;
  return total > 0 ? Math.round((count / total) * 100) : 0;
}

async function loadGrowthFromSnapshot(
  userIds: string[],
  weekId: string,
): Promise<Map<string, GrowthFromSnapshot>> {
  const out = new Map<string, GrowthFromSnapshot>();
  if (userIds.length === 0) return out;
  let batch: Awaited<ReturnType<typeof readWeeklyCardsSnapshotBatch>>;
  try {
    batch = await readWeeklyCardsSnapshotBatch(userIds);
  } catch (e) {
    console.warn(
      "[crew-week-showcase] weekly-cards snapshot 조회 실패 — 성장률/누적 null 유지",
      e instanceof Error ? e.message : String(e),
    );
    return out;
  }
  for (const [uid, outcome] of batch) {
    const cards = (outcome as { cards?: unknown }).cards;
    if (!Array.isArray(cards)) continue;
    const card = (cards as Array<Record<string, unknown>>).find((c) => c.weekId === weekId);
    if (!card) continue;
    // 주차 성장률 — front metricFromCard 순서 그대로: growthRate(있으면) → weeklyGrowthRate.
    const fromRateDto = rateValueOrNull(card.growthRate);
    const flat = card.weeklyGrowthRate;
    // 성장성공(주차) — 카드의 accumulatedApprovedWeeks 를 **그대로**. 0 은 실제 0("0주"),
    //   필드 자체가 없을 때만 null("-").
    const cum = card.accumulatedApprovedWeeks;
    out.set(uid, {
      weeklyGrowthRatePercent:
        fromRateDto ?? (typeof flat === "number" && Number.isFinite(flat) ? Math.round(flat) : null),
      cumulativeSuccessWeeks:
        typeof cum === "number" && Number.isFinite(cum) ? Math.max(0, cum) : null,
    });
  }
  return out;
}

export type CrewShowcaseInputs = {
  base: Map<string, CrewShowcaseBaseRow>;
  actRates: Map<string, ActRateResult>;
  points: Map<string, { a: number | null; b: number | null; c: number | null }>;
  growth: Map<string, GrowthFromSnapshot>;
};

/**
 * base row + 지표 원천을 한 번에 로드한다.
 *   classLabel/teamName/partName 은 호출자가 이미 week-effective resolver 로 구한 값을 넘긴다
 *   (여기서 다시 조회하면 시점이 갈릴 수 있다).
 */
export async function loadCrewShowcaseInputs(opts: {
  organization: OrganizationSlug;
  userIds: string[];
  weekStartDate: string;
  /** weekly-cards snapshot 카드 매칭 키. */
  weekId: string;
  isoYear: number | null;
  isoWeek: number | null;
  /** userId → week-effective 위치(같은 resolver 산출값). */
  positionByUser: Map<
    string,
    { classLabel: string | null; teamName: string | null; partName: string | null }
  >;
  /** userId → 표시명/크루코드(공표 snapshot 과 동일 원천). */
  displayByUser: Map<string, { displayName: string | null; crewCode: string | null }>;
  /**
   * 품계를 TTL 캐시 없이 지금 시점으로 재계산한다. 공표(snapshot 확정) 경로 전용 —
   * 30초 전 계산값이 그대로 굳는 것을 막는다. 계산식·DTO 는 동일하다(캐시 사용 여부만 다름).
   */
  forceRefreshGrades?: boolean;
}): Promise<CrewShowcaseInputs> {
  const { userIds } = opts;
  const [edu, grades, actRates, points, growth] = await Promise.all([
    loadEducation(userIds),
    loadGrades(userIds, { forceRefresh: opts.forceRefreshGrades === true }),
    opts.isoYear != null && opts.isoWeek != null
      ? loadActRates(userIds, opts.isoYear, opts.isoWeek)
      : Promise.resolve(new Map<string, ActRateResult>()),
    opts.isoYear != null && opts.isoWeek != null
      ? loadResolvedPoints(userIds, opts.isoYear, opts.isoWeek)
      : Promise.resolve(new Map()),
    opts.weekId ? loadGrowthFromSnapshot(userIds, opts.weekId) : Promise.resolve(new Map()),
  ]);

  const base = new Map<string, CrewShowcaseBaseRow>();
  for (const uid of userIds) {
    const pos = opts.positionByUser.get(uid);
    const disp = opts.displayByUser.get(uid);
    const e = edu.get(uid);
    // loadGrades 는 요청한 모든 uid 에 대해 상태를 채운다. 방어적으로 누락은 failed 로 본다
    //   (조용히 null 로 흘려보내면 공표 게이트가 이 행을 정상으로 오인한다).
    const g: CrewShowcaseGradeResolution = grades.get(uid) ?? {
      status: "failed",
      avgPercentile: null,
      grade: null,
      gradeLabel: null,
      reason: "품계 계산 결과가 조립 단계에서 누락되었습니다.",
    };
    base.set(uid, {
      userId: uid,
      crewDisplayName: disp?.displayName ?? null,
      crewCode: disp?.crewCode ?? null,
      schoolName: e?.school ?? null,
      majorName: e?.major ?? null,
      classLabel: pos?.classLabel ?? null,
      teamName: pos?.teamName ?? null,
      partName: pos?.partName ?? null,
      // 표시값은 상태에서 파생한다 — 두 값이 갈릴 여지를 없앤다.
      grade: g.grade,
      gradeLabel: g.gradeLabel,
      gradeResolution: g,
    });
  }
  return { base, actRates, points, growth };
}

/** 공표 직전 서버 검증 — 완료율 ↔ count 관계(DB CHECK 로 표현 불가). 위반 시 공표 전체 차단. */
export function assertActRateInvariants(
  rows: Array<{
    userId: string;
    actTotalCount: number | null;
    actSuccessCount: number | null;
    actCompletionRatePercent: number | null;
  }>,
): string | null {
  for (const r of rows) {
    const total = r.actTotalCount;
    const success = r.actSuccessCount;
    const rate = r.actCompletionRatePercent;
    if (total == null || success == null) {
      if (rate != null) return `[${r.userId}] count 없이 rate 만 존재`;
      continue;
    }
    if (success > total) return `[${r.userId}] success(${success}) > total(${total})`;
    if (total === 0) {
      if (rate !== null) return `[${r.userId}] total=0 인데 rate=${rate} (null 이어야 함)`;
      continue;
    }
    const expected = Math.round((success / total) * 100);
    if (rate !== expected) {
      return `[${r.userId}] rate(${rate}) != round(${success}/${total}*100)=${expected}`;
    }
  }
  return null;
}

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
//   품계          = user_grade_stats.grade(정수 레벨) + grade_label(품계명)
//   액트 체크율    = shared/crewActSummary.buildCrewActSummary — **admin·front 공유 단일 SoT**
//                   (크루 앱 /cluster-4-card Detail Log "활동 완료율"과 같은 함수)
//   포인트 A/B/C   = user_weekly_points.points / advantages / penalty
//   등수          = 포인트 A desc · 동점 공동 · 다음 순위 건너뜀(고객 앱 CrewRankShowcase 규칙)
//
// null/0 계약: null = 아직 계산되지 않음("-") · 0 = 실제 0. `?? 0` 폴백 금지.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { OrganizationSlug } from "@/lib/organizations";
import {
  buildCrewActSummary,
  type CrewActSummaryRow,
} from "@/shared/crewActSummary";
import { readWeeklyCardsSnapshotBatch } from "@/lib/cluster4WeeklyCardsSnapshot";

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
  for (let i = 0; i < userIds.length; i += 300) {
    const slice = userIds.slice(i, i + 300);
    const [{ data: profs }, { data: edus }] = await Promise.all([
      supabaseAdmin
        .from("user_profiles")
        .select("user_id,school_name,department_name")
        .in("user_id", slice),
      supabaseAdmin
        .from("user_educations")
        .select("user_id,school_name,major_name_1,sort_order")
        .in("user_id", slice)
        .order("sort_order", { ascending: true }),
    ]);
    const eduBy = new Map<string, { school_name: string | null; major_name_1: string | null }>();
    for (const e of (edus ?? []) as Array<{
      user_id: string;
      school_name: string | null;
      major_name_1: string | null;
    }>) {
      if (!eduBy.has(e.user_id)) eduBy.set(e.user_id, e);
    }
    for (const p of (profs ?? []) as Array<{
      user_id: string;
      school_name: string | null;
      department_name: string | null;
    }>) {
      const e = eduBy.get(p.user_id);
      out.set(p.user_id, {
        school: e?.school_name ?? p.school_name ?? null,
        major: e?.major_name_1 ?? p.department_name ?? null,
      });
    }
  }
  return out;
}

// ── 품계 ────────────────────────────────────────────────────────────────────
async function loadGrades(
  userIds: string[],
): Promise<Map<string, { grade: number | null; label: string | null }>> {
  const out = new Map<string, { grade: number | null; label: string | null }>();
  if (userIds.length === 0) return out;
  for (let i = 0; i < userIds.length; i += 300) {
    const { data, error } = await supabaseAdmin
      .from("user_grade_stats")
      .select("user_id,grade,grade_label")
      .in("user_id", userIds.slice(i, i + 300));
    if (error) {
      console.warn("[crew-week-showcase] user_grade_stats 조회 실패", error.message);
      return out;
    }
    for (const r of (data ?? []) as Array<{
      user_id: string;
      grade: number | null;
      grade_label: string | null;
    }>) {
      out.set(r.user_id, { grade: r.grade ?? null, label: r.grade_label ?? null });
    }
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
async function loadPoints(
  userIds: string[],
  weekStartDate: string,
): Promise<Map<string, { a: number | null; b: number | null; c: number | null }>> {
  const out = new Map<string, { a: number | null; b: number | null; c: number | null }>();
  if (userIds.length === 0) return out;
  for (let i = 0; i < userIds.length; i += 300) {
    const { data, error } = await supabaseAdmin
      .from("user_weekly_points")
      .select("user_id,points,advantages,penalty")
      .eq("week_start_date", weekStartDate)
      .in("user_id", userIds.slice(i, i + 300));
    if (error) {
      console.warn("[crew-week-showcase] user_weekly_points 조회 실패", error.message);
      return out;
    }
    for (const r of (data ?? []) as Array<{
      user_id: string;
      points: number | null;
      advantages: number | null;
      penalty: number | null;
    }>) {
      out.set(r.user_id, {
        a: r.points ?? null,
        b: r.advantages ?? null,
        c: r.penalty ?? null,
      });
    }
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
}): Promise<CrewShowcaseInputs> {
  const { userIds } = opts;
  const [edu, grades, actRates, points, growth] = await Promise.all([
    loadEducation(userIds),
    loadGrades(userIds),
    opts.isoYear != null && opts.isoWeek != null
      ? loadActRates(userIds, opts.isoYear, opts.isoWeek)
      : Promise.resolve(new Map<string, ActRateResult>()),
    loadPoints(userIds, opts.weekStartDate),
    opts.weekId ? loadGrowthFromSnapshot(userIds, opts.weekId) : Promise.resolve(new Map()),
  ]);

  const base = new Map<string, CrewShowcaseBaseRow>();
  for (const uid of userIds) {
    const pos = opts.positionByUser.get(uid);
    const disp = opts.displayByUser.get(uid);
    const e = edu.get(uid);
    const g = grades.get(uid);
    base.set(uid, {
      userId: uid,
      crewDisplayName: disp?.displayName ?? null,
      crewCode: disp?.crewCode ?? null,
      schoolName: e?.school ?? null,
      majorName: e?.major ?? null,
      classLabel: pos?.classLabel ?? null,
      teamName: pos?.teamName ?? null,
      partName: pos?.partName ?? null,
      grade: g?.grade ?? null,
      gradeLabel: g?.label ?? null,
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

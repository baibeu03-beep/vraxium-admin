// ─────────────────────────────────────────────────────────────────────
// Growth Core — Layer 0 입력 로더 (server-only).
//
// 목적: cluster1 / cluster3 / cluster4 가 동일한 "원본 입력 번들(GrowthInput)"
//       을 공유하도록 DB 조회를 한 곳에 모은다. 순수 계산은 growthCore.ts 가,
//       조회는 이 모듈이 담당한다.
//
// Step 4 범위: GrowthInput 타입 설계 + loader 구현.
//   - 항상 로딩: profile / weekStatuses / seasonStatuses (세 클러스터 공통)
//   - 옵션 로딩: officialRestPeriods / weeks (기본 false — 호출부가 필요할 때만)
//   - experience verdict 는 weekId 기반 계산 맵이라 raw 번들 대상이 아니다
//     (cluster4 카드 경로에서 별도 계산 — 후속 단계에서 재배선 검토).
//
// ⚠ 이번 단계에서 실제로 배선되는 소비자는 cluster4 computeGrowthSummary 뿐이며,
//   기본 옵션(트리오만 로딩)으로 기존 쿼리와 동일 결과를 보장한다.
// ─────────────────────────────────────────────────────────────────────

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchActiveRestPeriods } from "@/lib/officialRestPeriodsData";
import type { OfficialRestPeriodDto } from "@/lib/officialRestPeriodsTypes";
import {
  resolveStateScopeForUser,
  applyQaWeekPublishOverlay,
} from "@/lib/operationalState";

export class GrowthLoaderError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GrowthLoaderError";
    this.status = status;
  }
}

export type GrowthProfileRow = {
  growth_status: string | null;
  status: string | null;
  activity_started_at: string | null;
  activity_ended_at: string | null;
  organization_slug: string | null;
};

export type GrowthWeekStatusRow = {
  year: number;
  week_number: number;
  status: string;
  season_key: string | null;
  week_start_date: string | null;
  is_official_rest_override: boolean;
};

export type GrowthSeasonStatusRow = {
  status: string;
  season_key: string | null;
  requested_at: string | null;
};

export type GrowthWeekRow = {
  id: string;
  week_number: number | null;
  start_date: string;
  end_date: string | null;
  season_key: string | null;
  iso_year: number | null;
  iso_week: number | null;
  result_published_at: string | null;
};

export type GrowthInput = {
  userId: string;
  profile: GrowthProfileRow | null;
  // year asc, week_number asc 정렬(시작/종료 주차 표시 안정성).
  weekStatuses: GrowthWeekStatusRow[];
  seasonStatuses: GrowthSeasonStatusRow[];
  // 옵션 미요청 시 null (로딩하지 않음 — 호출부가 사용하지 않음을 명시).
  officialRestPeriods: OfficialRestPeriodDto[] | null;
  weeks: GrowthWeekRow[] | null;
};

export type LoadGrowthInputOptions = {
  // 공식 휴식 판정용 활성 기간 (전역, user-scope 아님). 기본 false.
  includeOfficialRestPeriods?: boolean;
  // weeks 정의 테이블 (전역). 기본 false. cluster4 카드 조립 set 과는 별개의 raw 행.
  includeWeeks?: boolean;
};

// 원본 입력 번들 로딩.
//   hard error(주차/프로필 조회 실패)는 throw → 호출부가 fallback 결정.
//   season 조회 실패는 graceful([]) — 기존 computeGrowthSummary 의 관용과 동일.
export async function loadGrowthInput(
  userId: string,
  opts: LoadGrowthInputOptions = {},
): Promise<GrowthInput> {
  const [weekRes, profileRes, seasonRes] = await Promise.all([
    supabaseAdmin
      .from("user_week_statuses")
      .select(
        "year,week_number,status,season_key,week_start_date,is_official_rest_override",
      )
      .eq("user_id", userId)
      .order("year", { ascending: true })
      .order("week_number", { ascending: true }),
    supabaseAdmin
      .from("user_profiles")
      .select(
        "growth_status,status,activity_started_at,activity_ended_at,organization_slug",
      )
      .eq("user_id", userId)
      .maybeSingle(),
    supabaseAdmin
      .from("user_season_statuses")
      .select("status,season_key,requested_at")
      .eq("user_id", userId),
  ]);

  if (weekRes.error) throw new GrowthLoaderError(500, weekRes.error.message);
  if (profileRes.error)
    throw new GrowthLoaderError(500, profileRes.error.message);

  const weekStatuses = (weekRes.data ?? []) as GrowthWeekStatusRow[];
  const profile = (profileRes.data ?? null) as GrowthProfileRow | null;
  const seasonStatuses =
    !seasonRes.error && seasonRes.data
      ? (seasonRes.data as GrowthSeasonStatusRow[])
      : [];

  let officialRestPeriods: OfficialRestPeriodDto[] | null = null;
  if (opts.includeOfficialRestPeriods) {
    officialRestPeriods = await fetchActiveRestPeriods();
  }

  let weeks: GrowthWeekRow[] | null = null;
  if (opts.includeWeeks) {
    const weeksRes = await supabaseAdmin
      .from("weeks")
      .select(
        "id,week_number,start_date,end_date,season_key,iso_year,iso_week,result_published_at",
      )
      .order("start_date", { ascending: true });
    if (weeksRes.error) throw new GrowthLoaderError(500, weeksRes.error.message);
    weeks = (weeksRes.data ?? []) as GrowthWeekRow[];
    // QA 오버레이: 테스트 유저면 qa_weeks_state.result_published_at 로 공표상태 COALESCE override
    //   (운영 weeks 무변경 · 미공표 주차를 QA 에서 먼저 공표한 결과가 테스트 유저 카드에 반영).
    //   실유저(operating) → applyQaWeekPublishOverlay 가 즉시 원본 반환(qa_* 무조회) → 경로 불변.
    const scope = await resolveStateScopeForUser(userId);
    weeks = await applyQaWeekPublishOverlay(weeks, scope);
  }

  return {
    userId,
    profile,
    weekStatuses,
    seasonStatuses,
    officialRestPeriods,
    weeks,
  };
}

import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getSeasonForDate } from "@/lib/seasonCalendar";
import {
  describeWeekByStartMs,
  getCurrentWeekStartMs,
  getOpenableWeekStartMs,
} from "@/lib/cluster4WeekPolicy";
import { fetchActiveRestPeriods } from "@/lib/officialRestPeriodsData";
import { matchOfficialRestPeriods } from "@/lib/officialRestPeriodsTypes";
import { readScopeMode } from "@/lib/userScopeShared";
import { resolveCluster4TestOpenableWeekStartMs } from "@/lib/cluster4TestWeekPolicy";

// 라인 개설 어드민 UI 에서 사용하는 "최근 주차 옵션" 엔드포인트.
// 현재 주차 N 을 포함해 직전 몇 주(N-1, N-2 ...) 까지 weeks 테이블에서 매칭한 행만 돌려준다.
//
// 운영 정책(금요일 경계 규칙): 라인 개설 가능 주차(isOpenTarget=true)는
//   describeOpenableWeek 와 동일하게 getOpenableWeekStartMs 로 결정한다 —
//   월·화·수·목이면 N-1, 금·토·일이면 N(현재 주). N(현재주차)은 isCurrent=true.
// 일반 모드 프론트는 weekSelect 를 렌더링하지 않고 isOpenTarget 주차를 자동 사용하며,
// 서버 info-lines POST 도 같은 함수로 강제하므로 표시 주차 == 저장 주차.
// dev 모드(?dev=true)에서만 weekSelect 로 과거 주차(N-1, N-2 ...)를 선택할 수 있다.

const DAY_MS = 86_400_000;
const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 6;

type WeekOption = {
  // Canonical fields — UI 와 POST body 사이 혼동을 막기 위해 단일 키로 노출.
  id: string;             // weeks.id (UUID) — POST body 의 week_id 로 그대로 전달.
  label: string;          // "{year}년도 {season} {weekNumber}w" 형태의 표시용 라벨.
  weekId: string;         // legacy alias = id (이전 코드 호환).
  seasonKey: string;
  seasonName: string;
  year: number;
  weekNumber: number;
  startDate: string;
  endDate: string;
  isOfficialRest: boolean;
  canOpen: boolean;
  isCurrent: boolean;     // 오늘이 속한 주차 N.
  isOpenTarget: boolean;  // 운영 정책상 개설 가능 주차(금요일 경계: 월~목=N-1, 금~일=N).
  submissionOpensAt: string | null;
  submissionClosesAt: string | null;
};

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { searchParams } = new URL(request.url);
  const rawLimit = searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (rawLimit) {
    const parsed = Number(rawLimit);
    if (Number.isFinite(parsed) && parsed >= 1) {
      limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(parsed)));
    }
  }

  try {
    const todayIso = new Date().toISOString().slice(0, 10);
    const todaySeason = getSeasonForDate(todayIso);
    if (!todaySeason) {
      return Response.json(
        { success: false, error: "현재 시즌을 찾을 수 없습니다" },
        { status: 500 },
      );
    }

    const currentWeekStartMs = getCurrentWeekStartMs(todayIso);
    if (currentWeekStartMs == null) {
      return Response.json(
        { success: false, error: "현재 주차를 계산할 수 없습니다" },
        { status: 500 },
      );
    }

    // 개설 대상 주차(금요일 경계 규칙) — describeOpenableWeek 와 동일 계산.
    //   테스트 모드(?mode=test) 휴식꼬리에서는 공통 SoT 가 마지막 활동 주차(2026 봄 W13)로 폴드한다.
    //   운영 모드는 base 그대로 → 응답 byte-identical(회귀 0). isOpenTarget 은 이 폴드된 ms 기준.
    const mode = readScopeMode(searchParams);
    const regularOpenableWeekStartMs = getOpenableWeekStartMs(todayIso);
    const openableWeekStartMs = resolveCluster4TestOpenableWeekStartMs(
      mode,
      regularOpenableWeekStartMs,
      { hub: "dropdown", organization: null },
    );

    // 후보 주차 시작 ms — 현재 주차 N 기준 limit 개 + (테스트 폴드된) 개설 대상 주차.
    //   테스트 휴식꼬리에서는 개설 대상(W13)이 현재 주차보다 과거라 limit 창 밖일 수 있어,
    //   명시적으로 포함해 드롭다운에서 선택 가능하게 한다(운영 모드는 항상 창 안 → 변화 없음).
    const candidateStartMsList: number[] = [];
    for (let offset = 0; offset < limit; offset++) {
      candidateStartMsList.push(currentWeekStartMs - offset * 7 * DAY_MS);
    }
    if (
      openableWeekStartMs != null &&
      !candidateStartMsList.includes(openableWeekStartMs)
    ) {
      candidateStartMsList.push(openableWeekStartMs);
    }
    const orderedStartMs = Array.from(new Set(candidateStartMsList)).sort(
      (a, b) => b - a,
    ); // 최신순(내림차순).

    const descriptors: Array<{
      isCurrent: boolean;
      isOpenTarget: boolean;
      info: NonNullable<ReturnType<typeof describeWeekByStartMs>>;
    }> = [];
    for (const weekStartMs of orderedStartMs) {
      const info = describeWeekByStartMs(weekStartMs);
      if (!info) continue;
      descriptors.push({
        isCurrent: weekStartMs === currentWeekStartMs,
        isOpenTarget:
          openableWeekStartMs != null && weekStartMs === openableWeekStartMs,
        info,
      });
    }

    if (descriptors.length === 0) {
      return Response.json({ success: true, data: { weeks: [] } });
    }

    // weeks 테이블 lookup — 매칭되는 행이 없으면 라인 개설 불가 처리.
    // Supabase JS 의 in-filter 만으로 (iso_year, iso_week) 페어 조회가 불편하므로 OR 표현식 사용.
    const orExpr = descriptors
      .map((d) => `and(iso_year.eq.${d.info.isoYear},iso_week.eq.${d.info.isoWeek})`)
      .join(",");

    const { data: weekRows, error: weekError } = await supabaseAdmin
      .from("weeks")
      .select("id,iso_year,iso_week,start_date,end_date")
      .or(orExpr);

    if (weekError) {
      return Response.json(
        { success: false, error: weekError.message },
        { status: 500 },
      );
    }

    // 날짜형 공식 휴식(설/추석/임시) — 활성 official_rest_periods 1회 prefetch.
    const activeRestPeriods = await fetchActiveRestPeriods();

    type WeekRow = {
      id: string;
      iso_year: number;
      iso_week: number;
      start_date: string;
      end_date: string;
    };

    const weekRowByKey = new Map<string, WeekRow>();
    for (const row of (weekRows ?? []) as WeekRow[]) {
      weekRowByKey.set(`${row.iso_year}::${row.iso_week}`, row);
    }

    const weeks: WeekOption[] = [];
    for (const { isCurrent, isOpenTarget, info } of descriptors) {
      const row = weekRowByKey.get(`${info.isoYear}::${info.isoWeek}`);
      if (!row) continue;

      // 최종 공식 휴식 = seasonCalendar rule(info.isOfficialRest) ∨ 날짜 overlap.
      // weeks.is_official_rest 는 참조하지 않는다.
      const isOfficialRest =
        info.isOfficialRest ||
        matchOfficialRestPeriods(
          { startDate: info.weekStart, endDate: info.weekEnd },
          activeRestPeriods,
        ).length > 0;
      const canOpen = !isOfficialRest;
      const label = `${info.year}년도 ${info.seasonName} ${info.weekNumber}w`;
      weeks.push({
        id: row.id,
        label,
        weekId: row.id, // legacy alias
        seasonKey: info.seasonKey,
        seasonName: info.seasonName,
        year: info.year,
        weekNumber: info.weekNumber,
        startDate: info.weekStart,
        endDate: info.weekEnd,
        isOfficialRest,
        canOpen,
        isCurrent,
        isOpenTarget,
        submissionOpensAt: isOfficialRest ? null : info.submissionOpensAt,
        submissionClosesAt: isOfficialRest ? null : info.submissionClosesAt,
      });
    }

    return Response.json({ success: true, data: { weeks } });
  } catch (error) {
    console.error("[admin/cluster4/weeks-options GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load weeks options",
      },
      { status: 500 },
    );
  }
}

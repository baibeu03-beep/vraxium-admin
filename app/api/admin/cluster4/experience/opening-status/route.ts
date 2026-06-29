import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  describeWeekByStartMs,
  getCurrentWeekStartMs,
  getOpenableWeekStartMs,
} from "@/lib/cluster4WeekPolicy";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import { listTeams } from "@/lib/adminExperienceLineData";
import { parseScopeMode } from "@/lib/userScopeShared";
import { resolveCluster4TestOpenableWeekStartMs } from "@/lib/cluster4TestWeekPolicy";
import type {
  StatusExtension,
  StatusTeam,
  StatusWeek,
} from "@/lib/lineOpeningStatusEngine";

// 실무 경험 라인 개설 상태창(운영 대시보드) 데이터 — read-only.
//
//   GET /api/admin/cluster4/experience/opening-status?organization={slug}
//
// 반환:
//   currentWeek : 이번 주(N)
//   targetWeek  : 지난 주(개설 대상, 금요일 경계 = isOpenTarget). weeks-options 와 동일 SoT 헬퍼 재사용.
//   extension   : 대상 주차가 <확장> 기간(online/offline)에 해당하는지 (cluster4_experience_extension_periods).
//   teams       : org 의 cluster4_teams 마다 "활성 경험 라인 ≥1(대상 주차)" = opened 여부.
//
// ⚠ 표시 전용. snapshot/개설 강제 로직·demoUserId 경로 무관. 팀은 org 스코프이므로 demo/일반 동일.

const DAY_MS = 86_400_000;

function toMs(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getTime();
}

type WeekInfo = NonNullable<ReturnType<typeof describeWeekByStartMs>>;

function toStatusWeek(info: WeekInfo): StatusWeek {
  return {
    year: info.year,
    seasonName: info.seasonName,
    weekNumber: info.weekNumber,
    startDate: info.weekStart,
    endDate: info.weekEnd,
    isOfficialRest: info.isOfficialRest,
  };
}

// 확장 기간 [start,end] 와 겹치는 달력 주차(월요일 정렬) 중 대상 주차의 1-based 위치/총수.
// (스펙 "(i/n)" 분모 의미는 실데이터 확인 후 조정 가능 — 현재는 겹치는 달력 주차 기준.)
function computeExtensionIndex(
  periodStartIso: string,
  periodEndIso: string,
  targetWeekStartMs: number,
): { index: number | null; total: number | null } {
  const startMs = toMs(periodStartIso);
  const endMs = toMs(periodEndIso);
  // 기간 시작일을 그 주의 월요일(이전/당일)로 정렬.
  const startDay = new Date(startMs).getUTCDay(); // 0=일..6=토
  const offsetToMonday = startDay === 0 ? -6 : 1 - startDay;
  const firstMondayMs = startMs + offsetToMonday * DAY_MS;

  const mondays: number[] = [];
  for (let m = firstMondayMs; m <= endMs; m += 7 * DAY_MS) {
    mondays.push(m);
  }
  if (mondays.length === 0) return { index: null, total: null };
  const pos = mondays.indexOf(targetWeekStartMs);
  return {
    index: pos >= 0 ? pos + 1 : null,
    total: mondays.length,
  };
}

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const org = request.nextUrl.searchParams.get("organization")?.trim() || null;
  // 팀별 개설 현황(블록3) 팀 목록도 모집단 모드 분기: operating=운영 팀만 / test=(T) 팀만.
  const mode = parseScopeMode(request.nextUrl.searchParams.get("mode"));

  try {
    const todayIso = getCurrentActivityDateIso();
    const currentStartMs = getCurrentWeekStartMs(todayIso);
    const regularOpenableStartMs = getOpenableWeekStartMs(todayIso);
    // 테스트 모드 예외(전 조직, 공통 SoT): 휴식 꼬리면 2026 봄 W13 시작 ms, 아니면 정규 대상 그대로.
    //   운영 모드는 base 그대로(회귀 0). 현재 주차 N(block1)은 불변.
    const openableStartMs = resolveCluster4TestOpenableWeekStartMs(
      mode,
      regularOpenableStartMs,
      { hub: "experience-line", organization: org },
    );

    const currentInfo =
      currentStartMs != null ? describeWeekByStartMs(currentStartMs) : null;
    const targetInfo =
      openableStartMs != null ? describeWeekByStartMs(openableStartMs) : null;

    const currentWeek: StatusWeek | null = currentInfo
      ? toStatusWeek(currentInfo)
      : null;
    const targetWeek: StatusWeek | null = targetInfo
      ? toStatusWeek(targetInfo)
      : null;

    // 대상 주차 weeks.id(UUID) — 팀별 개설 라인 조회에 필요.
    let targetWeekId: string | null = null;
    if (targetInfo) {
      const { data: weekRow } = await supabaseAdmin
        .from("weeks")
        .select("id")
        .eq("iso_year", targetInfo.isoYear)
        .eq("iso_week", targetInfo.isoWeek)
        .maybeSingle();
      targetWeekId = (weekRow as { id: string } | null)?.id ?? null;
    }

    // ── 팀별 개설 현황 ──
    // 팀 목록 = 현재 org 의 cluster4_teams(동적, 하드코딩 없음). org 없으면 빈 목록.
    const teamList = org ? await listTeams(org, mode) : [];
    const openedTeamIds = new Set<string>();
    if (targetWeekId && teamList.length > 0) {
      // 대상 주차에 target 이 걸린 라인 id 집합(cluster4_line_targets.week_id).
      const { data: targetRows, error: targetErr } = await supabaseAdmin
        .from("cluster4_line_targets")
        .select("line_id")
        .eq("week_id", targetWeekId);
      if (targetErr) throw targetErr;
      const lineIds = Array.from(
        new Set(
          ((targetRows ?? []) as Array<{ line_id: string | null }>)
            .map((r) => r.line_id)
            .filter((id): id is string => id != null),
        ),
      );
      if (lineIds.length > 0) {
        // 그 중 활성 experience 라인의 team_id 수집(개설 완료 = 해당 팀 활성 경험 라인 ≥1).
        const { data: lineRows, error: lineErr } = await supabaseAdmin
          .from("cluster4_lines")
          .select("team_id")
          .eq("part_type", "experience")
          .eq("is_active", true)
          .in("id", lineIds)
          .not("team_id", "is", null);
        if (lineErr) throw lineErr;
        for (const row of (lineRows ?? []) as Array<{ team_id: string | null }>) {
          if (row.team_id) openedTeamIds.add(row.team_id);
        }
      }
    }
    const teams: StatusTeam[] = teamList.map((tm) => ({
      teamId: tm.id,
      teamName: tm.teamName,
      opened: openedTeamIds.has(tm.id),
    }));

    // ── 확장 기간 판정 ──
    // 테이블 미적용(마이그레이션 전)이면 쿼리가 실패할 수 있으므로 fail-closed → kind:"none".
    let extension: StatusExtension = { kind: "none", index: null, total: null };
    if (targetInfo && openableStartMs != null) {
      try {
        let q = supabaseAdmin
          .from("cluster4_experience_extension_periods")
          .select("extension_kind,start_date,end_date,organization_slug")
          .eq("is_active", true);
        // org 전용 OR 공통(NULL). org 없으면 공통만.
        q = org
          ? q.or(`organization_slug.is.null,organization_slug.eq.${org}`)
          : q.is("organization_slug", null);
        const { data: extRows, error: extErr } = await q;
        if (extErr) throw extErr;

        const tStart = targetInfo.weekStart;
        const tEnd = targetInfo.weekEnd;
        const matched = ((extRows ?? []) as Array<{
          extension_kind: "online" | "offline";
          start_date: string;
          end_date: string;
        }>).find(
          // 주차 [월~일] 범위와 기간 [start,end] 겹침.
          (p) => p.start_date <= tEnd && p.end_date >= tStart,
        );
        if (matched) {
          const { index, total } = computeExtensionIndex(
            matched.start_date,
            matched.end_date,
            openableStartMs,
          );
          extension = { kind: matched.extension_kind, index, total };
        }
      } catch (extError) {
        // 테이블 부재/조회 실패 — 상태창 블록1/3 은 정상 렌더하도록 none 폴백.
        console.warn(
          "[experience/opening-status] extension lookup skipped:",
          extError instanceof Error ? extError.message : extError,
        );
      }
    }

    return Response.json({
      success: true,
      // targetWeekId = 개설 대상 주차 weeks.id(테스트 W13 예외 반영). 프론트가 개설 주차 기본값으로
      // 직접 사용한다(파트장 입력 그리드 selectedWeekId·드롭다운 표기). null=weeks 행 미존재.
      data: { currentWeek, targetWeek, targetWeekId, extension, teams },
    });
  } catch (error) {
    console.error("[admin/cluster4/experience/opening-status GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "상태창 데이터를 불러오지 못했습니다",
      },
      { status: 500 },
    );
  }
}

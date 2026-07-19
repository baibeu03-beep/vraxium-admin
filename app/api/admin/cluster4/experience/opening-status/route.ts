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
import {
  loadWeekOpeningConfig,
  type SavedConfig,
} from "@/lib/adminTeamPartsInfoWeekDetailData";
import { isExperienceLineOpenForWeek } from "@/lib/weekOpenGate";
import { EXPERIENCE_LINE_NOT_OPEN_REASON } from "@/lib/experienceLineOpenGate";
import { isOrganizationSlug } from "@/lib/organizations";
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
  // 선택 주차(?week_id) — 개설 탭 드롭다운이 고른 주차. 있으면 상태창(targetWeek·teams·extension)이
  //   그 주차 기준으로 판정한다(화면 단일 SoT = 선택 주차). 없으면 기존 동작(오늘 기준 금요일 경계
  //   개설 대상 주차 + 테스트 W13 예외). 운영/역량 화면은 미부착이라 회귀 0(byte-identical).
  const selectedWeekId =
    request.nextUrl.searchParams.get("week_id")?.trim() || null;

  try {
    const todayIso = getCurrentActivityDateIso();
    const currentStartMs = getCurrentWeekStartMs(todayIso);
    const currentInfo =
      currentStartMs != null ? describeWeekByStartMs(currentStartMs) : null;
    const currentWeek: StatusWeek | null = currentInfo
      ? toStatusWeek(currentInfo)
      : null;

    // ── 대상 주차(targetWeek) 결정 — 상태창 블록2/3·확장 판정의 기준 주차 ──
    //   선택 주차(selectedWeekId) 있으면: 그 weeks 행(start_date)으로 서술 → 상태창이 선택 주차 기준.
    //   없으면: 오늘 기준 금요일 경계 개설 대상(테스트 W13 예외 포함) — 기존 동작 그대로(회귀 0).
    //   ⚠ currentWeek(이번 주 N, block1)은 두 경로 모두 불변 — '오늘' 참조는 선택과 무관하게 유지.
    let targetWeekStartMs: number | null = null;
    let targetWeekId: string | null = null;
    if (selectedWeekId) {
      const { data: weekRow } = await supabaseAdmin
        .from("weeks")
        .select("id,start_date")
        .eq("id", selectedWeekId)
        .maybeSingle();
      const row = weekRow as { id: string; start_date: string } | null;
      if (row?.start_date) {
        targetWeekStartMs = toMs(row.start_date);
        targetWeekId = row.id;
      }
    } else {
      const regularOpenableStartMs = getOpenableWeekStartMs(todayIso);
      // 테스트 모드 예외(전 조직, 공통 SoT): 휴식 꼬리면 2026 봄 W13 시작 ms, 아니면 정규 대상 그대로.
      //   운영 모드는 base 그대로(회귀 0).
      targetWeekStartMs = resolveCluster4TestOpenableWeekStartMs(
        mode,
        regularOpenableStartMs,
        { hub: "experience-line", organization: org },
      );
    }

    const targetInfo =
      targetWeekStartMs != null
        ? describeWeekByStartMs(targetWeekStartMs)
        : null;
    const targetWeek: StatusWeek | null = targetInfo
      ? toStatusWeek(targetInfo)
      : null;

    // 대상 주차 weeks.id(UUID) — 팀별 개설 라인 조회에 필요.
    //   selectedWeekId 경로는 이미 확보. 정규(오늘 기준) 경로만 iso 로 조회한다.
    if (!targetWeekId && targetInfo) {
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
    // ── 개설 기간 판정(단일 SoT = cluster4_week_opening_configs → isExperienceLineOpenForWeek) ──
    //   org 지정 시에만 적용(통합=단일 클럽 config 없음 → isOpeningPeriod 미표기, 기존 상태창 동작 유지).
    //   대상 주차(targetWeekId) 기준. 팀 총괄 board.canOpen·서버 개설 게이트(assertExperienceLineOpenable)와
    //   동일 함수 → 상태창·버튼·POST 가 같은 개설 기간 판정을 본다.
    let hubCanOpen = false;
    let openConfig: SavedConfig | null = null;
    let openConfirmed = false;
    const orgSlug = isOrganizationSlug(org) ? org : null;
    if (orgSlug && targetWeekId) {
      const loaded = await loadWeekOpeningConfig(targetWeekId, orgSlug);
      openConfig = loaded.config;
      openConfirmed = loaded.openConfirmed;
      hubCanOpen = isExperienceLineOpenForWeek({
        openConfirmed,
        config: openConfig,
        teamId: null,
      });
    }
    const teams: StatusTeam[] = teamList.map((tm) => ({
      teamId: tm.id,
      teamName: tm.teamName,
      opened: openedTeamIds.has(tm.id),
      // org 지정 시에만 개설 기간 판정 부착(통합은 undefined → 기존 '개설 되어야 합니다' 유지).
      ...(orgSlug && targetWeekId
        ? {
            isOpeningPeriod: isExperienceLineOpenForWeek({
              openConfirmed,
              config: openConfig,
              teamId: tm.id,
            }),
          }
        : {}),
    }));

    // ── 확장 기간 판정 ──
    // 테이블 미적용(마이그레이션 전)이면 쿼리가 실패할 수 있으므로 fail-closed → kind:"none".
    let extension: StatusExtension = { kind: "none", index: null, total: null };
    if (targetInfo && targetWeekStartMs != null) {
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
            targetWeekStartMs,
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
      // canOpen = 대상 주차 허브 전체 개설 기간 여부(org 지정 시). openBlockedReason = 차단 사유(canOpen=false).
      data: {
        currentWeek,
        targetWeek,
        targetWeekId,
        extension,
        teams,
        canOpen: hubCanOpen,
        openBlockedReason:
          orgSlug && targetWeekId && !hubCanOpen ? EXPERIENCE_LINE_NOT_OPEN_REASON : null,
      },
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

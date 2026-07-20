import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  CLUSTER4_LINE_WRITE_ROLES,
} from "@/lib/adminCluster4LinesTypes";
import {
  Cluster4LineError,
  invalidateWeeklyCardsForLineOpen,
  deleteCluster4Line,
  findActiveInfoLineId,
  listCluster4InfoLinesDetailed,
} from "@/lib/adminCluster4LinesData";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { QA_HIDE_REAL_USERS } from "@/lib/qaFixedScope";
import { invalidateWeeklyCardsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";
import { payLineOpenTargetsOnce } from "@/lib/processPointAccrual";
import { isUuid } from "@/lib/isUuid";
import {
  type Cluster4OutputLink,
  outputLinksFromLegacy,
  outputLinksToLegacySlots,
  parseOutputLinksInput,
} from "@/lib/cluster4OutputLinks";
import {
  type Cluster4OutputImage,
  parseOutputImagesInput,
} from "@/lib/cluster4OutputImages";
import {
  describeOpenableWeek,
  describeWeekByStartMs,
  getOpenableWeekStartMs,
  submissionWindowForWeekStartIso,
} from "@/lib/cluster4WeekPolicy";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import { resolveCluster4TestOpenableWeekStartMs } from "@/lib/cluster4TestWeekPolicy";
import { resolveWeekOfficialRest } from "@/lib/officialRestPeriodsData";
import { isOrganizationSlug } from "@/lib/organizations";
import {
  lineCodeTokenForOrg,
} from "@/lib/cluster4LineOrg";
import {
  isLineScopeVisibleForOrg,
  resolveLineScopeFromValues,
} from "@/lib/lineScope";
import { insertOpeningLogForLine } from "@/lib/adminCluster4OpeningLogs";
import {
  LineOpeningWindowError,
  findActiveLineOpeningException,
} from "@/lib/lineOpeningWindowsData";
import {
  resolveUserScope,
  readScopeMode,
  assertUserIdsInScope,
} from "@/lib/userScope";
import { loadWeekOpeningConfig } from "@/lib/adminTeamPartsInfoWeekDetailData";
import { isInfoLineOpenForWeek } from "@/lib/weekOpenGate";
import { computeLineOpenWindow } from "@/lib/cluster4LineSubmissionWindow";

// GET /api/admin/cluster4/info-lines?week_id=&activity_type_id=
// 실무 정보(part_type='info') 라인을 활동 유형 탭별/주차별로 운영하기 위한
// enriched 목록. 대상자 이름·제출 상태·lineTargetId 단위 canEdit 까지 포함한다.
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const params = request.nextUrl.searchParams;
  const weekId = params.get("week_id")?.trim() || null;
  const activityTypeId = params.get("activity_type_id")?.trim() || null;
  // 조직 스코프(통합 ↔ 조직 진입). 내부 API 컨벤션은 organization. 미지정/무효 = 통합(전체).
  const organizationRaw = params.get("organization")?.trim() || null;
  const organization = isOrganizationSlug(organizationRaw) ? organizationRaw : null;
  // 운영/테스트 모집단 스코프(QA 누수 차단) — ?mode=test → target 이 test_user_markers 인 라인만.
  //   미지정=operating(실사용자 라인만). 누락 시 "개설 대상 크루"에 운영 실사용자가 섞인다.
  const mode = readScopeMode(params);

  if (weekId !== null && !isUuid(weekId)) {
    return Response.json(
      { success: false, error: "week_id must be a UUID" },
      { status: 400 },
    );
  }

  try {
    const data = await listCluster4InfoLinesDetailed({
      weekId,
      activityTypeId,
      organization,
      mode,
    });
    // 이번 주 "오픈(개설 대상)" 여부 — 실제 개설 게이트와 동일 판정(weekOpenGate). 개설 폼이 미오픈 라인을
    //   차단하는 데 쓴다. week+activityType+org 가 모두 있을 때만 산정(통합/미지정=null=게이트 미적용).
    let isOpenThisWeek: boolean | null = null;
    if (weekId && activityTypeId && organization) {
      const { config, openConfirmed } = await loadWeekOpeningConfig(weekId, organization);
      isOpenThisWeek = isInfoLineOpenForWeek({ openConfirmed, config, activityTypeId });
    }
    return Response.json({ success: true, data: { ...data, isOpenThisWeek } });
  } catch (error) {
    if (error instanceof Cluster4LineError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/cluster4/info-lines GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to list info lines",
      },
      { status: 500 },
    );
  }
}

type InfoLineCreateBody = {
  activity_type_id: string;
  main_title: string;
  output_link_1: string | null;
  output_link_2: string | null;
  output_links: Cluster4OutputLink[];
  output_images: Cluster4OutputImage[];
  // 라인 개설 크루(targetCrewIds). 0명 허용 — 0명 개설 = 전체 크루 강화 실패.
  target_user_ids: string[];
  week_id: string;
  submission_opens_at: string;
  submission_closes_at: string;
  // 카페 검수 메타(선택, 감사용). 컬럼 미존재 시 저장 생략.
  cafe_url: string | null;
  matched_crew_count: number | null;
  raw_comment_count: number | null;
};

function parseBody(
  body: unknown,
): { ok: true; value: InfoLineCreateBody } | { ok: false; status: number; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, error: "Request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  // activity_type_id — required
  if (typeof b.activity_type_id !== "string" || b.activity_type_id.trim().length === 0) {
    return { ok: false, status: 400, error: "activity_type_id is required" };
  }

  // main_title — required
  if (typeof b.main_title !== "string" || b.main_title.trim().length === 0) {
    return { ok: false, status: 400, error: "main_title is required" };
  }

  // info_subtitle / info_growth_point 는 크루원 제출값으로 재정의됨 → 라인 개설 입력에서 제거.
  //   (cluster4_line_submissions.subtitle / growth_point 로 이전. 2026-05-30)

  // output_link_1 — optional
  let outputLink1: string | null = null;
  if (b.output_link_1 !== undefined && b.output_link_1 !== null) {
    if (typeof b.output_link_1 !== "string") {
      return { ok: false, status: 400, error: "output_link_1 must be a string or null" };
    }
    const trimmed = b.output_link_1.trim();
    outputLink1 = trimmed.length > 0 ? trimmed : null;
  }

  // output_link_2 — optional
  let outputLink2: string | null = null;
  if (b.output_link_2 !== undefined && b.output_link_2 !== null) {
    if (typeof b.output_link_2 !== "string") {
      return { ok: false, status: 400, error: "output_link_2 must be a string or null" };
    }
    const trimmed = b.output_link_2.trim();
    outputLink2 = trimmed.length > 0 ? trimmed : null;
  }

  // output_images — optional. string[] 또는 [{url, caption?}] 둘 다 허용 (URL + 캡션 저장).
  const parsedImages = parseOutputImagesInput(b.output_images);
  if (!parsedImages.ok) {
    return { ok: false, status: 400, error: parsedImages.error };
  }
  const outputImages = parsedImages.value;

  // output_links 우선. 미제공 시 레거시 output_link_1/2 로부터 파생. 라인은 슬롯 2개.
  const parsedLinks = parseOutputLinksInput(b.output_links, { maxLinks: 2 });
  if (!parsedLinks.ok) {
    return { ok: false, status: 400, error: parsedLinks.error };
  }
  const outputLinks =
    parsedLinks.value.length > 0
      ? parsedLinks.value
      : outputLinksFromLegacy([outputLink1, outputLink2]);
  // 레거시 컬럼은 항상 output_links 로부터 mirror.
  const [mirrorLink1, mirrorLink2] = outputLinksToLegacySlots(outputLinks, 2);
  outputLink1 = mirrorLink1;
  outputLink2 = mirrorLink2;

  // Output Asset validation: 1 <= total <= 2
  const linkCount = outputLinks.length;
  const imageCount = outputImages.length;
  const totalAssets = linkCount + imageCount;
  if (totalAssets < 1) {
    return { ok: false, status: 400, error: "Output을 최소 1개 입력해주세요 (Link + Image 합산)" };
  }
  if (totalAssets > 2) {
    return { ok: false, status: 400, error: "Output은 최대 2개까지 입력 가능합니다 (Link + Image 합산)" };
  }

  // 라인 개설 크루 — target_user_ids(= targetCrewIds). 0명 허용(2026-06-09 정책 개정).
  //   0명 개설 = "라인은 개설됐지만 성공 대상자 0명" → 그 주차/라인은 전체 크루에게 강화 실패.
  //   (라인 자체가 없으면 기존처럼 해당 없음.) 배열이기만 하면 되고, 항목은 유효 UUID 여야 한다.
  const rawTargets = Array.isArray(b.target_user_ids)
    ? b.target_user_ids
    : Array.isArray(b.target_crew_ids)
      ? b.target_crew_ids
      : null;
  if (rawTargets === null) {
    return { ok: false, status: 400, error: "target_user_ids must be an array (0명 허용)" };
  }
  const targetUserIds: string[] = [];
  for (const uid of rawTargets) {
    if (typeof uid !== "string" || !isUuid(uid)) {
      return { ok: false, status: 400, error: "target_user_ids must contain valid UUIDs" };
    }
    targetUserIds.push(uid);
  }
  // 중복 제거(같은 크루 중복 선택 방지).
  const dedupedTargetIds = Array.from(new Set(targetUserIds));

  // 카페 검수 메타(선택) — 문자열/숫자 또는 null.
  let cafeUrl: string | null = null;
  if (typeof b.cafe_url === "string" && b.cafe_url.trim().length > 0) {
    cafeUrl = b.cafe_url.trim();
  }
  const toIntOrNull = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
  const matchedCrewCount = toIntOrNull(b.matched_crew_count);
  const rawCommentCount = toIntOrNull(b.raw_comment_count);

  // week_id — required
  if (typeof b.week_id !== "string" || !isUuid(b.week_id)) {
    return { ok: false, status: 400, error: "week_id is required and must be a UUID" };
  }

  // submission period — required (server-calculated, passed from client)
  if (typeof b.submission_opens_at !== "string") {
    return { ok: false, status: 400, error: "submission_opens_at is required" };
  }
  if (typeof b.submission_closes_at !== "string") {
    return { ok: false, status: 400, error: "submission_closes_at is required" };
  }

  return {
    ok: true,
    value: {
      activity_type_id: b.activity_type_id.trim(),
      main_title: b.main_title.trim(),
      output_link_1: outputLink1,
      output_link_2: outputLink2,
      output_links: outputLinks,
      output_images: outputImages,
      target_user_ids: dedupedTargetIds,
      week_id: b.week_id,
      submission_opens_at: b.submission_opens_at,
      submission_closes_at: b.submission_closes_at,
      cafe_url: cafeUrl,
      matched_crew_count: matchedCrewCount,
      raw_comment_count: rawCommentCount,
    },
  };
}

export async function POST(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdmin(CLUSTER4_LINE_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  // Diagnostic: raw body inspection — request payload 가 실제로 어떤 키를 가지는지 확인.
  console.log("[info-lines POST raw body]", body);

  const parsed = parseBody(body);
  if (!parsed.ok) {
    console.log("[info-lines POST parse failed]", parsed.error);
    return Response.json(
      { success: false, error: parsed.error },
      { status: parsed.status },
    );
  }

  const input = parsed.value;

  // ── 조직 + 운영/테스트 스코프 강제 (cluster4_line_targets 혼입 방지) ─────────
  //   라인 개설 크루(target_user_ids)는 (현재 org 소속) AND (현재 mode 모집단) 둘 다여야 한다.
  //     mode : operating=실사용자만 / test=test_user_markers 만 (test_user_markers 단일 축). 422 on mix.
  //     org  : org-scoped 개설(?organization)이면 전원 그 organization_slug 소속이어야(동명이인 타org 차단). 422.
  //   둘 중 하나라도 어긋나면 DB write 0 으로 중단. 0명 개설은 통과. org 미지정(통합)=org 검사 생략.
  const scopeMode = readScopeMode(request.nextUrl.searchParams);
  const scopeOrgRaw = request.nextUrl.searchParams.get("organization")?.trim() || null;
  const scopeOrg = isOrganizationSlug(scopeOrgRaw) ? scopeOrgRaw : null;

  // 1) mode 가드 — test_user_markers 등재 여부 축.
  try {
    const scope = await resolveUserScope(scopeMode, scopeOrg);
    assertUserIdsInScope(scope, input.target_user_ids);
  } catch (error) {
    if ((error as { status?: number })?.status === 422) {
      return Response.json(
        { success: false, error: (error as Error).message },
        { status: 422 },
      );
    }
    throw error;
  }

  // 2) org 가드 — org-scoped 개설은 target 전원이 그 org 소속이어야 한다(동명이인 타org 저장 차단).
  if (scopeOrg && input.target_user_ids.length > 0) {
    const { data: orgRows, error: orgErr } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id,organization_slug")
      .in("user_id", input.target_user_ids);
    if (orgErr) {
      return Response.json({ success: false, error: orgErr.message }, { status: 500 });
    }
    const orgById = new Map(
      ((orgRows ?? []) as Array<{ user_id: string; organization_slug: string | null }>).map(
        (r) => [r.user_id, r.organization_slug],
      ),
    );
    const orgOffenders = input.target_user_ids.filter(
      (id) => orgById.get(id) !== scopeOrg,
    );
    if (orgOffenders.length > 0) {
      return Response.json(
        {
          success: false,
          error: `현재 클럽(${scopeOrg}) 소속이 아닌 사용자 ${orgOffenders.length}명이 포함되어 처리를 중단했습니다.`,
        },
        { status: 422 },
      );
    }
  }

  // ── 주차 정책 강제 (금요일 경계 규칙 + 라인 개설 예외) ────────────────────
  // 판정 규칙: 라인 개설 가능 = 자동 정책(금요일 경계) 허용  OR  활성 예외 존재.
  //   자동 정책: 개설 가능 주차 = describeOpenableWeek. 월·화·수·목=N-1, 금·토·일=N.
  //   예외:      line_opening_windows 에서 (week_id, activity_type) 활성 예외가 있으면
  //              그 주차도 개설 허용(설/추석/시험 등 휴식 자동 차단을 운영자가 덮어쓴 것).
  // 일반(운영) 모드에서는 클라이언트가 보낸 week_id 를 그대로 신뢰하지 않고,
  //   "자동 정책 주차" 또는 "활성 예외 주차" 둘 중 하나일 때만 허용한다(fail-closed).
  //   어느 쪽도 아니면 거부(409) → payload 조작으로 임의 주차 개설 불가.
  // dev 모드(?dev=true)에서만 클라이언트가 지정한 임의 주차를 그대로 허용한다(테스트용).
  const devMode = request.nextUrl.searchParams.get("dev") === "true";
  let effectiveWeekId = input.week_id;
  let effectiveOpensAt = input.submission_opens_at;
  let effectiveClosesAt = input.submission_closes_at;

  if (!devMode) {
    const todayIso = getCurrentActivityDateIso();
    const clientWeekId = input.week_id; // 이미 UUID 검증됨.

    // 자동 정책(개설 대상) 주차 — 비휴식 + 기입기간 산출 가능 + weeks 행 존재 시 "사용 가능".
    //   테스트 모드(scopeMode=test) 휴식꼬리에서는 공통 SoT 가 마지막 활동 주차(2026 봄 W13)로
    //   폴드 → 클라이언트가 보낸 W13 week_id 가 openableRowId 와 일치해 fail-closed 게이트를 통과한다.
    //   운영 모드는 base 그대로(describeOpenableWeek 와 동일) → 회귀 0.
    const effectiveOpenableStartMs = resolveCluster4TestOpenableWeekStartMs(
      scopeMode,
      getOpenableWeekStartMs(todayIso),
      { hub: "info-line", organization: scopeOrg },
    );
    const openable =
      effectiveOpenableStartMs != null
        ? describeWeekByStartMs(effectiveOpenableStartMs)
        : describeOpenableWeek(todayIso);
    let openableRowId: string | null = null;
    let openableUsable = false;
    if (openable) {
      // 공식 휴식 = seasonCalendar rule(시험) ∨ official_rest_periods overlap(설/추석/임시).
      const openableRest = await resolveWeekOfficialRest({
        startDate: openable.weekStart,
        endDate: openable.weekEnd,
      });
      const { data: openableRow, error: openableErr } = await supabaseAdmin
        .from("weeks")
        .select("id")
        .eq("iso_year", openable.isoYear)
        .eq("iso_week", openable.isoWeek)
        .maybeSingle();
      if (openableErr) {
        return Response.json(
          { success: false, error: openableErr.message },
          { status: 500 },
        );
      }
      openableRowId = openableRow?.id ?? null;
      openableUsable =
        !openableRest.isOfficialRest &&
        !!openable.submissionOpensAt &&
        !!openable.submissionClosesAt &&
        !!openableRowId;
    }

    // 1) 자동 정책 주차와 일치 + 사용 가능 → 서버 계산값으로 강제(기존 동작).
    if (openable && openableUsable && clientWeekId === openableRowId) {
      effectiveWeekId = openableRowId!;
      effectiveOpensAt = openable.submissionOpensAt!;
      effectiveClosesAt = openable.submissionClosesAt!;
    } else {
      // 2) 활성 예외 존재 → 클라이언트 주차 honor, 기입기간은 그 주차 기준으로 산출.
      let hasException = false;
      try {
        hasException = await findActiveLineOpeningException(
          clientWeekId,
          input.activity_type_id,
          scopeOrg,
          "info",
        );
      } catch (error) {
        if (error instanceof LineOpeningWindowError) {
          return Response.json(
            { success: false, error: error.message },
            { status: error.status },
          );
        }
        throw error;
      }

      if (hasException) {
        const { data: exRow, error: exErr } = await supabaseAdmin
          .from("weeks")
          .select("id,start_date")
          .eq("id", clientWeekId)
          .maybeSingle();
        if (exErr) {
          return Response.json(
            { success: false, error: exErr.message },
            { status: 500 },
          );
        }
        if (!exRow) {
          return Response.json(
            { success: false, error: "예외 주차에 해당하는 weeks 행이 없습니다" },
            { status: 404 },
          );
        }
        const win = submissionWindowForWeekStartIso(
          (exRow as { start_date: string }).start_date,
        );
        effectiveWeekId = (exRow as { id: string }).id;
        effectiveOpensAt = win.submissionOpensAt;
        effectiveClosesAt = win.submissionClosesAt;
      } else if (scopeOrg) {
        // 3) org-scoped 관리자 수동 개설 — 선택한 과거 주차를 존중한다(현재/자동정책 주차 고정 제한 해제).
        //    "임의 주차 무조건 개설"이 아니다: 아래 라인 개설 오픈 게이트(isInfoLineOpenForWeek)가
        //    effectiveWeekId 기준으로 활동 관리 오픈 설정을 서버에서 재검증하고, 주차 존재/중복/권한도
        //    각각 강제한다. 운영 중 개설 누락·잘못 개설 취소 후 재개설·장애 복구·과거 주차 보정 등
        //    관리자 수동 개설 예외 상황을 위한 경로. (통합/org 미지정은 config 축이 없어 아래 4)에서 fail-closed.)
        //    기입 기간은 선택 주차 시작(월요일) 기준으로 서버가 산출한다(클라이언트 값 불신).
        const { data: selRow, error: selErr } = await supabaseAdmin
          .from("weeks")
          .select("id,start_date")
          .eq("id", clientWeekId)
          .maybeSingle();
        if (selErr) {
          return Response.json(
            { success: false, error: selErr.message },
            { status: 500 },
          );
        }
        if (!selRow) {
          return Response.json(
            { success: false, error: "선택한 주차에 해당하는 weeks 행이 없습니다" },
            { status: 404 },
          );
        }
        const win = submissionWindowForWeekStartIso(
          (selRow as { start_date: string }).start_date,
        );
        effectiveWeekId = (selRow as { id: string }).id;
        effectiveOpensAt = win.submissionOpensAt;
        effectiveClosesAt = win.submissionClosesAt;
      } else {
        // 4) 통합(org 미지정) 자동도 예외도 아님 → 차단(fail-closed).
        //    활동 관리 config 는 org-scoped 이므로 통합 개설은 오픈 설정 재검증 축이 없다 →
        //    현재 주차/자동 정책/예외만 허용하는 종전 규칙 유지(무접촉).
        if (openable && !openableUsable && clientWeekId === openableRowId) {
          return Response.json(
            {
              success: false,
              error:
                "현재 개설 가능 주차가 공식 휴식 주차입니다 (예외 등록 시 개설 가능)",
            },
            { status: 409 },
          );
        }
        return Response.json(
          {
            success: false,
            error:
              "선택한 주차는 개설 가능 주차가 아닙니다 (자동 정책 주차 또는 활성 예외만 허용)",
          },
          { status: 409 },
        );
      }
    }
  }

  // ── 2차 기입 창 = 개설 시점 + 48h (주차 레벨 창 대체) ─────────────────────────
  //   week_id(귀속 주차)는 위에서 확정한 effectiveWeekId 그대로 두고, submission window 만
  //   개설 시점 기준(now / now+48h)으로 stamp 한다. 이 한 값이 크루 수정창 + 강화 deadlinePassed +
  //   snapshot + payout 을 동시에 게이트하므로, 여기서 통일하면 하류 코드 변경 없이 48h 정책이 걸린다.
  {
    const openWindow = computeLineOpenWindow();
    effectiveOpensAt = openWindow.submissionOpensAt;
    effectiveClosesAt = openWindow.submissionClosesAt;
  }

  // ── 라인 개설 오픈 게이트 (강제) ─────────────────────────────────────────────
  //   open_confirmed=true + practicalInfo[activityType] 체크된 "오픈 라인"만 개설 허용한다.
  //   활동 관리·주차별 개설 결과·개설 폼과 동일 판정 함수(isInfoLineOpenForWeek) — 미오픈이면 409 차단.
  //   org-scoped 개설에만 적용(통합=단일 config 없음). URL/HTTP/dev 조작으로 우회 불가(서버 강제).
  if (scopeOrg) {
    const { config: openCfg, openConfirmed } = await loadWeekOpeningConfig(effectiveWeekId, scopeOrg);
    if (!isInfoLineOpenForWeek({ openConfirmed, config: openCfg, activityTypeId: input.activity_type_id })) {
      return Response.json(
        { success: false, error: "이번 주에 오픈되지 않은 라인입니다." },
        { status: 409 },
      );
    }
  }

  try {
    // 1. Verify week exists
    const { data: weekRow, error: weekError } = await supabaseAdmin
      .from("weeks")
      .select("id")
      .eq("id", effectiveWeekId)
      .maybeSingle();
    if (weekError) {
      return Response.json(
        { success: false, error: weekError.message },
        { status: 500 },
      );
    }
    if (!weekRow) {
      return Response.json(
        { success: false, error: "week not found" },
        { status: 404 },
      );
    }

    // 2. Verify activity_type exists in practical_info cluster
    const { data: actType, error: actError } = await supabaseAdmin
      .from("activity_types")
      .select("id")
      .eq("id", input.activity_type_id)
      .eq("cluster_id", "practical_info")
      .eq("is_active", true)
      .maybeSingle();
    if (actError) {
      return Response.json(
        { success: false, error: actError.message },
        { status: 500 },
      );
    }
    if (!actType) {
      return Response.json(
        { success: false, error: "해당 활동 유형을 찾을 수 없습니다" },
        { status: 404 },
      );
    }

    // 3. Check for active line with same activity_type_id IN THE SAME WEEK.
    //    중복 기준: activity_type_id + week_id + is_active.
    //    cluster4_lines 에는 week_id 가 없고 cluster4_line_targets 에 있으므로,
    //    같은 활동 유형의 active 라인 중 "선택 주차에 target 이 있는" 라인이 있으면 중복.
    //    org 인지(2026-06-16): 다른 조직이 같은 주차+활동유형에 개설한 라인은 충돌이 아니다.
    //    org 노출 범위(line_code 토큰)가 현재 org 에 보이는 라인(== scopeOrg OR common)만 후보로 둔다.
    //    scopeOrg 미지정(통합) 이면 종전대로 전부 후보(통합 개설은 전체와 충돌).
    const { data: activeLines, error: activeLinesError } = await supabaseAdmin
      .from("cluster4_lines")
      .select("id,line_code")
      .eq("part_type", "info")
      .eq("activity_type_id", input.activity_type_id)
      .eq("is_active", true);
    if (activeLinesError) {
      return Response.json(
        { success: false, error: activeLinesError.message },
        { status: 500 },
      );
    }
    const activeLineIds = ((activeLines ?? []) as Array<{
      id: string;
      line_code: string | null;
    }>)
      .filter((l) => {
        if (!scopeOrg) return true;
        // info 라인 org = line_code 토큰, 없으면 'common'(resolveCluster4LineOrgScope 와 동일).
        const lineScope = resolveLineScopeFromValues({
          partType: "info",
          lineCode: l.line_code,
        });
        return isLineScopeVisibleForOrg(lineScope, scopeOrg, { allowUnknown: false });
      })
      .map((l) => l.id);
    if (activeLineIds.length > 0) {
      const { data: clashTargets, error: clashError } = await supabaseAdmin
        .from("cluster4_line_targets")
        .select("id")
        .eq("week_id", effectiveWeekId)
        .in("line_id", activeLineIds)
        .limit(1);
      if (clashError) {
        return Response.json(
          { success: false, error: clashError.message },
          { status: 500 },
        );
      }
      if (clashTargets && clashTargets.length > 0) {
        return Response.json(
          {
            success: false,
            error: "선택한 주차에는 이 활동 유형의 활성 라인이 이미 있습니다",
          },
          { status: 409 },
        );
      }
    }

    // 4. Create cluster4_lines row.
    //    week_id 를 라인 자체에도 기록(0명 개설 포함) — 어드민 주차/이력 정합. (기존엔 NULL)
    //    cafe_* 메타는 선택 — 컬럼 미적용(42703)이면 메타 없이 재시도(graceful).
    const LINE_RETURN =
      "id,part_type,activity_type_id,line_code,week_id,main_title,output_link_1,output_link_2,output_links,output_images,submission_opens_at,submission_closes_at,is_active,created_at";
    // info 라인 org SoT = line_code 토큰(BS/EC/OK/PX). 개설 ?organization 의 org 토큰을 line_code 에
    //   심어 resolveLineOrg 가 'common'(전체 노출)으로 폴백하지 않게 한다 — org 누수 방지(2026-06-16).
    //   org 미지정(통합) 개설만 line_code=null → 'common'(명시적 전체 공통). 토큰은 항상 대문자라
    //   숫자 suffix 가 EC/OK/PX/BS 를 오염시키지 않는다. 비유니크 컬럼이라 suffix 충돌 무해.
    const lineCode = scopeOrg
      ? `IF${lineCodeTokenForOrg(scopeOrg)}-OPEN${Date.now()}`
      : null;
    const baseLinePayload = {
      part_type: "info",
      activity_type_id: input.activity_type_id,
      line_code: lineCode,
      main_title: input.main_title,
      output_link_1: input.output_link_1,
      output_link_2: input.output_link_2,
      output_links: input.output_links,
      // output_images = [{url, caption}] (캡션 포함). 레거시 string[] 입력도 파서가 변환.
      output_images: input.output_images,
      submission_opens_at: effectiveOpensAt,
      submission_closes_at: effectiveClosesAt,
      week_id: effectiveWeekId,
      is_active: true,
      // QA 기간(QA_HIDE_REAL_USERS=true) 생성분 표식 — 운영 조회 제외. 기본 false.
      is_qa_test: QA_HIDE_REAL_USERS,
      created_by: admin.userId,
      updated_by: admin.userId,
    };
    const cafePayload = {
      cafe_url: input.cafe_url,
      matched_crew_count: input.matched_crew_count,
      raw_comment_count: input.raw_comment_count,
    };

    type LineRow = { id: string; [key: string]: unknown };
    let lineRow: LineRow | null = null;
    let lineError: { message?: string; code?: string } | null = null;
    {
      const res = await supabaseAdmin
        .from("cluster4_lines")
        .insert({ ...baseLinePayload, ...cafePayload })
        .select(LINE_RETURN)
        .single();
      lineRow = (res.data as LineRow | null) ?? null;
      lineError = res.error;
      // cafe_* 컬럼 미적용 감지 — undefined_column(42703) 또는 PostgREST 스키마 캐시 미존재(PGRST204)
      // 또는 메시지에 cafe 컬럼/schema cache 언급. 어느 쪽이든 메타 없이 재시도한다.
      const missingCafeCol =
        !!lineError &&
        (lineError.code === "42703" ||
          lineError.code === "PGRST204" ||
          /cafe_url|matched_crew_count|raw_comment_count|schema cache/i.test(
            lineError.message ?? "",
          ));
      if (missingCafeCol) {
        // cafe_* 컬럼 미적용 — 메타 없이 재시도.
        const retry = await supabaseAdmin
          .from("cluster4_lines")
          .insert(baseLinePayload)
          .select(LINE_RETURN)
          .single();
        lineRow = (retry.data as LineRow | null) ?? null;
        lineError = retry.error;
      }
    }

    if (lineError || !lineRow) {
      const msg = lineError?.message ?? "Failed to create line";
      const status = lineError?.code === "23505" ? 409 : 500;
      return Response.json({ success: false, error: msg }, { status });
    }
    const createdLine: LineRow = lineRow;

    // 5. Create cluster4_line_targets.
    //    - 크루 1명 이상: user-mode 타깃(기존). 그 크루만 강화 대기→성공 흐름, 미배정 크루는 강화 실패.
    //    - 크루 0명: "라인은 개설, 성공 대상자 0명". 주차-라인 연결을 위해 sentinel(rule-mode,
    //      user=null, target_rule.zeroTargetOpen=true) 1행만 넣는다. 스냅샷 openedByWeek 가 이 행으로
    //      라인을 그 주차에 "개설됨"으로 인식 → 전체 크루가 강화 실패(누구도 user-target 아님).
    //      이 sentinel 은 어드민 대상자 목록/카운트에서 제외된다(listCluster4LinesDetailed 필터).
    type TargetInsert = {
      line_id: string;
      week_id: string;
      target_mode: "user" | "rule";
      target_user_id: string | null;
      target_rule: Record<string, unknown>;
      created_by: string;
      updated_by: string;
    };
    const isZeroTarget = input.target_user_ids.length === 0;
    const targetRows: TargetInsert[] = isZeroTarget
      ? [
          {
            line_id: createdLine.id,
            week_id: effectiveWeekId,
            target_mode: "rule",
            target_user_id: null,
            target_rule: { zeroTargetOpen: true },
            created_by: admin.userId,
            updated_by: admin.userId,
          },
        ]
      : input.target_user_ids.map((userId) => ({
          line_id: createdLine.id,
          week_id: effectiveWeekId,
          target_mode: "user",
          target_user_id: userId,
          target_rule: {},
          created_by: admin.userId,
          updated_by: admin.userId,
        }));

    const { data: targets, error: targetError } = await supabaseAdmin
      .from("cluster4_line_targets")
      .insert(targetRows)
      .select("id,line_id,week_id,target_user_id,target_mode");

    if (targetError) {
      // Line was created but targets failed — still report partial success
      console.error("[admin/cluster4/info-lines POST] targets insert failed", targetError);
      return Response.json(
        {
          success: false,
          error: `라인은 생성되었으나 대상 등록에 실패했습니다: ${targetError.message}`,
          data: { lineId: createdLine.id },
        },
        { status: 500 },
      );
    }

    // weekly-cards snapshot 무효화 = 3허브 통일 헬퍼(info/experience/competency 동일 기준).
    //   개설된 info 라인은 배정 크루뿐 아니라 org audience 전원의 분모 A(개설+미배정=fail)에
    //   반영되므로, 배정 타깃(즉시 재계산) + org audience(stale→lazy 수렴)를 함께 무효화한다.
    //   0명 개설도 동일 헬퍼로 처리(targets=[] → audience 만 stale). 스코프는 헬퍼가 mode 로 적용
    //   (교차 모드 실유저 무접촉). 과거 targets-only(+미배정 lazy 수렴) 드리프트 제거.
    await invalidateWeeklyCardsForLineOpen(createdLine.id, input.target_user_ids, scopeMode);

    // 라인 개설 대상자 등록 → Point A·B 즉시 지급(source='line', pay-once). 공통 SoT. best-effort.
    try {
      await payLineOpenTargetsOnce(createdLine.id);
    } catch (payoutErr) {
      console.warn("[info-lines POST] line payout failed", payoutErr);
    }

    // [섹션 0] 로그창: 개설 = [개설 완료] 로그. best-effort(snapshot 무관, 본 동작과 분리).
    await insertOpeningLogForLine({
      action: "open",
      lineId: createdLine.id,
      weekId: effectiveWeekId,
      activityTypeId: input.activity_type_id,
      changedBy: admin.userId,
    });

    return Response.json(
      {
        success: true,
        data: {
          line: createdLine,
          // sentinel(rule) 행은 노출하지 않는다 — 실제 user 타깃만.
          targets: (targets ?? []).filter(
            (t) => (t as { target_mode?: string }).target_mode === "user",
          ),
          targetCount: input.target_user_ids.length,
          matchedCrewCount: input.matched_crew_count,
          rawCommentCount: input.raw_comment_count,
          cafeUrl: input.cafe_url,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("[admin/cluster4/info-lines POST]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to create info line",
      },
      { status: 500 },
    );
  }
}

// DELETE /api/admin/cluster4/info-lines?week_id=&activity_type_id=
// 개설 취소 — "개설 행위 자체를 되돌린다".
//   1) 해당 주차+활동유형의 활성 라인 + 연결 target 삭제(FK cascade).
//   2) 배정 크루 + org audience 의 weekly-cards snapshot 재계산 → 라인이 사라져 전체 크루가
//      "해당 없음"(not_applicable)으로 복귀(미개설 상태와 동일). (deleteCluster4Line 가 수행)
//   3) 개설 로그에 'cancel' 이벤트 append(append-only audit — open 로그는 보존). best-effort.
// 결과: 고객 앱에서도 해당 라인이 존재하지 않는 상태가 된다.
export async function DELETE(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdmin(CLUSTER4_LINE_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const params = request.nextUrl.searchParams;
  const weekId = params.get("week_id")?.trim() || null;
  const activityTypeId = params.get("activity_type_id")?.trim() || null;
  // org 분기 진입(?organization)이면 그 org 라인만 취소 대상 — 타org 라인 오삭제 방지.
  const cancelOrgRaw = params.get("organization")?.trim() || null;
  const cancelOrg = isOrganizationSlug(cancelOrgRaw) ? cancelOrgRaw : null;
  if (!weekId || !isUuid(weekId)) {
    return Response.json(
      { success: false, error: "week_id is required and must be a UUID" },
      { status: 400 },
    );
  }
  if (!activityTypeId) {
    return Response.json(
      { success: false, error: "activity_type_id is required" },
      { status: 400 },
    );
  }

  try {
    const lineId = await findActiveInfoLineId(weekId, activityTypeId, cancelOrg);
    if (!lineId) {
      return Response.json(
        { success: false, error: "취소할 개설 라인이 없습니다" },
        { status: 404 },
      );
    }

    // 라인 + 타깃 삭제 + 영향 크루(배정자 + org audience) snapshot 재계산.
    await deleteCluster4Line(lineId);

    // 개설 로그: 취소 = [개설 취소] 로그 append. best-effort(snapshot 무관, 본 동작과 분리).
    await insertOpeningLogForLine({
      action: "cancel",
      lineId,
      weekId,
      activityTypeId,
      changedBy: admin.userId,
    });

    return Response.json({
      success: true,
      data: { lineId, cancelled: true },
    });
  } catch (error) {
    if (error instanceof Cluster4LineError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/cluster4/info-lines DELETE]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to cancel info line",
      },
      { status: 500 },
    );
  }
}

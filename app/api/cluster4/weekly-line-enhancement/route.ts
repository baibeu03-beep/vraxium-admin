import type { NextRequest } from "next/server";
import { getCrewWeekLineSummary } from "@/lib/adminCrewWeekLineSummary";
import { projectCrewLineEnhancement } from "@/lib/crewLineEnhancementProjection";
import {
  assertPageAccessBySlug,
  readPageSlug,
  PageAccessError,
} from "@/lib/pageAccess";

// ─────────────────────────────────────────────────────────────────────
// GET /api/cluster4/weekly-line-enhancement?userId=&weekId=
//
// 고객앱(vraxium) "Detail Log > 라인 강화 내역" 탭 전용 **internal read-only** endpoint.
//   · 인증 = x-internal-api-key 전용(관리자 세션/롤 미사용). 고객앱 **서버 proxy** 만 호출한다
//     — 브라우저가 직접 호출하지 않으며 admin base URL/키가 클라이언트로 나가지 않는다.
//   · 데이터 = getCrewWeekLineSummary()(관리자 "라인 강화 내역" 탭과 **동일 함수**)를 그대로 호출.
//     별도 집계/판정을 만들지 않는다 → admin ↔ 크루 원천 정합이 구조적으로 보장된다.
//   · 응답 = projectCrewLineEnhancement() 로 크루용 DTO 로 투영(관리자 전용 편집 필드 제거).
//     관리자 API(/api/admin/members/[user_id]/weeks/[week_id]/lines)는 **무수정**이다.
//   · userId = user_profiles.user_id(UUID). getCrewWeekLineSummary 의 첫 인자는 이름이
//     legacyUserId 지만 실제 lookup 키는 user_profiles.user_id 다
//     (getAdminCrewDtoByLegacyUserId: "폴더명은 historical 이지만 실제 값은 UUID").
//     → weekly-cards internal 경로(profileUserId = ?userId)와 동일 식별자 체계.
//   · mode=test / actAsTestUserId / demoUserId 는 **호출부(고객앱 proxy)가 어떤 userId 를
//     넘길지**만 바꾼다. userId 확정 이후의 조회·판정·DTO 조립은 이 경로 하나뿐이다.
//
// 조회 전용 — 클럽/주차 공통 데이터를 어떤 경로로도 변경하지 않는다.
// ─────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function fail(status: number, message: string, code: string) {
  return Response.json({ success: false, data: null, error: { message, code } }, { status });
}

export async function GET(request: NextRequest) {
  // ── internal-key 인증(단일 축) ──
  const internalKey = request.headers.get("x-internal-api-key");
  const expectedInternalKey = process.env.INTERNAL_API_KEY;
  const internalAuthAccepted =
    !!internalKey && !!expectedInternalKey && internalKey === expectedInternalKey;

  if (!internalAuthAccepted) {
    // 키 누락/불일치는 동일 응답(존재 여부·키 형태를 흘리지 않는다).
    console.warn("[weekly-line-enhancement] internal auth rejected", {
      hasKey: !!internalKey,
      hasExpected: !!expectedInternalKey,
    });
    return fail(401, "Authentication required.", "unauthenticated");
  }

  const userId = request.nextUrl.searchParams.get("userId")?.trim() || null;
  const weekId = request.nextUrl.searchParams.get("weekId")?.trim() || null;
  if (!userId) return fail(400, "userId is required.", "missing_user_id");
  if (!weekId) return fail(400, "weekId is required.", "missing_week_id");

  const startedAt = Date.now();

  try {
    // 페이지 slug ↔ 실제 org 접근 게이트 — weekly-cards(internal 포함)와 동일 규칙 적용.
    //   org 가 다른 사용자의 라인 내역을 슬러그 교차로 읽는 것을 차단한다.
    await assertPageAccessBySlug({
      userId,
      pageType: "cluster4",
      requestedSlug: readPageSlug(request),
    });

    // 관리자 라인 강화 내역과 **같은 함수**. 재구현/재추정 없음.
    const result = await getCrewWeekLineSummary(userId, weekId);
    if (!result.ok) {
      const message =
        result.reason === "member_not_found"
          ? "Crew not found"
          : "Week not found for this crew";
      return fail(404, message, result.reason);
    }

    const data = projectCrewLineEnhancement({ userId, weekId, summary: result.data });

    console.log("[weekly-line-enhancement] ok", {
      userId,
      weekId,
      rows: data.rows.length,
      clubOpen: data.summary.clubOpenCount,
      crewOpen: data.summary.crewOpenCount,
      elapsedMs: Date.now() - startedAt,
    });

    return Response.json({ success: true, data, error: null });
  } catch (error) {
    if (error instanceof PageAccessError) {
      return fail(error.status, error.message, "page_access_denied");
    }
    console.error("[cluster4/weekly-line-enhancement GET]", error);
    return fail(
      500,
      error instanceof Error ? error.message : "Failed to load line enhancement summary.",
      "internal",
    );
  }
}

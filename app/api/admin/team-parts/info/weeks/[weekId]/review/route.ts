// 클럽 정보 > 주차 내역 > 활동 관리 — [검수 완료].
//   POST → 이 주차 결과를 최종 확정한다(액트 체크/라인 개설 검토 후 크루 결과 반영):
//     ① 공표(weeks.result_published_at) + ② 코호트 weekly-cards snapshot 재계산
//     + ③ 검수 완료(weeks.result_reviewed_at). weekly-card-finalization 과 동일 SoT·멱등.
//   주차 전역(org 무관) — 목록/상세의 "주차 검수" V 컬럼과 동일 신호(weeks 직접 읽기).

import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
  type AdminContext,
} from "@/lib/adminAuth";
import { resolveAdminOrgAccess } from "@/lib/adminOrgAccess";
import { isOrganizationSlug } from "@/lib/organizations";
import { isUuid } from "@/lib/isUuid";

// 통합 전용 게이트 — 개별(조직 컨텍스트=유효한 ?org)이거나 단일 조직 어드민(!isAllOrgs)이면 차단.
//   통합/개별 SoT = URL 의 유효한 org 유무(org-optional 정책). 통합 검수 요청은 ?org 없이(=?club) 오고,
//   개별 컨텍스트 요청은 ?org 를 달고 온다 → 통합만 통과. 현재 어드민 전원 owner 라 !isAllOrgs 는
//   실사용상 미발동(향후 단일 조직 계정 대비 보존).
async function assertIntegratedWriter(
  request: NextRequest,
  admin: AdminContext,
): Promise<Response | null> {
  const orgFocused = isOrganizationSlug(request.nextUrl.searchParams.get("org")?.trim() ?? "");
  const access = await resolveAdminOrgAccess(admin);
  if (orgFocused || !access.isAllOrgs) {
    return Response.json(
      { success: false, error: "주차 검수는 통합 관리자만 실행할 수 있습니다." },
      { status: 403 },
    );
  }
  return null;
}
import {
  markTeamPartsWeekReviewed,
  revertTeamPartsWeekReview,
  WeekDetailWriteError,
} from "@/lib/adminTeamPartsInfoWeekDetailData";
import { resolveStateScopeFromRequest } from "@/lib/operationalState";

// 검수 완료/실행 취소는 코호트 전원(수십~85명) 카드 snapshot 을 재계산하므로 최대 수십초가 걸린다
//   (실측 2026-07-09: 85명 concurrency 8 ≈ 75s). 플랫폼 함수 타임아웃을 명시 상향해 중도 절단을
//   막는다(프론트는 staged progress 로 진행 안내). dynamic: 인증/상태 변경이라 캐시 금지.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ weekId: string }> };

export async function POST(request: NextRequest, { params }: Ctx) {
  let admin: AdminContext;
  try {
    admin = await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }
  const denied = await assertIntegratedWriter(request, admin);
  if (denied) return denied;
  const actorId = admin.userId;

  const { weekId } = await params;
  if (!isUuid(weekId)) {
    return Response.json({ success: false, error: "weekId must be a UUID" }, { status: 400 });
  }

  // scope: ?mode=test → qa(테스트 코호트·qa_weeks_state). 기본 operating(실유저·운영 weeks).
  const scope = resolveStateScopeFromRequest(request);
  // allowIncompleteTestData: 안전장치(라인0 mass-fail·적립 미완료·pending) bypass 요청.
  //   ⚠ 실제 bypass 여부는 서버가 scope 로 최종 판정(operating 실유저면 무시). body 없으면 false.
  let allowIncompleteTestData = false;
  try {
    const body = (await request.json()) as { allowIncompleteTestData?: unknown } | null;
    allowIncompleteTestData = body?.allowIncompleteTestData === true;
  } catch {
    // body 없음(기존 호출 호환) → false.
  }

  try {
    const result = await markTeamPartsWeekReviewed(weekId, actorId, {
      scope,
      allowIncompleteTestData,
    });
    // DTO: { ok, weekId, reviewed, reviewedAt } (+ 확정 상세). success 래퍼는 프론트 호환 유지.
    return Response.json({
      success: true,
      ok: true,
      weekId: result.weekId,
      reviewed: result.reviewed,
      reviewedAt: result.reviewedAt,
      data: result,
    });
  } catch (error) {
    if (error instanceof WeekDetailWriteError) {
      return Response.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error("[admin/team-parts/info/weeks/[weekId]/review POST]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "검수 완료에 실패했습니다." },
      { status: 500 },
    );
  }
}

// DELETE — ↩ 실행 취소: 주차 검수(공표+검수) 실행 직전 상태로 복원.
//   result_published_at=NULL + result_reviewed_at=NULL + 코호트 재계산 → 카드 success/fail→tallying.
//   ?mode=test → scope=qa(qa_weeks_state·테스트 코호트·안전). 기본 operating. 강한 확인 모달은 UI 책임.
export async function DELETE(request: NextRequest, { params }: Ctx) {
  let admin: AdminContext;
  try {
    admin = await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }
  // 실행 취소도 통합 전용 — POST 와 동일 게이트(개별 컨텍스트/단일 조직 어드민 403).
  const denied = await assertIntegratedWriter(request, admin);
  if (denied) return denied;
  const actorId = admin.userId;

  const { weekId } = await params;
  if (!isUuid(weekId)) {
    return Response.json({ success: false, error: "weekId must be a UUID" }, { status: 400 });
  }
  const scope = resolveStateScopeFromRequest(request);

  try {
    const result = await revertTeamPartsWeekReview(weekId, scope, actorId);
    return Response.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof WeekDetailWriteError) {
      return Response.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error("[admin/team-parts/info/weeks/[weekId]/review DELETE]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "주차 검수 실행 취소에 실패했습니다." },
      { status: 500 },
    );
  }
}

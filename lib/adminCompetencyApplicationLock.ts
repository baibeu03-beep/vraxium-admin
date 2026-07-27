import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isOrganizationSlug, type OrganizationSlug } from "@/lib/organizations";
import { isCompetencyHubOpened } from "@/lib/adminCompetencyLineOpening";

/**
 * 실무 역량 [라인 개설] — "개설 완료 후 명단 잠금" 서버 게이트(단일 SoT).
 *
 * 규칙(실무 정보 info-lines / 실무 경험 part-input 과 동일):
 *   그 org·주차가 이미 개설 완료(isCompetencyHubOpened)면 신청 명단을 바꿀 수 없다.
 *   개설 완료 시점에 라인 타깃/강화 결과가 고객에게 반영되므로, 그 뒤 명단(수동 추가·카페/승인
 *   체크·반려 사유·수동 삭제)만 바뀌면 "보이는 개설 결과 ≠ 신청 원장"이 조용히 생긴다.
 *   수정 경로는 [개설 취소] 하나로 강제한다.
 *
 * 화면(CompetencyApplicantSection)이 이미 컨트롤을 비활성화하지만, 여기가 HTTP 직접 호출까지
 * 막는 최종 방어선이다. 개설 여부 판정은 대시보드 DTO(opening-status.opened)와 **같은 함수**를 쓴다.
 */
export const COMPETENCY_APPLICATIONS_LOCKED_CODE = "competency_hub_opened_locked";
export const COMPETENCY_APPLICATIONS_LOCKED_MESSAGE =
  "이미 개설 완료된 주차입니다. [개설 취소] 후 명단을 수정할 수 있습니다.";

export type LockedGuardResult = { locked: true; response: Response } | { locked: false };

function lockedResponse(): Response {
  return Response.json(
    {
      success: false,
      error: COMPETENCY_APPLICATIONS_LOCKED_MESSAGE,
      code: COMPETENCY_APPLICATIONS_LOCKED_CODE,
    },
    { status: 409 },
  );
}

/** (org, weekId) 스코프 게이트 — 수동 추가(POST)처럼 대상 주차를 이미 아는 경로용. */
export async function guardCompetencyWeekNotOpened(
  org: OrganizationSlug,
  weekId: string,
): Promise<LockedGuardResult> {
  return (await isCompetencyHubOpened(org, weekId))
    ? { locked: true, response: lockedResponse() }
    : { locked: false };
}

/**
 * 신청 1건(id) 스코프 게이트 — PATCH/DELETE 처럼 id 만 아는 경로용.
 *   그 행의 organization_slug/week_id 를 읽어 위 게이트로 위임한다. 행이 없으면 통과시키고
 *   (404/403 판정은 기존 update/delete 로직이 담당) 조회 실패도 통과시키지 않는다(fail-closed 아님 —
 *   존재하지 않는 행에 잠금 사유를 씌우면 오해를 부르므로 기존 오류 경로를 그대로 쓴다).
 */
export async function guardCompetencyApplicationNotOpened(
  applicationId: string,
): Promise<LockedGuardResult> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_competency_applications")
    .select("organization_slug,week_id")
    .eq("id", applicationId)
    .maybeSingle();
  if (error) throw Object.assign(new Error(error.message), { status: 500 });
  const row = data as { organization_slug: string | null; week_id: string | null } | null;
  if (!row?.organization_slug || !row.week_id) return { locked: false };
  if (!isOrganizationSlug(row.organization_slug)) return { locked: false };
  return guardCompetencyWeekNotOpened(row.organization_slug, row.week_id);
}

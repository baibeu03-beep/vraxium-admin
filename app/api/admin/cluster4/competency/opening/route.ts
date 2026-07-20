import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { isOrganizationSlug } from "@/lib/organizations";
import {
  cancelCompetencyHub,
  openCompetencyHub,
} from "@/lib/adminCompetencyLineOpening";
import { observeApiRoute } from "@/lib/apiObservability";
import {
  validateCompetencyOutput,
  COMPETENCY_OUTPUT_MESSAGE,
} from "@/lib/competencyOutputValidation";

// 실무 역량 [라인 개설] — 허브 전체 개설 완료/취소.
//   POST { action: 'open'|'cancel', organization, output_link_1?, output_description? }
//
//   open   = 대상 주차 + org + part_type=competency 라인 is_active=true
//            + (링크 입력 시) 주차 공통 아웃풋(output_link_1/output_links[0])을 모든 라인칸에 반영
//            + snapshot markStale
//   cancel = 동일 조건 라인 is_active=false + 아웃풋 원복(직전값 복원) + snapshot markStale
//
// 기존 라인 생성 흐름(competency-lines POST)·snapshot 생성/조회 로직 무변경.

export async function POST(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const action = b.action;
  const orgRaw = typeof b.organization === "string" ? b.organization.trim() : "";

  if (!isOrganizationSlug(orgRaw)) {
    return Response.json(
      { success: false, error: "organization 은 유효한 클럽이어야 합니다" },
      { status: 400 },
    );
  }
  if (action !== "open" && action !== "cancel") {
    return Response.json(
      { success: false, error: "action 은 open|cancel 이어야 합니다" },
      { status: 400 },
    );
  }

  const outputLink1 =
    typeof b.output_link_1 === "string" ? b.output_link_1 : null;
  const outputDescription =
    typeof b.output_description === "string" ? b.output_description : null;

  // 개설(open) 한정 필수 입력 검증 — 아웃풋 링크 1·설명 1 은 모두 필수(공백만=미입력).
  //   프론트 폼과 동일한 공용 검증 함수(validateCompetencyOutput)를 사용해 클라 우회 요청도
  //   4xx 로 거부한다. mode=test/operating·모든 org 동일. (cancel 은 원복이라 검증 없음.)
  if (action === "open") {
    const missing = validateCompetencyOutput(outputLink1, outputDescription);
    if (missing) {
      return Response.json(
        { success: false, error: COMPETENCY_OUTPUT_MESSAGE[missing] },
        { status: 400 },
      );
    }
  }
  // 대시보드에서 선택한 개설 주차(허용 예외 포함). 미지정=정규 개설 대상 주차.
  const weekId = typeof b.week_id === "string" && b.week_id.trim() ? b.week_id.trim() : null;
  // 운영/테스트 모드 — 개설 완료 시 신청/승인 명단 기반 라인 타깃 생성 가드로 전달.
  const mode = "operating";

  // 순수 계측(로그 전용, 응답 DTO 미변경): elapsed·supabase 쿼리수·operation·actorMode·영향 라인/크루.
  return observeApiRoute("[admin/cluster4/competency/opening POST]", async (obs) => {
    obs.operation = `competency.${action}`;
    obs.actorMode = mode;
    try {
      const data =
        action === "open"
          ? await openCompetencyHub({
              organization: orgRaw,
              outputLink1,
              description: outputDescription,
              adminId: admin.userId,
              mode,
              weekId,
            })
          : await cancelCompetencyHub({ organization: orgRaw, adminId: admin.userId, mode, weekId });
      obs.affectedLineCount = data.reflectedLines;
      obs.affectedUserCount = data.reflectedCrews;
      return Response.json({ success: true, data }, { status: 201 });
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      console.error("[admin/cluster4/competency/opening POST]", error);
      return Response.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "처리에 실패했습니다",
        },
        { status },
      );
    }
  });
}

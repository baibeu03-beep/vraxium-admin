// /api/admin/processes/check/irregular/targets — 변동 액트 대상 고객 검색(스코프 적용).
//
//   GET ?org=oranke&q=홍길동[&mode=test]  → 스코프(org + operating/test) 부합 user_profiles ≤20
//
// 운영/테스트 모드 분리는 target 후보(고객) 기준. 입력 폼의 대상자 선택 UI 가 호출.

import { NextRequest } from "next/server";
import { ADMIN_READ_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { isOrganizationSlug } from "@/lib/organizations";
import { parseScopeMode } from "@/lib/userScopeShared";
import { searchIrregularTargets } from "@/lib/adminProcessIrregularData";
import { publicErrorMessage } from "@/lib/apiError";

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const orgRaw = request.nextUrl.searchParams.get("org")?.trim() || null;
  if (!isOrganizationSlug(orgRaw)) {
    return Response.json(
      { success: false, error: "소속 클럽을 다시 선택해주세요." },
      { status: 400 },
    );
  }
  const mode = parseScopeMode(request.nextUrl.searchParams.get("mode"));
  const q = request.nextUrl.searchParams.get("q") ?? "";

  try {
    const users = await searchIrregularTargets(orgRaw, mode, q);
    return Response.json({ success: true, data: users });
  } catch (error) {
    console.error("[processes/check/irregular/targets GET]", error);
    return Response.json(
      { success: false, error: publicErrorMessage(error, 500, "변동 액트 처리를 완료하지 못했습니다.") },
      { status: 500 },
    );
  }
}

import { NextRequest } from "next/server";
import { findExistingMember } from "@/lib/memberLookup";

// POST /api/members/find
// body: { name: string, phone: string }
// → user_profiles 실시간 조회로 기존 회원 여부 판정(snapshot 미사용).
//   응답은 마스킹된 이메일만 노출하고 실제 이메일은 절대 반환하지 않는다.
//     { found: true, displayName, maskedEmail } | { found: false }
//
// 전화번호 PII 가 URL/로그에 남지 않도록 GET 쿼리 대신 POST 본문을 사용한다.
//
// demoUserId 경로: 이 엔드포인트는 "조회 대상 profile user" 가 없는 입력(name+phone)
// 기반 조회라 demoUserId 분기가 성립하지 않는다. 경로가 단일이므로 응답 DTO 도 단일하게
// 유지된다(데모/일반 DTO 동일).
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  if (!body || typeof body !== "object") {
    return Response.json(
      { success: false, error: "Request body must be a JSON object" },
      { status: 400 },
    );
  }

  const { name, phone } = body as { name?: unknown; phone?: unknown };
  if (
    typeof name !== "string" ||
    typeof phone !== "string" ||
    !name.trim() ||
    !phone.trim()
  ) {
    return Response.json(
      { success: false, error: "name and phone are required" },
      { status: 400 },
    );
  }

  try {
    const result = await findExistingMember(name, phone);
    return Response.json(result);
  } catch (error) {
    console.error("[members/find POST]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to find member",
      },
      { status: 500 },
    );
  }
}

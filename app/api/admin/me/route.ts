import { toAdminErrorResponse } from "@/lib/adminAuth";
import { getAdminMe } from "@/lib/adminMe";

// 로그인된 관리자 본인 정보(이름/이메일/권한) 조회.
//   debug-session 과 동일한 인증 경로(requireAdmin)에 displayName 만 추가한 공식 me 엔드포인트.
export async function GET() {
  try {
    const me = await getAdminMe();
    return Response.json({ success: true, data: me });
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

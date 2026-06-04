import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { collectCafeCommentNicknames } from "@/lib/naverCafeComments";

// 댓글 수집은 페이지네이션 순회로 수십 초가 걸릴 수 있다 (로컬 실행 전용).
export const maxDuration = 300;

/**
 * POST /api/admin/cluster4/cafe-comments
 * body: { url: string } — 네이버 카페 게시글 URL
 *
 * 댓글 작성자 닉네임 목록 수집 (Phase 1 — 포인트/패널티/회원매칭/snapshot 미관여, DB 쓰기 없음).
 * Playwright 로컬 실행 전용: Vercel 배포 환경에서는 크롤링을 시도하지 않고 안내만 반환한다.
 * 추후 별도 크롤링 워커로 확장 시 이 응답 계약을 그대로 유지한다.
 */
export async function POST(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  if (process.env.VERCEL) {
    return Response.json(
      {
        success: false,
        error: "not_supported_in_production",
        message:
          "카페 댓글 수집은 로컬 관리자 환경에서만 동작합니다. 로컬에서 admin을 실행한 뒤 다시 시도해주세요.",
      },
      { status: 501 },
    );
  }

  let url: string;
  try {
    const body = await request.json();
    url = typeof body?.url === "string" ? body.url : "";
  } catch {
    url = "";
  }
  if (!url.trim()) {
    return Response.json(
      { success: false, error: "invalid_url", message: "게시글 URL을 입력해주세요." },
      { status: 400 },
    );
  }

  try {
    const result = await collectCafeCommentNicknames(url);
    if (!result.ok) {
      const status = result.error === "invalid_url" ? 400 : 502;
      return Response.json(
        { success: false, error: result.error, message: result.message },
        { status },
      );
    }
    return Response.json({ success: true, data: result.data });
  } catch (error) {
    // 계정 정보 등 민감값은 메시지에 포함되지 않는다 (브라우저 기동/모듈 로드 계열 오류만 도달).
    return Response.json(
      {
        success: false,
        error: "crawl_failed",
        message: error instanceof Error ? error.message : "댓글 수집 중 오류가 발생했습니다.",
      },
      { status: 500 },
    );
  }
}

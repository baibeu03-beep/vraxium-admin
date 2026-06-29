import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  AdminHelpError,
  HELP_CONTENT_MAX,
  getHelpContent,
  isValidHelpPath,
  upsertHelpContent,
} from "@/lib/adminPageHelpData";

// 페이지별 "관련 도움말" 조회/저장.
//   GET  ?path=/admin/members        → { success, data: { pagePath, content } }
//   PUT  { path, content }           → upsert(쓰기 권한). 빈 content 저장 허용.

export async function GET(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const path = request.nextUrl.searchParams.get("path")?.trim() ?? "";
  if (!isValidHelpPath(path)) {
    return Response.json({ success: false, error: "Invalid path" }, { status: 400 });
  }

  // 편집/저장 권한 = 쓰기 역할(owner/admin). 클라이언트(AdminHelp)가 버튼 노출에 사용.
  const canEdit = ADMIN_WRITE_ROLES.includes(admin.role as (typeof ADMIN_WRITE_ROLES)[number]);

  try {
    const content = await getHelpContent(path);
    return Response.json({ success: true, data: { pagePath: path, content, canEdit } });
  } catch (error) {
    if (error instanceof AdminHelpError) {
      return Response.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error("[admin/help GET]", error);
    return Response.json({ success: false, error: "Failed to load help" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
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

  const path = typeof (body as { path?: unknown })?.path === "string"
    ? (body as { path: string }).path.trim()
    : "";
  const content = (body as { content?: unknown })?.content;

  if (!isValidHelpPath(path)) {
    return Response.json({ success: false, error: "Invalid path" }, { status: 400 });
  }
  // 빈 문자열은 허용하되, 문자열 타입 자체는 필수.
  if (typeof content !== "string") {
    return Response.json({ success: false, error: "content must be a string" }, { status: 400 });
  }
  if (content.length > HELP_CONTENT_MAX) {
    return Response.json(
      { success: false, error: `content too long (max ${HELP_CONTENT_MAX})` },
      { status: 400 },
    );
  }

  try {
    const saved = await upsertHelpContent(path, content);
    return Response.json({ success: true, data: { pagePath: path, content: saved } });
  } catch (error) {
    if (error instanceof AdminHelpError) {
      return Response.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error("[admin/help PUT]", error);
    return Response.json({ success: false, error: "Failed to save help" }, { status: 500 });
  }
}

import { supabaseAdmin } from "@/lib/supabaseAdmin";

// 어드민 페이지별 "관련 도움말" 본문 조회/저장(SoT = admin_page_help_contents).
//   · page_path 단위 단일 행. content 는 빈 문자열도 허용(빈 도움말 저장 가능).
//   · 접근은 API 라우트(requireAdmin) 뒤에서만 — 여기선 서비스 롤로 직접 읽고/upsert 한다.

export const HELP_PATH_MAX = 512;
export const HELP_CONTENT_MAX = 20000;

export class AdminHelpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AdminHelpError";
    this.status = status;
  }
}

// 경로 검증: 어드민 경로만 허용(쿼리스트링/개행 불가). 키 오염·과도한 길이 방지.
export function isValidHelpPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.startsWith("/admin") &&
    path.length <= HELP_PATH_MAX &&
    !path.includes("?") &&
    !path.includes("\n")
  );
}

// 테이블 미생성(마이그레이션 미적용) 시그널 — 읽기는 빈 도움말로 graceful 처리한다.
//   · Postgres: 42P01 / "relation ... does not exist"
//   · PostgREST(Supabase): PGRST205 / "Could not find the table ... in the schema cache"
function isUndefinedTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const msg = error.message ?? "";
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    /relation .* does not exist/i.test(msg) ||
    /could not find the table/i.test(msg) ||
    /schema cache/i.test(msg)
  );
}

export async function getHelpContent(pagePath: string): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("admin_page_help_contents")
    .select("content")
    .eq("page_path", pagePath)
    .maybeSingle();

  if (error) {
    // 마이그레이션 적용 전이라도 모달은 빈 내용으로 열리게 한다(저장 시점에 실제 에러 노출).
    if (isUndefinedTable(error)) return "";
    throw new AdminHelpError(500, error.message);
  }
  return (data?.content as string | undefined) ?? "";
}

export async function upsertHelpContent(
  pagePath: string,
  content: string,
): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("admin_page_help_contents")
    .upsert(
      { page_path: pagePath, content, updated_at: new Date().toISOString() },
      { onConflict: "page_path" },
    )
    .select("content")
    .single();

  if (error) {
    if (isUndefinedTable(error)) {
      throw new AdminHelpError(
        503,
        "도움말 테이블이 아직 생성되지 않았습니다. db/migrations/2026-06-29_admin_page_help_contents.sql 적용이 필요합니다.",
      );
    }
    throw new AdminHelpError(500, error.message);
  }
  return (data?.content as string | undefined) ?? "";
}

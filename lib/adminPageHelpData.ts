import { supabaseAdmin } from "@/lib/supabaseAdmin";

// 어드민 "관련 도움말" 본문 조회/저장(SoT = admin_page_help_contents).
//   · page_path(=식별 키) 단위 단일 행. content 는 빈 문자열도 허용(빈 도움말 저장 가능).
//   · 접근은 API 라우트(requireAdmin) 뒤에서만 — 여기선 서비스 롤로 직접 읽고/upsert 한다.
//   · 키는 두 형태를 허용한다(같은 테이블·같은 저장/조회 로직 공유):
//       1) 페이지 단위 경로   — "/admin/..."           (AdminHelp, usePathname)
//       2) 요소 단위 도움말 키 — "admin.foo.bar.column.x" (AdminHelpIconButton, helpKey)
//     org/mode/test 로 갈라지지 않는 공통 키다(키 문자열에 org/mode 를 넣지 않는다).

export const HELP_PATH_MAX = 512;
export const HELP_CONTENT_MAX = 20000;

// 요소 단위 도움말 키: 점(.) 구분 네임스페이스. "admin." 으로 시작.
//   · 슬래시 경로("/admin/...")와 문자셋이 겹치지 않아 충돌하지 않는다.
//   · 소문자/숫자/점만 허용해 키 오염을 막는다. 예: admin.teamParts.info.weeks.column.actCheckRate
const HELP_ELEMENT_KEY_RE = /^admin(\.[a-zA-Z0-9]+)+$/;

export class AdminHelpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AdminHelpError";
    this.status = status;
  }
}

// 키 검증: 페이지 경로("/admin/...") 또는 요소 도움말 키("admin.foo.bar")만 허용.
//   · 쿼리스트링/개행 불가, 과도한 길이 방지 — 키 오염 차단.
export function isValidHelpPath(path: unknown): path is string {
  if (typeof path !== "string") return false;
  if (path.length > HELP_PATH_MAX) return false;
  if (path.includes("?") || path.includes("\n")) return false;
  // 1) 페이지 단위 경로
  if (path.startsWith("/admin")) return true;
  // 2) 요소 단위 도움말 키
  return HELP_ELEMENT_KEY_RE.test(path);
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

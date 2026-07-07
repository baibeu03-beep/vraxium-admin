-- admin_page_help_contents — 어드민 페이지별 "관련 도움말" 본문(헤더 [도움말] 버튼 팝업).
--   · page_path 단위 단일 행(UNIQUE). 같은 경로로 다시 열면 저장한 내용이 다시 보인다.
--   · content 는 빈 문자열도 허용(빈 도움말 저장 가능) — NOT NULL DEFAULT ''.
--   · 서비스 롤(supabaseAdmin)로만 접근(API 라우트가 requireAdmin 게이트) → RLS 불필요.
--   · 개인 weekly-cards / snapshot / points 와 완전 무관한 표시용 메타 테이블.
CREATE TABLE IF NOT EXISTS public.admin_page_help_contents (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  page_path   text        NOT NULL UNIQUE,
  content     text        NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.admin_page_help_contents IS
  '어드민 페이지별 관련 도움말 본문. page_path 단위 단일 행, content 빈 문자열 허용.';
COMMENT ON COLUMN public.admin_page_help_contents.page_path IS
  '도움말 식별 키. (1) 페이지 경로 "/admin/..."(usePathname) 또는 (2) 요소 도움말 키 "admin.foo.bar.column.x". org/mode 무관 공통 키.';

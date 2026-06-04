-- 2026-06-04_auth_accounts_google.sql
-- Google OAuth provider 확장: provider 계정 SoT 테이블 신설 + applicants 에 provider 계정 키 추가.
--
-- 정책(고객 앱 lib/auth-account-access.ts 와 합의된 계약):
--  * Google 사용자 식별자 = id_token 의 sub (email 아님) → auth_accounts.provider_user_id
--  * 유저 매칭 키 = (provider, provider_user_id) 조합. 같은 email 이어도 자동 병합하지 않는다.
--  * kakao 흐름은 기존 email(auth_email/contact_email) 매칭을 그대로 유지 — 이 테이블을 쓰지 않는다.
--  * 승인 흐름: google 신규 로그인 → applicants(provider='google', provider_user_id=sub) pending
--    → admin approve-new 가 user/profile 생성 + auth_accounts.user_id 링크(실패 시 로그인 self-heal).

-- 1. provider 계정 SoT
CREATE TABLE IF NOT EXISTS public.auth_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_user_id text NOT NULL,            -- google: id_token sub
  email text,                                -- 표시/감사용 (매칭 키 아님)
  display_name text,
  picture_url text,
  user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,  -- 승인 전 NULL
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_accounts_provider_uid_unique UNIQUE (provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS auth_accounts_user_id_idx
  ON public.auth_accounts (user_id);

-- service role 전용 테이블 — anon/authenticated PostgREST 접근 차단 (정책 없는 RLS)
ALTER TABLE public.auth_accounts ENABLE ROW LEVEL SECURITY;

-- 2. applicants 에 provider 계정 키 (google 신청 row 식별용; kakao row 는 NULL 유지)
ALTER TABLE public.applicants
  ADD COLUMN IF NOT EXISTS provider_user_id text;

CREATE UNIQUE INDEX IF NOT EXISTS applicants_provider_uid_unique_idx
  ON public.applicants (provider, provider_user_id)
  WHERE provider_user_id IS NOT NULL;

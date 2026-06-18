-- 2026-06-15_process_check_worker.sql
-- 프로세스 체크 자동 검수(로컬 PC worker) — 정규/변동 공용. ADDITIVE — 기존 스키마 보존.
--
-- 배경:
--   scheduled_check_at(검수 시점)이 도래한 [체크 신청] 항목을 로컬 어드민 PC 의 worker 가
--   주기 폴링 → 카페 링크 댓글 크롤링(기존 로직 재사용) → 크루 식별(org+mode 스코프) →
--   결과 저장 + status=completed 로 자동 처리한다. (서버/Vercel 크롤링 불가 — 로컬 전용.)
--
--   대상:
--     · 정규  : process_check_statuses (status='pending' · scheduled_check_at<=now · review_link 존재)
--     · 변동: process_irregular_acts (kind='review_request' · status='pending' · scheduled_check_at<=now)
--
--   ⚠ user_weekly_points · 주차 성장 계산 · snapshot · checkGate · demoUserId 무접촉.
--     크루 식별 결과 + point_a/b/c 는 "관리용 기록"일 뿐 고객앱 점수 미연동(본 Phase).
-- Idempotent — 재실행 안전. Supabase SQL Editor 에서 수동 실행.

-- ── 1) 변동: review_request 는 대상자 미선택 → target nullable ────────────────
ALTER TABLE public.process_irregular_acts ALTER COLUMN target_user_id   DROP NOT NULL;
ALTER TABLE public.process_irregular_acts ALTER COLUMN target_user_name DROP NOT NULL;

-- 양 테이블 공용: 스코프 모드(크루 매칭 operating/test) + worker 재시도/로그 컬럼.
ALTER TABLE public.process_irregular_acts
  ADD COLUMN IF NOT EXISTS scope_mode      text NOT NULL DEFAULT 'operating'
    CHECK (scope_mode IN ('operating', 'test')),
  ADD COLUMN IF NOT EXISTS attempt_count   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS last_error      text NULL;

ALTER TABLE public.process_check_statuses
  ADD COLUMN IF NOT EXISTS scope_mode      text NOT NULL DEFAULT 'operating'
    CHECK (scope_mode IN ('operating', 'test')),
  ADD COLUMN IF NOT EXISTS attempt_count   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS last_error      text NULL;

-- ── 2) 크루 식별 결과 (정규/변동 공용) ───────────────────────────────────────
--   worker 가 크롤링 후 매칭된 크루(matched=우리 user_id) + 수동확인(review) 를 저장.
--   멱등: worker 재실행 시 (source, ref_id) 단위로 delete 후 재삽입.
CREATE TABLE IF NOT EXISTS public.process_check_review_recipients (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 출처: regular=process_check_statuses.id / irregular=process_irregular_acts.id
  source            text NOT NULL CHECK (source IN ('regular', 'irregular')),
  ref_id            uuid NOT NULL,

  organization_slug text NOT NULL,
  scope_mode        text NOT NULL DEFAULT 'operating'
    CHECK (scope_mode IN ('operating', 'test')),

  -- matched=우리 크루(user_id 존재) / review=수동확인(user_id NULL 가능).
  user_id           uuid NULL,
  nickname          text NOT NULL,
  match_type        text NOT NULL CHECK (match_type IN ('matched', 'review')),
  match_reason      text NULL,

  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pcrr_ref ON public.process_check_review_recipients (source, ref_id);
CREATE INDEX IF NOT EXISTS idx_pcrr_user ON public.process_check_review_recipients (user_id);

COMMENT ON TABLE public.process_check_review_recipients IS
  '프로세스 체크 자동 검수 크루 식별 결과(정규/변동 공용). worker 크롤링 매칭 산출 — 관리용 기록(user_weekly_points/snapshot 무접촉, 2026-06-15 worker Phase). 멱등=(source,ref_id) delete 후 재삽입.';
COMMENT ON COLUMN public.process_irregular_acts.scope_mode IS
  'worker 크루 매칭 스코프(operating/test). 행 생성 시 보드 조회 모드를 그대로 기록.';

GRANT SELECT ON public.process_check_review_recipients TO anon, authenticated;

-- PostgREST 스키마 캐시 즉시 리로드.
NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════
-- 검증 (참고용)
-- ═══════════════════════════════════════════════════════════════════════
/*
SELECT source, match_type, count(*) FROM public.process_check_review_recipients GROUP BY 1,2 ORDER BY 1,2;
SELECT column_name FROM information_schema.columns
 WHERE table_name='process_irregular_acts' AND column_name IN ('scope_mode','attempt_count','last_error');
*/

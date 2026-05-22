-- 2026-05-21_cluster4_card_blocker_step2_create_weekly_colleagues.sql
-- Cluster4-card 연계 동료(weekly_colleagues) canonical 테이블 생성.
--
-- 배경:
--   `app/(host)/api/weekly-colleagues/route.ts` 와 Front `Cluster4CardContent.tsx`
--   가 `weekly_colleagues` 테이블에 의존하고 있었으나, 두 repo 어디에도 schema/
--   migration 파일이 없어 운영 DB 에 적용된 적이 없었다(운영 DB 점검 결과 미존재 확인).
--   본 migration 으로 canonical 테이블을 도입한다.
--
-- 정합성:
--   - GET `/api/weekly-colleagues?userId=&weekCardId=` (route.ts:13-164)
--   - POST `/api/weekly-colleagues` (route.ts:167-232) — (user_id, week_card_id)
--     범위에서 delete + insert 로 full-replace 패턴.
--   - Front UI 는 3 슬롯 노출 (rank 1..3, 동시 작성).
--
-- 비범위:
--   - delete + insert 의 트랜잭션화/RPC 묶음 — Phase 후반에 별도 보강
--   - admin 대필 라우트 — 별도 PR
--   - RLS 정책 — 본 migration 그룹의 컨벤션에 따라 별도 정책 미부여

BEGIN;

-- ============================================================
-- weekly_colleagues: 본인이 한 주차에 함께한 동료를 최대 3 명 지정
--   - (user_id, week_card_id, colleague_id) UNIQUE — 같은 동료 중복 등록 금지
--   - rank: 1..3 (UI 3 슬롯)
--   - message: 함께한 한 줄 코멘트 (nullable, 0..200 자)
--   - 자기 자신을 동료로 등록 금지
-- ============================================================
CREATE TABLE IF NOT EXISTS public.weekly_colleagues (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id       uuid         NOT NULL
                             REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,

  week_card_id  uuid         NOT NULL
                             REFERENCES public.weeks(id) ON DELETE RESTRICT,

  colleague_id  uuid         NOT NULL
                             REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,

  rank          smallint     NOT NULL,
  message       text         NULL,

  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT weekly_colleagues_rank_range
    CHECK (rank BETWEEN 1 AND 3),
  CONSTRAINT weekly_colleagues_message_length
    CHECK (message IS NULL OR char_length(message) <= 200),
  CONSTRAINT weekly_colleagues_no_self
    CHECK (user_id <> colleague_id),
  CONSTRAINT weekly_colleagues_unique_user_week_colleague
    UNIQUE (user_id, week_card_id, colleague_id)
);

CREATE INDEX IF NOT EXISTS weekly_colleagues_user_week_idx
  ON public.weekly_colleagues (user_id, week_card_id);

CREATE INDEX IF NOT EXISTS weekly_colleagues_colleague_idx
  ON public.weekly_colleagues (colleague_id);

-- ============================================================
-- updated_at touch trigger
-- ============================================================
CREATE OR REPLACE FUNCTION public.touch_weekly_colleagues_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS weekly_colleagues_set_updated_at
  ON public.weekly_colleagues;

CREATE TRIGGER weekly_colleagues_set_updated_at
BEFORE UPDATE ON public.weekly_colleagues
FOR EACH ROW
EXECUTE FUNCTION public.touch_weekly_colleagues_updated_at();

COMMIT;

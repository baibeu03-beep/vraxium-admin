-- 2026-06-02_user_profiles_profile_tagline.sql
-- user_profiles.profile_tagline 컬럼 추가 (append-only, 데이터 변경 없음).
--   - 용도: 위클리 평판 카드 / 연계 동료 카드의 프로필 영역에 표시하는 한줄 소개.
--     사용자의 희망 기업 / 희망 직무 / 진로 목표 성격의 값.
--     (예: "삼성전자 DX", "네이버 AI 엔지니어", "게임 기획자", "브랜드 마케터", "창업 준비중")
--   - 평판 keyword(평가 태그)와 역할이 겹치지 않는 진로/소개 축이다.
--   - nullable, 기본값 없음. 기존 데이터는 전부 NULL 로 남는다(프론트는 NULL → "-" fallback).
--   - 입력 UI 는 본 단계 범위 외 — 컬럼/DTO 만 먼저 추가한다.
-- 멱등: ADD COLUMN IF NOT EXISTS — 이미 있으면 no-op.
--
-- 적용: Supabase SQL Editor 에서 본 파일 전체 실행.

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS profile_tagline text NULL;

COMMENT ON COLUMN public.user_profiles.profile_tagline IS
  '한줄 소개(희망 기업/직무/진로 목표). 평판/연계동료 카드 프로필 영역 노출. NULL 허용. 평판 keyword(평가 태그)와 다른 축.';

-- ── 적용 후 검증 ─────────────────────────────────────────────────────
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'user_profiles'
--    AND column_name = 'profile_tagline';

-- ── 롤백 SQL ─────────────────────────────────────────────────────────
-- ALTER TABLE public.user_profiles DROP COLUMN IF EXISTS profile_tagline;

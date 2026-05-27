-- 2026-05-26_cluster4_line_opening_step1_tables.sql
-- Cluster4 "라인 개설" 공통 시스템 canonical 테이블 3종 + updated_at trigger + validation trigger 초안.
--
-- 목적:
--   - 4개 파트(info / experience / competency / career)를 하나의 공통 라인 개설 도메인으로 관리한다.
--   - 운영자 1차 입력(cluster4_lines)과 대상 매핑(cluster4_line_targets), 사용자 2차 제출(cluster4_line_submissions)을 분리한다.
--   - 상태값(void / pending / success / fail)은 저장하지 않고 조회 시 계산한다.
--
-- 범위:
--   - 기존 public.career_projects 및 related 테이블은 변경하지 않는다.
--   - 관리자/사용자 API 구현 전, DB canonical schema 를 먼저 고정한다.
--
-- 의존:
--   - public.weeks(id)
--   - public.user_profiles(user_id)
--   - public.admin_users(id)
--
-- 정책:
--   - user target 은 DB trigger 로 "submission.user_id = target_user_id" 를 강제한다.
--   - rule target 매칭, 제출 기간 검증, auth user 검증은 API/service layer 책임이다.

BEGIN;

CREATE TABLE IF NOT EXISTS public.cluster4_lines (
  id                    uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  part_type             text         NOT NULL,
  main_title            text         NOT NULL,
  output_link_1         text         NULL,
  submission_opens_at   timestamptz  NOT NULL,
  submission_closes_at  timestamptz  NOT NULL,
  is_active             boolean      NOT NULL DEFAULT true,
  created_by            uuid         NULL REFERENCES public.admin_users(id) ON DELETE SET NULL,
  updated_by            uuid         NULL REFERENCES public.admin_users(id) ON DELETE SET NULL,
  created_at            timestamptz  NOT NULL DEFAULT now(),
  updated_at            timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT cluster4_lines_part_type_check
    CHECK (part_type IN ('info', 'experience', 'competency', 'career')),
  CONSTRAINT cluster4_lines_main_title_not_blank_check
    CHECK (btrim(main_title) <> ''),
  CONSTRAINT cluster4_lines_submission_window_check
    CHECK (submission_opens_at <= submission_closes_at)
);

CREATE TABLE IF NOT EXISTS public.cluster4_line_targets (
  id                    uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  line_id               uuid         NOT NULL REFERENCES public.cluster4_lines(id) ON DELETE CASCADE,
  week_id               uuid         NOT NULL REFERENCES public.weeks(id) ON DELETE CASCADE,
  target_mode           text         NOT NULL,
  target_user_id        uuid         NULL REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  target_rule           jsonb        NOT NULL DEFAULT '{}'::jsonb,
  created_by            uuid         NULL REFERENCES public.admin_users(id) ON DELETE SET NULL,
  updated_by            uuid         NULL REFERENCES public.admin_users(id) ON DELETE SET NULL,
  created_at            timestamptz  NOT NULL DEFAULT now(),
  updated_at            timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT cluster4_line_targets_target_mode_check
    CHECK (target_mode IN ('user', 'rule')),
  CONSTRAINT cluster4_line_targets_target_shape_check
    CHECK (
      (target_mode = 'user' AND target_user_id IS NOT NULL AND target_rule = '{}'::jsonb)
      OR
      (target_mode = 'rule' AND target_user_id IS NULL AND jsonb_typeof(target_rule) = 'object')
    )
);

CREATE TABLE IF NOT EXISTS public.cluster4_line_submissions (
  id                    uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  line_target_id        uuid         NOT NULL REFERENCES public.cluster4_line_targets(id) ON DELETE CASCADE,
  user_id               uuid         NOT NULL REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  subtitle              text         NULL,
  output_link_2         text         NULL,
  output_link_3         text         NULL,
  output_link_4         text         NULL,
  output_link_5         text         NULL,
  submitted_at          timestamptz  NOT NULL DEFAULT now(),
  created_at            timestamptz  NOT NULL DEFAULT now(),
  updated_at            timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT cluster4_line_submissions_subtitle_not_blank_check
    CHECK (subtitle IS NULL OR btrim(subtitle) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS cluster4_line_targets_user_unique_idx
  ON public.cluster4_line_targets (line_id, week_id, target_user_id)
  WHERE target_mode = 'user';

CREATE UNIQUE INDEX IF NOT EXISTS cluster4_line_targets_rule_unique_idx
  ON public.cluster4_line_targets (line_id, week_id, md5(target_rule::text))
  WHERE target_mode = 'rule';

CREATE UNIQUE INDEX IF NOT EXISTS cluster4_line_submissions_target_user_unique_idx
  ON public.cluster4_line_submissions (line_target_id, user_id);

CREATE INDEX IF NOT EXISTS cluster4_lines_part_type_active_window_idx
  ON public.cluster4_lines (part_type, is_active, submission_opens_at, submission_closes_at);

CREATE INDEX IF NOT EXISTS cluster4_lines_created_at_desc_idx
  ON public.cluster4_lines (created_at DESC);

CREATE INDEX IF NOT EXISTS cluster4_line_targets_week_mode_idx
  ON public.cluster4_line_targets (week_id, target_mode);

CREATE INDEX IF NOT EXISTS cluster4_line_targets_user_lookup_idx
  ON public.cluster4_line_targets (target_user_id, week_id)
  WHERE target_mode = 'user';

CREATE INDEX IF NOT EXISTS cluster4_line_submissions_user_lookup_idx
  ON public.cluster4_line_submissions (user_id, updated_at DESC);

CREATE OR REPLACE FUNCTION public.touch_cluster4_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cluster4_lines_set_updated_at
ON public.cluster4_lines;

CREATE TRIGGER cluster4_lines_set_updated_at
BEFORE UPDATE ON public.cluster4_lines
FOR EACH ROW
EXECUTE FUNCTION public.touch_cluster4_updated_at();

DROP TRIGGER IF EXISTS cluster4_line_targets_set_updated_at
ON public.cluster4_line_targets;

CREATE TRIGGER cluster4_line_targets_set_updated_at
BEFORE UPDATE ON public.cluster4_line_targets
FOR EACH ROW
EXECUTE FUNCTION public.touch_cluster4_updated_at();

DROP TRIGGER IF EXISTS cluster4_line_submissions_set_updated_at
ON public.cluster4_line_submissions;

CREATE TRIGGER cluster4_line_submissions_set_updated_at
BEFORE UPDATE ON public.cluster4_line_submissions
FOR EACH ROW
EXECUTE FUNCTION public.touch_cluster4_updated_at();

CREATE OR REPLACE FUNCTION public.validate_cluster4_line_submission()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_target_mode text;
  v_target_user_id uuid;
BEGIN
  SELECT target_mode, target_user_id
    INTO v_target_mode, v_target_user_id
  FROM public.cluster4_line_targets
  WHERE id = NEW.line_target_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'cluster4_line_target not found: %', NEW.line_target_id
      USING ERRCODE = '23503';
  END IF;

  IF v_target_mode = 'user' AND NEW.user_id <> v_target_user_id THEN
    RAISE EXCEPTION 'submission user_id must match target_user_id for user-mode target'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cluster4_line_submissions_validate_target
ON public.cluster4_line_submissions;

CREATE TRIGGER cluster4_line_submissions_validate_target
BEFORE INSERT OR UPDATE ON public.cluster4_line_submissions
FOR EACH ROW
EXECUTE FUNCTION public.validate_cluster4_line_submission();

COMMIT;

/*
BEGIN;
DROP TRIGGER IF EXISTS cluster4_line_submissions_validate_target ON public.cluster4_line_submissions;
DROP FUNCTION IF EXISTS public.validate_cluster4_line_submission();
DROP TRIGGER IF EXISTS cluster4_line_submissions_set_updated_at ON public.cluster4_line_submissions;
DROP TRIGGER IF EXISTS cluster4_line_targets_set_updated_at ON public.cluster4_line_targets;
DROP TRIGGER IF EXISTS cluster4_lines_set_updated_at ON public.cluster4_lines;
DROP FUNCTION IF EXISTS public.touch_cluster4_updated_at();
DROP INDEX IF EXISTS public.cluster4_line_submissions_user_lookup_idx;
DROP INDEX IF EXISTS public.cluster4_line_submissions_target_user_unique_idx;
DROP INDEX IF EXISTS public.cluster4_line_targets_user_lookup_idx;
DROP INDEX IF EXISTS public.cluster4_line_targets_week_mode_idx;
DROP INDEX IF EXISTS public.cluster4_line_targets_rule_unique_idx;
DROP INDEX IF EXISTS public.cluster4_line_targets_user_unique_idx;
DROP INDEX IF EXISTS public.cluster4_lines_created_at_desc_idx;
DROP INDEX IF EXISTS public.cluster4_lines_part_type_active_window_idx;
DROP TABLE IF EXISTS public.cluster4_line_submissions;
DROP TABLE IF EXISTS public.cluster4_line_targets;
DROP TABLE IF EXISTS public.cluster4_lines;
COMMIT;
*/

-- 2026-05-28_experience_drafts.sql
-- Cluster4 실무 경험 워크플로우 — draft 테이블.
--
-- 3단계 워크플로우(파트장 입력 → 에이전트 검수 → 팀장 개설)의 중간 상태를 저장.
-- 최종 개설 시에만 cluster4_lines + cluster4_line_targets 를 생성하며,
-- 이 테이블은 "개설 전 초안" 용도로만 사용.
--
-- 의존:
--   - public.weeks(id)
--   - public.cluster4_teams(id)
--   - public.user_profiles(user_id)
--   - public.cluster4_experience_line_masters(id)
--   - public.admin_users(id)
--   - public.cluster4_lines(id)
--   - public.touch_cluster4_updated_at() — 기존 trigger 함수
--
-- 재실행 안전: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS,
--   DROP TRIGGER IF EXISTS 패턴.

BEGIN;


-- ═══════════════════════════════════════════════════════════════════════
-- cluster4_experience_line_drafts
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.cluster4_experience_line_drafts (
  id                          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 기본 참조
  week_id                     uuid         NOT NULL
                              REFERENCES public.weeks(id) ON DELETE RESTRICT,
  organization_slug           text         NOT NULL DEFAULT 'oranke',
  team_id                     uuid         NULL
                              REFERENCES public.cluster4_teams(id) ON DELETE SET NULL,
  part_name                   text         NULL,
  target_user_id              uuid         NOT NULL
                              REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  experience_line_master_id   uuid         NOT NULL
                              REFERENCES public.cluster4_experience_line_masters(id) ON DELETE RESTRICT,

  -- 라인 정보 (마스터에서 복사 + 오버라이드 가능)
  line_code                   text         NOT NULL,
  main_title                  text         NOT NULL,
  output_link_1               text         NULL,
  output_link_2               text         NULL,
  output_images               jsonb        NOT NULL DEFAULT '[]'::jsonb,
  rating                      smallint     NULL
                              CHECK (rating >= 0 AND rating <= 10),
  memo                        text         NULL,

  -- 워크플로우 상태
  input_status                text         NOT NULL DEFAULT 'draft'
                              CHECK (input_status IN ('draft', 'submitted')),
  review_status               text         NOT NULL DEFAULT 'pending'
                              CHECK (review_status IN ('pending', 'approved', 'rejected')),
  open_status                 text         NOT NULL DEFAULT 'pending'
                              CHECK (open_status IN ('pending', 'opened')),
  rejection_reason            text         NULL,

  -- 행위자 / 시간 추적
  entered_by                  uuid         NULL
                              REFERENCES public.admin_users(id) ON DELETE SET NULL,
  entered_at                  timestamptz  NULL,
  reviewed_by                 uuid         NULL
                              REFERENCES public.admin_users(id) ON DELETE SET NULL,
  reviewed_at                 timestamptz  NULL,
  opened_by                   uuid         NULL
                              REFERENCES public.admin_users(id) ON DELETE SET NULL,
  opened_at                   timestamptz  NULL,

  -- 개설 결과 연결
  opened_line_id              uuid         NULL
                              REFERENCES public.cluster4_lines(id) ON DELETE SET NULL,

  -- 시스템
  created_at                  timestamptz  NOT NULL DEFAULT now(),
  updated_at                  timestamptz  NOT NULL DEFAULT now(),

  -- 동일 주차 + 사용자 + 라인 중복 방지
  CONSTRAINT cluster4_experience_line_drafts_week_user_master_unique
    UNIQUE (week_id, target_user_id, experience_line_master_id)
);


-- ── 인덱스 ──────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS cluster4_exp_drafts_week_id_idx
  ON public.cluster4_experience_line_drafts (week_id);

CREATE INDEX IF NOT EXISTS cluster4_exp_drafts_org_week_idx
  ON public.cluster4_experience_line_drafts (organization_slug, week_id);

CREATE INDEX IF NOT EXISTS cluster4_exp_drafts_target_user_week_idx
  ON public.cluster4_experience_line_drafts (target_user_id, week_id);

CREATE INDEX IF NOT EXISTS cluster4_exp_drafts_status_idx
  ON public.cluster4_experience_line_drafts (input_status, review_status, open_status);

CREATE INDEX IF NOT EXISTS cluster4_exp_drafts_master_week_idx
  ON public.cluster4_experience_line_drafts (experience_line_master_id, week_id);


-- ── updated_at 트리거 ───────────────────────────────────────────────

DROP TRIGGER IF EXISTS cluster4_experience_line_drafts_set_updated_at
  ON public.cluster4_experience_line_drafts;

CREATE TRIGGER cluster4_experience_line_drafts_set_updated_at
BEFORE UPDATE ON public.cluster4_experience_line_drafts
FOR EACH ROW
EXECUTE FUNCTION public.touch_cluster4_updated_at();


-- ── RLS / 권한 ──────────────────────────────────────────────────────

GRANT SELECT ON public.cluster4_experience_line_drafts TO anon, authenticated;


-- ── 코멘트 ──────────────────────────────────────────────────────────

COMMENT ON TABLE public.cluster4_experience_line_drafts
  IS '실무 경험 라인 개설 초안. 파트장 입력 → 에이전트 검수 → 팀장 최종 개설 워크플로우.';

COMMENT ON COLUMN public.cluster4_experience_line_drafts.input_status
  IS '입력 상태: draft(임시저장) / submitted(제출완료)';

COMMENT ON COLUMN public.cluster4_experience_line_drafts.review_status
  IS '검수 상태: pending(미검수) / approved(승인) / rejected(반려)';

COMMENT ON COLUMN public.cluster4_experience_line_drafts.open_status
  IS '개설 상태: pending(미개설) / opened(개설완료)';

COMMENT ON COLUMN public.cluster4_experience_line_drafts.opened_line_id
  IS '최종 개설 시 생성된 cluster4_lines.id 참조';

COMMENT ON COLUMN public.cluster4_experience_line_drafts.rating
  IS '파트장 입력 초안 평점 0~10. 최종 개설 시 cluster4_experience_line_evaluations 로 복사하여 확정.';

COMMENT ON COLUMN public.cluster4_experience_line_drafts.output_images
  IS 'JSON array of image URLs. 예: ["https://...png", "https://...jpg"]';


COMMIT;


-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK (필요 시)
-- ═══════════════════════════════════════════════════════════════════════
/*
BEGIN;

DROP TRIGGER IF EXISTS cluster4_experience_line_drafts_set_updated_at
  ON public.cluster4_experience_line_drafts;
DROP TABLE IF EXISTS public.cluster4_experience_line_drafts;

COMMIT;
*/

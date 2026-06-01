-- 2026-06-01_cluster4_lines_role_workflow.sql
-- 실무 경력(career) 라인 개설 운영 정책 반영: 역할별 진행 상태 + 담당자 기록.
--
-- 목적:
--   - 라인 개설을 파트장(입력) → 에이전트(검수) → 팀장(개설) 3단계 운영 흐름으로 "가시화/기록"한다.
--   - 담당자 기록: 입력자 = 기존 created_by(admin_users), 검수자 = reviewed_by, 개설자 = opened_by.
--
-- 정책(중요):
--   - 시간 제한/순서 강제/권한 차단 로직을 DB 레벨에 추가하지 않는다(전부 nullable, CHECK/트리거 없음).
--   - 자기 검수 허용(입력자 = 검수자 동일 가능) — 별도 제약 없음.
--   - 상태값(workflowStatus)은 저장하지 않고 timestamp 조합으로 조회 시 계산한다(기존 패턴 유지).
--
-- 범위:
--   - public.cluster4_lines 에 컬럼만 추가(append-only). 기존 컬럼/데이터/인덱스/트리거 무변경.
--   - created_by / updated_by 컬럼은 이미 존재 → 추가하지 않는다.
--   - 기존 cluster4_lines_set_updated_at 트리거가 updated_at 을 계속 자동 갱신한다.

BEGIN;

ALTER TABLE public.cluster4_lines
  ADD COLUMN IF NOT EXISTS input_completed_at timestamptz NULL,           -- 파트장 입력 완료 표시 시각
  ADD COLUMN IF NOT EXISTS reviewed_at        timestamptz NULL,           -- 에이전트 검수 완료 시각
  ADD COLUMN IF NOT EXISTS reviewed_by        uuid NULL
    REFERENCES public.admin_users(id) ON DELETE SET NULL,                 -- 검수자
  ADD COLUMN IF NOT EXISTS opened_at          timestamptz NULL,           -- 팀장 최종 개설 시각
  ADD COLUMN IF NOT EXISTS opened_by          uuid NULL
    REFERENCES public.admin_users(id) ON DELETE SET NULL;                 -- 개설자

COMMENT ON COLUMN public.cluster4_lines.input_completed_at IS '파트장 입력 완료 표시 시각(없으면 입력 중). created_by = 최초 입력자.';
COMMENT ON COLUMN public.cluster4_lines.reviewed_at IS '에이전트 검수 완료 시각(없으면 미검수).';
COMMENT ON COLUMN public.cluster4_lines.reviewed_by IS '검수 완료 처리한 어드민(admin_users).';
COMMENT ON COLUMN public.cluster4_lines.opened_at IS '팀장 최종 개설 처리 시각(기록용 — is_active 가시성과 별개).';
COMMENT ON COLUMN public.cluster4_lines.opened_by IS '최종 개설 처리한 어드민(admin_users).';

COMMIT;

/*
-- rollback
BEGIN;
ALTER TABLE public.cluster4_lines
  DROP COLUMN IF EXISTS opened_by,
  DROP COLUMN IF EXISTS opened_at,
  DROP COLUMN IF EXISTS reviewed_by,
  DROP COLUMN IF EXISTS reviewed_at,
  DROP COLUMN IF EXISTS input_completed_at;
COMMIT;
*/

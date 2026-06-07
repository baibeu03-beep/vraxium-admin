-- 2026-06-07_user_growth_status_audit.sql
-- growth_status 수동 오버라이드 감사 테이블 (append-only).
--
-- 배경: growth_status 표시가 자동 계산(autoGrowthStatus)으로 전환되고,
--   user_profiles.growth_status 는 수동 오버라이드 3종(graduated/suspended/paused)
--   저장 컬럼으로 재해석됨. 오버라이드 변경 시 사유/변경자/변경일을 본 테이블에 기록.
--   (user_role_audit 와 동일 패턴 — best-effort insert, 실패해도 저장은 성공 처리)
--
-- 쓰기 경로: lib/adminMembersData.ts updateMember (growth_status 변경 시).
-- 읽기 경로: lib/cluster3GrowthData.ts fetchOverrideAuditMeta (최신 1건 → 관리자 표시).
--   테이블 미생성 상태에서도 코드가 깨지지 않도록 양쪽 모두 best-effort 처리됨.
--
-- 의존성: 없음 (gen_random_uuid 는 Supabase 환경 기본 활성).
-- 멱등성: IF NOT EXISTS 패턴.
-- 적용: Supabase SQL Editor 에서 본 파일 전체 실행.

CREATE TABLE IF NOT EXISTS public.user_growth_status_audit (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL
    REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  -- old/new 둘 다 nullable: 최초 오버라이드 부여(NULL → 'paused') 및
  -- 오버라이드 해제('paused' → NULL) 모두 기록 가능.
  old_status  text NULL,
  new_status  text NULL,
  reason      text NULL,
  changed_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_growth_status_audit_user_id_idx
  ON public.user_growth_status_audit (user_id);

CREATE INDEX IF NOT EXISTS user_growth_status_audit_created_at_idx
  ON public.user_growth_status_audit (created_at DESC);

-- ─────────────────────────────────────────────────────────────────────
-- 검증 쿼리 (마이그레이션 직후 SQL Editor 에서 한 번 실행해 확인)
-- ─────────────────────────────────────────────────────────────────────
-- SELECT count(*) FROM public.user_growth_status_audit;
-- 기대: 0
--
-- 롤백:
-- DROP TABLE IF EXISTS public.user_growth_status_audit;

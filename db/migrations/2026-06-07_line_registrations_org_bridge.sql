-- 2026-06-07_line_registrations_org_bridge.sql
-- Phase 2C 선행: 라인 등록 레지스트리에 소속 조직 + 브리지 추적 컬럼 append.
--
-- 결정 (2026-06-07 사용자 확정):
--   - organization_slug: encre/oranke/phalanx/common 허용, NULL=미지정.
--     미지정 행은 개설 브리지 불가 (API 레이어 게이트 — 등록 폼 기본값 '-').
--   - 중복 방지: UNIQUE (hub, organization_slug, line_code) — org 지정 행만(partial).
--     허브 마스터의 UNIQUE(organization_slug, line_code) 와 정합.
--   - bridged_master_id/bridged_at: find-or-create 된 마스터(career 는 career_projects) 추적.
--     rollback(브리지 생성 마스터 전수 식별)과 중복 브리지 방지용.
--   - 검증 더미 13건은 본 마이그레이션 전에 스크립트로 정리 완료(백업 보존) — 기존 행 0건.
--
-- 기존 마스터/cluster4_lines/snapshot 테이블은 일절 변경하지 않는다 (registrations 전용 append).
-- Idempotent. Supabase SQL Editor 에서 수동 실행.

-- 1) 소속 조직 (NULL = 미지정 → 브리지 불가)
ALTER TABLE public.line_registrations
  ADD COLUMN IF NOT EXISTS organization_slug text NULL;

DO $$ BEGIN
  ALTER TABLE public.line_registrations
    ADD CONSTRAINT line_registrations_org_chk
    CHECK (organization_slug IS NULL
           OR organization_slug IN ('encre', 'oranke', 'phalanx', 'common'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2) 중복 방지 — hub + org + line_code 복합 unique (org 지정 행만)
CREATE UNIQUE INDEX IF NOT EXISTS uq_line_registrations_hub_org_code
  ON public.line_registrations (hub, organization_slug, line_code)
  WHERE organization_slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_line_registrations_org
  ON public.line_registrations (organization_slug);

-- 3) 브리지 추적
ALTER TABLE public.line_registrations
  ADD COLUMN IF NOT EXISTS bridged_master_id uuid NULL,
  ADD COLUMN IF NOT EXISTS bridged_at timestamptz NULL;

COMMENT ON COLUMN public.line_registrations.organization_slug IS
  '소속 조직 (encre/oranke/phalanx/common). NULL=미지정 — 개설 브리지 불가(API 게이트). 허브 마스터 UNIQUE(org, line_code) 정합용.';
COMMENT ON COLUMN public.line_registrations.bridged_master_id IS
  '브리지로 find-or-create 된 허브 마스터(career 는 career_projects) id. NULL=미브리지. rollback 전수 식별용.';
COMMENT ON COLUMN public.line_registrations.bridged_at IS
  '브리지 수행 시각. bridged_master_id 와 함께 기록.';

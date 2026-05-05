-- 2026-05-05_organization_aware_crew.sql
-- 목적:
--   1) legacy_crew_import × user_profiles JOIN으로 organization_slug를 view에 노출
--   2) crew_list_view (User App 읽기용) 에 organization_slug + club(=organization_slug) 추가
--   3) admin_crew_list_view (Admin 서버 읽기용) 추가
--   4) set_crew_organization() 함수로 user_profiles.organization_slug 갱신
--
-- 주의:
--   - legacy_crew_import 에는 organization 컬럼을 만들지 않는다(요구사항).
--   - User App /crews 코드는 수정하지 않는다(요구사항).
--   - 매칭 키(아래 ⚠ 표시)는 운영 DB 구조에 맞게 1줄만 조정하면 된다.

-- ─────────────────────────────────────────────────────────────────────
-- STEP 0: 매칭 키 탐색 probe (실행하고 결과 확인 후 STEP 1~3 진행)
-- ─────────────────────────────────────────────────────────────────────
-- 아래 3개 쿼리를 Supabase SQL Editor에서 먼저 실행해 어느 컬럼이 매칭되는지 확인한다.
--
-- (a) user_profiles 후보 컬럼 타입
--   SELECT column_name, data_type
--   FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='user_profiles'
--     AND column_name IN ('id','user_id','legacy_user_id','organization_slug')
--   ORDER BY ordinal_position;
--
-- (b) legacy_crew_import.legacy_user_id 타입
--   SELECT column_name, data_type
--   FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='legacy_crew_import'
--     AND column_name='legacy_user_id';
--
-- (c) 매칭 후보별 행수 비교 (28명 phalanx 기준 — 가장 가까운 쪽이 정답)
--   SELECT
--     (SELECT count(*) FROM public.legacy_crew_import) AS lci_total,
--     (SELECT count(*) FROM public.legacy_crew_import lci
--        JOIN public.user_profiles up ON up.user_id::text = lci.legacy_user_id::text) AS via_user_id,
--     (SELECT count(*) FROM public.legacy_crew_import lci
--        JOIN public.user_profiles up ON up.id::text      = lci.legacy_user_id::text) AS via_id;
--
-- 결과에 따라 아래 ⚠ 라인의 비교 컬럼만 user_id ↔ id 로 바꿔준다.

-- ─────────────────────────────────────────────────────────────────────
-- STEP 1: User App용 view 재정의 (organization_slug + club 포함)
-- ─────────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.crew_list_view CASCADE;

CREATE VIEW public.crew_list_view AS
SELECT
  lci.legacy_user_id,
  lci.display_name,
  lci.team_name,
  lci.part_name,
  lci.cumulative_weeks,
  up.organization_slug,
  up.organization_slug AS club  -- 기존 club 컬럼은 organization_slug로 매핑
FROM public.legacy_crew_import lci
LEFT JOIN public.user_profiles up
  ON up.user_id::text = lci.legacy_user_id::text   -- ⚠ probe 결과에 맞춰 user_id 또는 id로 조정
WHERE lci.is_visible = true;

GRANT SELECT ON public.crew_list_view TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- STEP 2: Admin 서버용 view (관리 컬럼 포함, anon에는 부여하지 않음)
-- ─────────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.admin_crew_list_view;

CREATE VIEW public.admin_crew_list_view AS
SELECT
  lci.legacy_user_id,
  lci.display_name,
  lci.team_name,
  lci.part_name,
  lci.cumulative_weeks,
  lci.is_visible,
  lci.admin_note,
  lci.updated_at,
  up.organization_slug
FROM public.legacy_crew_import lci
LEFT JOIN public.user_profiles up
  ON up.user_id::text = lci.legacy_user_id::text;  -- ⚠ STEP 1과 동일 컬럼 사용

-- service_role(supabaseAdmin)만 사용. anon/authenticated에는 부여하지 않는다.

-- ─────────────────────────────────────────────────────────────────────
-- STEP 3: organization_slug 갱신 함수
-- ─────────────────────────────────────────────────────────────────────
-- Admin API가 supabaseAdmin.rpc('set_crew_organization', ...)로 호출.
-- SECURITY DEFINER 사용하지 않음 → service_role 권한이 그대로 적용된다.
-- 따라서 anon이 이 함수를 호출해도 user_profiles에 UPDATE 권한이 없어 실패한다.
CREATE OR REPLACE FUNCTION public.set_crew_organization(
  p_legacy_user_id   text,
  p_organization_slug text
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.user_profiles
     SET organization_slug = p_organization_slug
   WHERE user_id::text = p_legacy_user_id;          -- ⚠ STEP 1과 동일 컬럼 사용

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;     -- 0이면 user_profiles 행이 아직 없는 것 → API에서 경고로 표시
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_crew_organization(text, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.set_crew_organization(text, text) TO service_role;

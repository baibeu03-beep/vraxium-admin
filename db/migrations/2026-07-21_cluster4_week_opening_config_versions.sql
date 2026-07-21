-- 2026-07-21_cluster4_week_opening_config_versions.sql
-- [오픈 확인] 재실행 정책 — 설정 버전 이력(타임라인) 테이블 + 원자 적용 함수.
--
-- 배경:
--   기존 cluster4_week_opening_configs 는 주차×조직당 "최신 오픈 설정 1개"만 보관한다(재확인 시 덮어씀).
--   재실행 정책은 "각 액트의 발생 예정 시각(occur)에 유효했던 설정"으로 가동을 판정해야 하므로,
--   설정이 바뀐 시각(effective_from)과 함께 버전 이력을 시간순으로 보존해야 한다.
--
-- 설계:
--   - cluster4_week_opening_configs 는 "최신본/마스터 스위치(open_confirmed)"로 그대로 유지(폐기·대체 X).
--     기존 loadWeekOpeningConfig·라인 개설 소비처는 계속 이 테이블만 읽는다(무회귀).
--   - 신규 cluster4_week_opening_config_versions = append-only 이력. (week_id, org) → 여러 버전.
--     액트 가동/활동 인정 개수 N/프로세스 체크 오픈 판정만 이 이력을 시점 조회한다(공용 게이트).
--   - apply_week_open_confirm(...) = [오픈 확인] 최초/재실행을 단일 트랜잭션으로 처리:
--       (1) 버전 append(version_no = MAX+1, effective_from = now()) → (2) 최신 config 갱신 →
--       (3) open_confirmed/open_confirmed_at/open_confirmed_by(+recognition) 갱신.
--     supabase-js 는 다중 문장 트랜잭션을 보장할 수 없어 함수로 원자성을 확보한다.
--
-- ⚠ RLS: 부모 테이블(cluster4_week_opening_configs)과 동일하게 GRANT SELECT + 서비스롤(supabaseAdmin)
--   쓰기 전용. ROW LEVEL SECURITY 를 켜지 말 것 — supabaseAdmin(서비스롤) 쓰기가 정책에 막혀 깨진다.
--
-- 재실행 안전: CREATE TABLE/INDEX IF NOT EXISTS, CREATE OR REPLACE FUNCTION, 백필 ON CONFLICT DO NOTHING.
-- 미적용 시(코드 선배포): 로더가 42P01 로 timelineAvailable=false → 최신 config 폴백(오늘 동작).

BEGIN;

-- ── 1) 이력 테이블 ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cluster4_week_opening_config_versions (
  id                 uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  week_id            uuid         NOT NULL
                       REFERENCES public.weeks(id) ON DELETE CASCADE,
  organization_slug  text         NOT NULL
                       CHECK (organization_slug IN ('encre','oranke','phalanx')),
  version_no         integer      NOT NULL,          -- (week_id, org)별 1-based 순번
  config             jsonb        NOT NULL DEFAULT '{}'::jsonb,
  effective_from     timestamptz  NOT NULL,          -- 이 버전이 유효해진 시각(occur 경계 비교 기준)
  created_by         uuid         NULL,
  created_at         timestamptz  NOT NULL DEFAULT now(),

  -- 중복 방지: 같은 주차·조직에 같은 version_no 금지. effective_from 에는 UNIQUE 금지
  --   (동일 초 재실행 2회가 정당 — version_no 로만 구분).
  CONSTRAINT c4_woc_versions_week_org_no_uq
    UNIQUE (week_id, organization_slug, version_no)
);

-- 리졸버 조회 인덱스: (week_id, org) 스코프에서 effective_from 시간순 조회.
CREATE INDEX IF NOT EXISTS c4_woc_versions_week_org_eff_idx
  ON public.cluster4_week_opening_config_versions (week_id, organization_slug, effective_from);

GRANT SELECT ON public.cluster4_week_opening_config_versions TO anon, authenticated;

COMMENT ON TABLE public.cluster4_week_opening_config_versions
  IS '오픈 확인 설정 버전 이력(append-only). 액트 가동은 occur 시각에 유효한 버전으로 판정(라인 오픈은 최신 config).';

-- ── 2) 원자 적용 함수 ─────────────────────────────────────────────────────────
--   서비스롤 전용. 단일 트랜잭션(함수 본문)에서 버전 append + 최신 config/open_confirmed upsert.
CREATE OR REPLACE FUNCTION public.apply_week_open_confirm(
  p_week_id                  uuid,
  p_org                      text,
  p_config                   jsonb,
  p_actor                    uuid,
  p_effective_from           timestamptz,
  p_write_recognition        boolean,
  p_min_points_a             integer,
  p_exec_points_b            integer,
  p_recognition_count_n      integer,
  p_recognition_calc_version integer
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_next integer;
BEGIN
  SELECT COALESCE(MAX(version_no), 0) + 1
    INTO v_next
    FROM public.cluster4_week_opening_config_versions
    WHERE week_id = p_week_id AND organization_slug = p_org;

  -- effective_from = 호출부(서버)에서 계산한 단일 시각. 활동 인정 개수 N 계산의 예상 타임라인과
  --   저장 버전의 경계 시각이 정확히 일치해야 하므로 서버가 넘긴 값을 그대로 쓴다(now() 재호출 금지).
  INSERT INTO public.cluster4_week_opening_config_versions
    (week_id, organization_slug, version_no, config, effective_from, created_by)
  VALUES (p_week_id, p_org, v_next, p_config, p_effective_from, p_actor);

  INSERT INTO public.cluster4_week_opening_configs
    (week_id, organization_slug, config, open_confirmed, open_confirmed_at, open_confirmed_by,
     min_points_a, exec_points_b, recognition_count_n, recognition_calc_version)
  VALUES (p_week_id, p_org, p_config, true, p_effective_from, p_actor,
     CASE WHEN p_write_recognition THEN p_min_points_a             ELSE NULL END,
     CASE WHEN p_write_recognition THEN p_exec_points_b            ELSE NULL END,
     CASE WHEN p_write_recognition THEN p_recognition_count_n      ELSE NULL END,
     CASE WHEN p_write_recognition THEN p_recognition_calc_version ELSE NULL END)
  ON CONFLICT (week_id, organization_slug) DO UPDATE SET
    config            = EXCLUDED.config,
    open_confirmed    = true,
    open_confirmed_at = EXCLUDED.open_confirmed_at,
    open_confirmed_by = EXCLUDED.open_confirmed_by,
    -- recognition 미기록(featureAvailable=false)이면 기존값 보존(null 로 덮지 않음).
    min_points_a             = CASE WHEN p_write_recognition THEN EXCLUDED.min_points_a             ELSE public.cluster4_week_opening_configs.min_points_a             END,
    exec_points_b            = CASE WHEN p_write_recognition THEN EXCLUDED.exec_points_b            ELSE public.cluster4_week_opening_configs.exec_points_b            END,
    recognition_count_n      = CASE WHEN p_write_recognition THEN EXCLUDED.recognition_count_n      ELSE public.cluster4_week_opening_configs.recognition_count_n      END,
    recognition_calc_version = CASE WHEN p_write_recognition THEN EXCLUDED.recognition_calc_version ELSE public.cluster4_week_opening_configs.recognition_calc_version END;
END;
$$;

-- 함수 실행은 서비스롤(supabaseAdmin) 전용 — 공개(anon/authenticated) 실행 차단.
REVOKE ALL ON FUNCTION public.apply_week_open_confirm(
  uuid, text, jsonb, uuid, timestamptz, boolean, integer, integer, integer, integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_week_open_confirm(
  uuid, text, jsonb, uuid, timestamptz, boolean, integer, integer, integer, integer
) TO service_role;

-- ── 3) 백필: 기존 확정 설정을 version 1 로 시드 ────────────────────────────────
--   effective_from = created_at (최초 insert 시각 = 최초 오픈 확인 시각의 가장 정확한 근사;
--   open_confirmed_at 은 재확인마다 덮어써져 부적합). open_confirmed=false(취소됨) 행은 제외.
--   floor-to-earliest 리졸버라 v1 시각의 정확도는 판정 무영향(감사 표시용).
INSERT INTO public.cluster4_week_opening_config_versions
  (week_id, organization_slug, version_no, config, effective_from, created_by, created_at)
SELECT week_id, organization_slug, 1, config,
       created_at, open_confirmed_by, created_at
FROM public.cluster4_week_opening_configs
WHERE open_confirmed = true
ON CONFLICT (week_id, organization_slug, version_no) DO NOTHING;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- 적용 전 검증 (실행해 기대치 확인)
-- ═══════════════════════════════════════════════════════════════════════
/*
-- 테이블 아직 없어야 함(NULL):
SELECT to_regclass('public.cluster4_week_opening_config_versions');
-- 기대 v1 행수(= open_confirmed=true 확정 행수):
SELECT count(*) FROM public.cluster4_week_opening_configs WHERE open_confirmed = true;
*/

-- ═══════════════════════════════════════════════════════════════════════
-- 적용 후 검증 (전부 통과해야 함)
-- ═══════════════════════════════════════════════════════════════════════
/*
-- (a) v1 행수 parity(위 기대치와 같아야):
SELECT count(*) FROM public.cluster4_week_opening_config_versions WHERE version_no = 1;
-- (b) orphan 없음(0 이어야):
SELECT count(*) FROM public.cluster4_week_opening_config_versions v
  LEFT JOIN public.weeks w ON w.id = v.week_id WHERE w.id IS NULL;
-- (c) 확정 주차의 최신 버전 config == 부모 최신 config (불일치 0행이어야):
SELECT c.week_id, c.organization_slug
FROM public.cluster4_week_opening_configs c
JOIN LATERAL (
  SELECT config FROM public.cluster4_week_opening_config_versions v
  WHERE v.week_id = c.week_id AND v.organization_slug = c.organization_slug
  ORDER BY version_no DESC LIMIT 1
) lv ON true
WHERE c.open_confirmed = true AND lv.config <> c.config;
*/

-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK (필요 시)
-- ═══════════════════════════════════════════════════════════════════════
/*
BEGIN;
DROP FUNCTION IF EXISTS public.apply_week_open_confirm(
  uuid, text, jsonb, uuid, timestamptz, boolean, integer, integer, integer, integer);
DROP TABLE IF EXISTS public.cluster4_week_opening_config_versions;
COMMIT;
*/

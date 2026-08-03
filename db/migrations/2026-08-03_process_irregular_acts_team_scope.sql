-- 2026-08-03_process_irregular_acts_team_scope.sql
-- 변동 액트(process_irregular_acts) — hub_grade='experience' 전용 "소속 팀 · 소속 파트(팀 총괄 고정)" 저장.
--
-- 정책:
--   - team_id   : cluster4_teams(id) FK. 팀의 안정 식별자(이름 변경/조직 간 동명 팀 충돌에 안전).
--   - team_name : 표시/이력 보존용 denorm(이 테이블의 applicant_admin_name/target_user_name 과 동일
--     관례). 팀 이름이 나중에 바뀌어도 "이 변동 액트를 만든 시점의 팀 이름"을 그대로 보존한다.
--   - part_scope: hub_grade='experience' 인 변동 액트는 항상 'team_overall'(팀 총괄) 1종 고정.
--     특정 파트 귀속은 이번 범위에 없다(팀 전체 1건으로만 취급, 파트별 중복 표시 금지).
--   - hub_grade<>'experience' 인 행은 셋 다 NULL 이어야 한다(다른 허브는 팀 개념이 없음).
--
-- 백필: 조사 시점(2026-08-03) 기준 hub_grade='experience' 인 기존 행은 1건
--   (id=46089c6e-c9f2-480e-9ed5-9d1b2d2993c8, org=encre, week=2026-07-20 주차,
--    recipients 매칭 대상=T김현수). resolvePositionAtBatch(주차별 소속 판정 SoT)로 그 주차 그 사용자의
--    소속을 조회하면 "비주얼랩(T)"(cluster4_teams.id=ad6304ba-c566-445a-afd6-1b1bb8939925)로
--    명확히 1개 결정된다 — 임의 지정이 아니라 실측 backfill.
--
-- 순서: 1) nullable 컬럼 추가 → 2) 위 1건 backfill → 3) 미지정 experience 행 잔여 확인(있으면
--   NOT NULL 을 강제하지 않고 CHECK 만 적용 — 정확히 결정 안 되는 행에 임의 팀을 넣지 않는다는
--   요구사항 §8 정책) → 4) CHECK 적용 → 5) 인덱스 → 6) PostgREST 리로드.
--
-- Idempotent. Supabase SQL Editor 에서 수동 적용.

BEGIN;

-- 1) nullable 컬럼 추가.
ALTER TABLE public.process_irregular_acts
  ADD COLUMN IF NOT EXISTS team_id uuid NULL REFERENCES public.cluster4_teams(id) ON DELETE SET NULL;
ALTER TABLE public.process_irregular_acts
  ADD COLUMN IF NOT EXISTS team_name text NULL;
ALTER TABLE public.process_irregular_acts
  ADD COLUMN IF NOT EXISTS part_scope text NULL;

-- 2) 실측 backfill(조사로 명확히 결정된 1건만 — 임의 지정 아님).
UPDATE public.process_irregular_acts
SET
  team_id = 'ad6304ba-c566-445a-afd6-1b1bb8939925',
  team_name = '비주얼랩(T)',
  part_scope = 'team_overall'
WHERE id = '46089c6e-c9f2-480e-9ed5-9d1b2d2993c8'
  AND hub_grade = 'experience'
  AND team_id IS NULL;

-- 3) 미지정 잔여 확인(정보용 — 있어도 마이그레이션을 막지 않는다. §8: 결정 안 되면 임의 지정 금지).
DO $$
DECLARE
  v_unassigned bigint;
  v_unassigned_ids text;
BEGIN
  SELECT count(*), string_agg(id::text, ', ')
    INTO v_unassigned, v_unassigned_ids
  FROM public.process_irregular_acts
  WHERE hub_grade = 'experience' AND team_id IS NULL;
  RAISE NOTICE '[verify] hub_grade=experience 인데 team_id 미지정 잔여: % 건 (ids: %)', v_unassigned, COALESCE(v_unassigned_ids, '-');
END $$;

-- 4) CHECK — experience 는 "이미 team_id 가 채워진 행에 한해" 3종 값의 정합을 강제하고,
--   비-experience 는 3컬럼 모두 NULL 을 강제한다. team_id 가 아직 없는 experience 행(§8 미지정
--   잔여)은 이 CHECK 를 통과한다(첫 번째 OR 분기가 team_id IS NULL 도 허용) — NOT NULL 로 막지
--   않고 "값이 있다면 정합해야 한다"만 강제한다(단계적 마이그레이션 정책).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'process_irregular_acts_team_scope_check'
  ) THEN
    ALTER TABLE public.process_irregular_acts
      ADD CONSTRAINT process_irregular_acts_team_scope_check
      CHECK (
        (
          hub_grade = 'experience'
          AND (
            -- 아직 팀이 결정 안 된 과거 행(§8) — 3컬럼 모두 NULL 허용.
            (team_id IS NULL AND team_name IS NULL AND part_scope IS NULL)
            OR
            -- 팀이 결정된 행 — 3컬럼 모두 채워지고 part_scope 는 항상 team_overall.
            (team_id IS NOT NULL AND team_name IS NOT NULL AND part_scope = 'team_overall')
          )
        )
        OR
        (
          hub_grade <> 'experience'
          AND team_id IS NULL AND team_name IS NULL AND part_scope IS NULL
        )
      );
  END IF;
END $$;

-- 5) 조회 인덱스 — 주차별 팀 매칭 필터(organization_slug, week_id, scope_mode, hub_grade, team_id).
--   기존 idx_process_irregular_acts_hub_grade(4컬럼)를 team_id 로 한 단계 더 좁힌 조합.
CREATE INDEX IF NOT EXISTS idx_process_irregular_acts_team_scope
  ON public.process_irregular_acts (organization_slug, week_id, scope_mode, hub_grade, team_id);

COMMENT ON COLUMN public.process_irregular_acts.team_id IS
  '소속 팀(cluster4_teams.id FK) — hub_grade=''experience'' 변동 액트만 사용. 그 외 허브는 NULL.';
COMMENT ON COLUMN public.process_irregular_acts.team_name IS
  '소속 팀명 denorm(생성 시점 이름 보존, 팀명 변경에도 이력 불변) — team_id 와 항상 같이 채워진다.';
COMMENT ON COLUMN public.process_irregular_acts.part_scope IS
  '소속 파트 스코프 — experience 는 항상 ''team_overall''(팀 총괄, 특정 파트 아님) 고정. 그 외 허브는 NULL.';

-- 6) PostgREST 스키마 캐시 즉시 리로드.
NOTIFY pgrst, 'reload schema';

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- 검증 (참고용 — 적용 후 아래를 SELECT 해 실제 분포 확인 가능)
-- ═══════════════════════════════════════════════════════════════════════
/*
SELECT hub_grade, part_scope, team_name, count(*)
FROM public.process_irregular_acts GROUP BY 1,2,3 ORDER BY 1,2,3;

SELECT count(*) FILTER (WHERE hub_grade = 'experience' AND team_id IS NULL) AS experience_unassigned,
       count(*) FILTER (WHERE hub_grade <> 'experience' AND (team_id IS NOT NULL OR team_name IS NOT NULL OR part_scope IS NOT NULL)) AS non_experience_leaked,
       count(*) FILTER (WHERE part_scope IS NOT NULL AND part_scope <> 'team_overall') AS part_scope_invalid
FROM public.process_irregular_acts;
*/

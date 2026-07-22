-- ============================================================================
-- 주차 결과(크루) 공표 snapshot — 최종 DDL (수동 적용 대상)
--   적용: Supabase SQL Editor (project oksnumlerbaybxlmgdux). exec_sql RPC 부재로 코드 적용 불가.
--   ⚠ 적용 전 `cluster4_week_finalize_runs` 12행 export 권장(아래 [0] 사전 점검 쿼리 참고).
--
-- 목적:
--   고객 앱 /weekly-ranking 은 매 요청 live 집계(aggregateWeeklyLeague)라, 공표 후 원천
--   (user_profiles 소속 · user_season_statuses · crew_personal_rest_periods ·
--    weekly_league_success_overrides)이 바뀌면 "소속 크루/시즌 휴식/개인 휴식/성장 도전율"이 흔들린다.
--   공표 = "그 순간의 결과 고정" 이어야 하므로, 공표 이력 SoT 인 cluster4_week_finalize_runs 에
--   결과 snapshot 을 함께 보존한다(새 공표 모델 신설 금지 — 기존 이력 테이블 확장).
--
-- 기존 12행 실측(2026-07-22) — 이 마이그레이션이 필요한 근거:
--   · organization_slug NULL 인 run 9/12 → 조직별 공표 결과를 run 으로 특정 불가
--   · created_uws_ids/updated_uws 는 **델타만** 기록(cohort=28 인데 created=5) → 코호트 복원 불가
--   · scope 어휘가 'operating'|'qa' 로 OrgResultScope('operating'|'test')와 불일치
--   · 활성 run 중복 실재: (week 496656d0…, org NULL, scope qa) 2건
--   → "uws + run 추적정보"만으로 크루별 공표 결과를 재현할 수 없다.
--
-- 기존 12행 처리 원칙:
--   **backfill 하지 않는다.** snapshot 값을 임의로 채우면 "공표 당시 값"이라는 의미가 깨진다.
--   snapshot_captured=false(기본값)로 남겨 legacy run 으로 구분하고, 조회 코드는 이 플래그가
--   false 면 "snapshot 미지원"으로 처리한다(live 폴백 금지).
-- ============================================================================

-- ── [0] 사전 점검 (적용 전 실행해 결과를 보관할 것) ──────────────────────────
--   SELECT id, week_id, organization_slug, scope, actor_id, created_at, reverted_at,
--          cohort_count, success_count, fail_count, rest_count, skipped_count
--     FROM public.cluster4_week_finalize_runs ORDER BY created_at;
--
--   -- 활성 run 중복(조직이 있는 것만 — 아래 partial unique index 의 대상):
--   SELECT week_id, organization_slug, scope, count(*)
--     FROM public.cluster4_week_finalize_runs
--    WHERE reverted_at IS NULL AND organization_slug IS NOT NULL
--    GROUP BY 1,2,3 HAVING count(*) > 1;
--   -- ⚠ 위 쿼리가 1행이라도 반환하면 인덱스 생성이 실패한다. 먼저 중복을 정리할 것.
--   --   (2026-07-22 실측: 0행 — org 있는 활성 run 은 oranke 1건뿐이라 즉시 생성 가능.)

BEGIN;

-- ── [1] run 단위 요약 snapshot ──────────────────────────────────────────────
ALTER TABLE public.cluster4_week_finalize_runs
  -- legacy 구분 플래그. 기존 12행은 false 로 남는다(= snapshot 미지원).
  ADD COLUMN IF NOT EXISTS snapshot_captured             boolean NOT NULL DEFAULT false,
  -- 공표 당시 기준 포인트 A(cluster4_week_opening_configs.recognition_count_n).
  --   기준값이 없던 주차는 NULL 그대로 — 기본값 30 폴백 금지.
  ADD COLUMN IF NOT EXISTS criterion_point_a             integer,
  ADD COLUMN IF NOT EXISTS member_count                  integer,
  ADD COLUMN IF NOT EXISTS season_rest_count             integer,
  ADD COLUMN IF NOT EXISTS personal_rest_count           integer,
  ADD COLUMN IF NOT EXISTS growth_challenge_count        integer,
  ADD COLUMN IF NOT EXISTS growth_success_count          integer,
  ADD COLUMN IF NOT EXISTS growth_failure_count          integer,
  -- 비율도 고정한다 — 산식이 바뀌어도 공표 당시 표시값이 보존되도록(0~100 정수).
  ADD COLUMN IF NOT EXISTS growth_success_rate_percent   integer,
  ADD COLUMN IF NOT EXISTS growth_challenge_rate_percent integer,
  -- 계산 메타(재현/감사).
  ADD COLUMN IF NOT EXISTS calculated_at                 timestamptz,
  ADD COLUMN IF NOT EXISTS calculation_version           smallint,
  ADD COLUMN IF NOT EXISTS source_activity_date          date;

COMMENT ON COLUMN public.cluster4_week_finalize_runs.snapshot_captured IS
  'true=이 run 이 공표 당시 결과 snapshot 을 보유. false=legacy run(2026-07-22 이전 12행) — snapshot 미지원.';
COMMENT ON COLUMN public.cluster4_week_finalize_runs.criterion_point_a IS
  '공표 당시 기준 포인트 A(recognition_count_n). NULL=그 주차·조직에 기준값 없음(30 폴백 금지).';
COMMENT ON COLUMN public.cluster4_week_finalize_runs.calculation_version IS
  '결과 산식 버전(코드 상수 CREW_METRICS_CALC_VERSION). 산식 변경 추적/재현용.';
COMMENT ON COLUMN public.cluster4_week_finalize_runs.source_activity_date IS
  '공표 실행 시점의 활동 기준일(getCurrentActivityDateIso, 00:01 KST). 시점 재현용.';

-- [2] 신규 공표 run 필수값 보장.
--   기존 행(organization_slug NULL 등) 때문에 컬럼 자체를 NOT NULL 로 만들 수 없으므로,
--   **snapshot 을 보유한 run 에 한해** 필수값을 강제한다. legacy 행은 snapshot_captured=false 라 통과.
--   ⚠ actor_id 는 강제하지 않는다 — cron/시스템 공표 경로가 NULL 을 쓸 수 있기 때문(기존 동작 보존).
ALTER TABLE public.cluster4_week_finalize_runs
  DROP CONSTRAINT IF EXISTS finalize_runs_snapshot_requires_identity;
ALTER TABLE public.cluster4_week_finalize_runs
  ADD CONSTRAINT finalize_runs_snapshot_requires_identity CHECK (
    NOT snapshot_captured
    OR (
      week_id IS NOT NULL
      AND organization_slug IS NOT NULL
      AND scope IS NOT NULL
      AND calculation_version IS NOT NULL
      AND calculated_at IS NOT NULL
    )
  );

-- 비율 범위 가드(있을 때만).
ALTER TABLE public.cluster4_week_finalize_runs
  DROP CONSTRAINT IF EXISTS finalize_runs_rate_range;
ALTER TABLE public.cluster4_week_finalize_runs
  ADD CONSTRAINT finalize_runs_rate_range CHECK (
    (growth_success_rate_percent   IS NULL OR growth_success_rate_percent   BETWEEN 0 AND 100)
    AND (growth_challenge_rate_percent IS NULL OR growth_challenge_rate_percent BETWEEN 0 AND 100)
  );

-- ── [3] 활성 run 유일성 (더블클릭·동시 공표 방지) ───────────────────────────
--   (week_id, organization_slug, scope) 중 reverted_at IS NULL 인 run 은 1건이어야 한다.
--   ⚠ organization_slug IS NOT NULL 조건을 함께 건다:
--     · PostgreSQL 은 unique index 에서 NULL 을 서로 다른 값으로 취급하므로 NULL org 행끼리는
--       어차피 충돌하지 않는다(실측: NULL org 활성 중복 2건 존재 — 이 인덱스로 막을 수 없음).
--     · legacy NULL 행을 인덱스 대상에서 명시적으로 제외해, 의도를 코드가 아닌 스키마에 남긴다.
--     · 신규 run 은 [2] CHECK 로 org 가 강제되므로 항상 이 인덱스의 보호를 받는다.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_finalize_runs_active_week_org_scope
  ON public.cluster4_week_finalize_runs (week_id, organization_slug, scope)
  WHERE reverted_at IS NULL AND organization_slug IS NOT NULL;

-- ── [4] 크루별 공표 결과 snapshot ───────────────────────────────────────────
--   JSONB 가 아니라 하위 테이블 — 사용자별 조회·재공표 차이 비교·감사가 필요하고 크루 수가 수백 규모다.
--   ⚠ 표시/식별 값을 **복사**한다(live join 금지). 이후 소속 이동·개명·팀 변경이 과거 공표 결과를
--     바꾸면 안 되기 때문. 다만 현재 화면·감사에 필요한 최소 필드만 둔다(프로필 전체 복사 금지).
CREATE TABLE IF NOT EXISTS public.cluster4_week_finalize_run_crew_results (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              uuid        NOT NULL
                        REFERENCES public.cluster4_week_finalize_runs(id) ON DELETE CASCADE,
  user_id             uuid        NOT NULL,

  -- 공표 당시 식별/표시값 복사. crew_code 는 동명이인 구분용(없으면 NULL).
  crew_display_name   text        NULL,
  crew_code           text        NULL,
  organization_slug   text        NOT NULL
                        CHECK (organization_slug IN ('encre','oranke','phalanx')),
  team_name           text        NULL,
  part_name           text        NULL,

  -- 판정 재현에 필요한 근거 일체.
  is_season_rest      boolean     NOT NULL DEFAULT false,
  is_personal_rest    boolean     NOT NULL DEFAULT false,
  is_growth_challenge boolean     NOT NULL DEFAULT false,
  -- 도메인 결과. 'pending'/'not_applicable' 을 별도로 둬서 "행 없음=실패" 임의 변환을 막는다.
  result              text        NOT NULL
                        CHECK (result IN ('success','failure','rest','not_applicable','pending')),
  -- 원본 uws 상태(없으면 NULL) — 왜 그 결과인지 설명 가능해야 한다.
  uws_status          text        NULL,
  criterion_point_a   integer     NULL,
  earned_point_a      integer     NULL,
  -- 판정 근거 코드: uws_success · uws_fail · uws_missing · season_rest · personal_rest ·
  --                not_started · override_adjusted 등.
  reason_code         text        NOT NULL,

  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cluster4_week_finalize_run_crew_results_unique UNIQUE (run_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_finalize_run_crew_results_run
  ON public.cluster4_week_finalize_run_crew_results (run_id);
CREATE INDEX IF NOT EXISTS idx_finalize_run_crew_results_user
  ON public.cluster4_week_finalize_run_crew_results (user_id);

COMMENT ON TABLE public.cluster4_week_finalize_run_crew_results IS
  '공표(finalize run) 당시의 크루별 확정 결과 snapshot. 표시값을 복사 보존해 이후 소속/개명 변경에 불변.';

-- ⚠ RLS: 부모(cluster4_week_finalize_runs)와 동일하게 ROW LEVEL SECURITY 를 켜지 않는다
--   — supabaseAdmin(서비스롤) 쓰기가 정책에 막혀 깨진다.

COMMIT;

-- ============================================================================
-- ROLLBACK (적용 취소용 — 순서 그대로 실행)
-- ============================================================================
-- BEGIN;
--   DROP TABLE IF EXISTS public.cluster4_week_finalize_run_crew_results;
--   DROP INDEX IF EXISTS public.uniq_finalize_runs_active_week_org_scope;
--   ALTER TABLE public.cluster4_week_finalize_runs
--     DROP CONSTRAINT IF EXISTS finalize_runs_snapshot_requires_identity,
--     DROP CONSTRAINT IF EXISTS finalize_runs_rate_range;
--   ALTER TABLE public.cluster4_week_finalize_runs
--     DROP COLUMN IF EXISTS snapshot_captured,
--     DROP COLUMN IF EXISTS criterion_point_a,
--     DROP COLUMN IF EXISTS member_count,
--     DROP COLUMN IF EXISTS season_rest_count,
--     DROP COLUMN IF EXISTS personal_rest_count,
--     DROP COLUMN IF EXISTS growth_challenge_count,
--     DROP COLUMN IF EXISTS growth_success_count,
--     DROP COLUMN IF EXISTS growth_failure_count,
--     DROP COLUMN IF EXISTS growth_success_rate_percent,
--     DROP COLUMN IF EXISTS growth_challenge_rate_percent,
--     DROP COLUMN IF EXISTS calculated_at,
--     DROP COLUMN IF EXISTS calculation_version,
--     DROP COLUMN IF EXISTS source_activity_date;
-- COMMIT;
--   ⚠ 기존 12행의 원래 컬럼(week_id/counts/created_uws_ids 등)은 이 마이그레이션이 건드리지 않으므로
--     rollback 후에도 그대로 보존된다.

-- ============================================================================
-- 적용 후 확인 쿼리
-- ============================================================================
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--  WHERE table_name = 'cluster4_week_finalize_runs' ORDER BY ordinal_position;
--
-- SELECT count(*) AS legacy_runs FROM public.cluster4_week_finalize_runs WHERE NOT snapshot_captured;
--   -- 기대: 12 (기존 행 보존 + 전부 legacy)
--
-- SELECT to_regclass('public.cluster4_week_finalize_run_crew_results') AS crew_table,
--        to_regclass('public.uniq_finalize_runs_active_week_org_scope') AS active_uniq_idx;
--   -- 기대: 둘 다 NOT NULL

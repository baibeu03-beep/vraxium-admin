-- ============================================================================
-- 주차 결과(크루) — 크루 표 14컬럼 공표 snapshot 확장 (수동 적용 대상)
--   적용: Supabase SQL Editor (project oksnumlerbaybxlmgdux). exec_sql RPC 부재로 코드 적용 불가.
--   대상: public.cluster4_week_finalize_run_crew_results (기존 테이블 확장)
--
-- 배경:
--   크루 표의 등수·포인트·성장률·누적 성장성공 주차·품계·클래스·학적은 전부 live 원천에 의존한다
--   (user_weekly_points · snapshot · user_grade_stats · positionResolver · user_educations).
--   공표 후 원천이 바뀌면 과거 주차 표시가 함께 변하므로, 공표 당시 값을 고정 보존한다.
--
-- ── SoT 추적 결과 ───────────────────────────────────────────────────────────
--   등수(rank)
--     = 고객 앱 CrewRankShowcase.rank (front lib/weekly-league.ts:1443~1454).
--       기준 = user_weekly_points.points(= 포인트 A) 내림차순.
--       동점 = 공동 등수, 다음 순위는 앞선 인원수만큼 건너뜀(표준 경쟁 순위).
--       표시 정렬 = 등수 → 품계 레벨 asc → 주차 성장률 desc → 이름(ko) → user_id.
--
--   활동 완료율(act_completion_rate_percent)
--     = 크루 앱 /cluster-4-card Detail Log 팝업의 "활동 완료율".
--       경로: DetailLogModal.tsx:494 actSummary = buildActSummary(data.acts)
--             → :226 buildCrewActSummary(acts)
--             → **shared/crewActSummary.ts:150 (admin·front 공유 단일 SoT)**
--       ⚠ 어드민도 이미 같은 함수를 쓴다(lib/adminCrewWeekActDetail.ts:203) — 새 산식 없음.
--       분모 total = 그 크루·그 주차의 적립 원장 행 수(= 표시 행 수)
--       분자 success = resolveCrewActResult 판정 성공 수
--         · |pointC| > 0            → fail (체크 대상이었으나 미이행. C 최우선)
--         · pointA > 0 || pointB > 0 → success
--         · A/B/C 전부 0            → success (무포인트 이행자)
--       rate = total > 0 ? Math.round(success / total * 100) : 0
--       ⚠ 함수는 total=0 일 때 0 을 돌려준다 → "액트 없음(휴식 등)"과 "실제 0%"가 같은 값이 된다.
--         저장 계층에서만 구분한다(함수 무수정):
--             act_total_count = 0  → act_completion_rate_percent = NULL → 화면 "-"
--             act_total_count > 0  → rate 저장(실제 0 이면 0) → 화면 "0%"
--       휴식(공식/시즌/개인)은 별도 분기가 없다 — 적립 원장 행이 없어 total=0 으로 자연 수렴한다.
--
--   ⚠ 포인트 A 는 **추가하지 않는다** — 기존 earned_point_a 가 이미 user_weekly_points.points
--     (= front pointA)와 동일 값이다(중복 컬럼 금지).
--   ⚠ grade_level 도 추가하지 않는다 — front gradeLevel = user_grade_stats.grade(정수)이고
--     front grade = grade_label(품계명)이라, grade(정수) + grade_label(텍스트) 2개면 충분하다.
--
-- null / 0 계약: 전 컬럼 nullable.
--     NULL = 아직 계산되지 않음 → 화면 "-"
--     0    = 계산 결과가 실제 0 → 화면 "0" 또는 "0%"
-- ============================================================================

BEGIN;

ALTER TABLE public.cluster4_week_finalize_run_crew_results
  -- 등수 — 포인트 A desc · 동점 공동 · 다음 순위 건너뜀(고객 앱 규칙 그대로).
  ADD COLUMN IF NOT EXISTS rank                        integer,

  -- 포인트 B/C (A 는 기존 earned_point_a 재사용).
  ADD COLUMN IF NOT EXISTS point_b                     integer,
  ADD COLUMN IF NOT EXISTS point_c                     integer,

  -- 활동 완료율 + 그 분모/분자(감사·"액트 없음" vs "실제 0%" 구분 근거).
  ADD COLUMN IF NOT EXISTS act_completion_rate_percent integer,
  ADD COLUMN IF NOT EXISTS act_total_count             integer,
  ADD COLUMN IF NOT EXISTS act_success_count           integer,

  ADD COLUMN IF NOT EXISTS weekly_growth_rate_percent  integer,
  ADD COLUMN IF NOT EXISTS cumulative_success_weeks    integer,

  -- 품계 — grade(정수 레벨, 정렬 키) + grade_label(표시 품계명).
  ADD COLUMN IF NOT EXISTS grade                       integer,
  ADD COLUMN IF NOT EXISTS grade_label                 text,

  -- 공표 당시 클래스/학적(현재 프로필 live 로 덮이면 과거 주차가 바뀐다).
  --   클래스는 week-effective resolver(lib/positionResolver)의 classLabel 을 그대로 복사한다
  --   — 팀/파트(기존 team_name/part_name)와 **같은 resolver 결과**여야 시점이 섞이지 않는다.
  ADD COLUMN IF NOT EXISTS class_label                 text,
  ADD COLUMN IF NOT EXISTS school_name                 text,
  ADD COLUMN IF NOT EXISTS major_name                  text;

COMMENT ON COLUMN public.cluster4_week_finalize_run_crew_results.rank IS
  '공표 당시 등수 = 주간 포인트(user_weekly_points.points=포인트 A) 랭킹. 동점 공동·다음 순위 건너뜀.';
COMMENT ON COLUMN public.cluster4_week_finalize_run_crew_results.act_completion_rate_percent IS
  '개인별 활동 완료율(Detail Log "활동 완료율"). shared/crewActSummary.buildCrewActSummary.rate. '
  'act_total_count=0 이면 NULL(화면 "-") — 액트 없음과 실제 0% 를 구분한다.';
COMMENT ON COLUMN public.cluster4_week_finalize_run_crew_results.act_total_count IS
  '활동 완료율 분모 = 그 크루·주차의 적립 원장 행 수(= Detail Log 표시 행 수).';
COMMENT ON COLUMN public.cluster4_week_finalize_run_crew_results.act_success_count IS
  '활동 완료율 분자 = resolveCrewActResult 판정 success 수.';
COMMENT ON COLUMN public.cluster4_week_finalize_run_crew_results.class_label IS
  '공표 당시 클래스(week-effective positionResolver.classLabel). team_name/part_name 과 동일 resolver 산출.';

-- ── 제약 ────────────────────────────────────────────────────────────────────
--   신규 컬럼이라 legacy 예외가 없어 CHECK 로 강제할 수 있다(NULL 은 통과 = 미계산 허용).
ALTER TABLE public.cluster4_week_finalize_run_crew_results
  DROP CONSTRAINT IF EXISTS chk_crew_rank_positive,
  DROP CONSTRAINT IF EXISTS chk_crew_act_rate,
  DROP CONSTRAINT IF EXISTS chk_crew_act_total_nonneg,
  DROP CONSTRAINT IF EXISTS chk_crew_act_success_nonneg,
  DROP CONSTRAINT IF EXISTS chk_crew_act_success_lte_total,
  DROP CONSTRAINT IF EXISTS chk_crew_growth_rate,
  DROP CONSTRAINT IF EXISTS chk_crew_cum_weeks;

ALTER TABLE public.cluster4_week_finalize_run_crew_results
  ADD CONSTRAINT chk_crew_rank_positive CHECK (rank IS NULL OR rank >= 1),
  ADD CONSTRAINT chk_crew_act_rate CHECK (
    act_completion_rate_percent IS NULL OR act_completion_rate_percent BETWEEN 0 AND 100
  ),
  ADD CONSTRAINT chk_crew_act_total_nonneg   CHECK (act_total_count   IS NULL OR act_total_count   >= 0),
  ADD CONSTRAINT chk_crew_act_success_nonneg CHECK (act_success_count IS NULL OR act_success_count >= 0),
  ADD CONSTRAINT chk_crew_act_success_lte_total CHECK (
    act_total_count IS NULL OR act_success_count IS NULL OR act_success_count <= act_total_count
  ),
  ADD CONSTRAINT chk_crew_growth_rate CHECK (
    weekly_growth_rate_percent IS NULL OR weekly_growth_rate_percent BETWEEN 0 AND 100
  ),
  ADD CONSTRAINT chk_crew_cum_weeks CHECK (
    cumulative_success_weeks IS NULL OR cumulative_success_weeks >= 0
  );

COMMIT;

-- ============================================================================
-- 적용 후 코드 계약 (구현 단계에서 지킬 것)
-- ============================================================================
--   · 완료율 ↔ count 관계는 **공표 직전 서버 검증**으로 보장한다(DB CHECK 로는 표현 불가):
--       act_total_count = 0  → act_completion_rate_percent IS NULL
--       act_total_count > 0  → rate = Math.round(success / total * 100)
--     불일치 시 **422 로 공표 전체를 차단**하고 부분 snapshot 을 저장하지 않는다
--     (팀 결과 assertTeamInvariants 와 동일 방식).
--   · 공표는 클라이언트 preview 값을 신뢰하지 않는다 — 서버가 최신 원천으로 재계산해 저장한다.
--   · 공표 조회는 live 를 섞지 않고 snapshot 값을 우선한다.
--   · 예비 검수 전에는 rank 를 포함한 **모든 결과 컬럼이 "-"** 이고, base row(크루명·학적·클래스·
--     소속 팀·소속 파트·품계)만 표시한다. 예비 후에는 같은 base row 에 overlay 만 결합한다.

-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- BEGIN;
--   ALTER TABLE public.cluster4_week_finalize_run_crew_results
--     DROP CONSTRAINT IF EXISTS chk_crew_rank_positive,
--     DROP CONSTRAINT IF EXISTS chk_crew_act_rate,
--     DROP CONSTRAINT IF EXISTS chk_crew_act_total_nonneg,
--     DROP CONSTRAINT IF EXISTS chk_crew_act_success_nonneg,
--     DROP CONSTRAINT IF EXISTS chk_crew_act_success_lte_total,
--     DROP CONSTRAINT IF EXISTS chk_crew_growth_rate,
--     DROP CONSTRAINT IF EXISTS chk_crew_cum_weeks;
--   ALTER TABLE public.cluster4_week_finalize_run_crew_results
--     DROP COLUMN IF EXISTS rank,
--     DROP COLUMN IF EXISTS point_b,
--     DROP COLUMN IF EXISTS point_c,
--     DROP COLUMN IF EXISTS act_completion_rate_percent,
--     DROP COLUMN IF EXISTS act_total_count,
--     DROP COLUMN IF EXISTS act_success_count,
--     DROP COLUMN IF EXISTS weekly_growth_rate_percent,
--     DROP COLUMN IF EXISTS cumulative_success_weeks,
--     DROP COLUMN IF EXISTS grade,
--     DROP COLUMN IF EXISTS grade_label,
--     DROP COLUMN IF EXISTS class_label,
--     DROP COLUMN IF EXISTS school_name,
--     DROP COLUMN IF EXISTS major_name;
-- COMMIT;
--   ⚠ 기존 컬럼(user_id/crew_display_name/team_name/part_name/result/earned_point_a 등)은
--     이 마이그레이션이 건드리지 않으므로 rollback 후에도 그대로 보존된다.

-- ============================================================================
-- 적용 후 확인
-- ============================================================================
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--  WHERE table_name = 'cluster4_week_finalize_run_crew_results'
--    AND column_name IN ('rank','point_b','point_c','act_completion_rate_percent',
--        'act_total_count','act_success_count','weekly_growth_rate_percent',
--        'cumulative_success_weeks','grade','grade_label','class_label','school_name','major_name')
--  ORDER BY column_name;
--   -- 기대: 13행 · 전부 is_nullable = YES
--
-- SELECT conname FROM pg_constraint
--  WHERE conrelid = 'public.cluster4_week_finalize_run_crew_results'::regclass
--    AND conname LIKE 'chk_crew_%' ORDER BY conname;
--   -- 기대: chk_crew_act_rate · chk_crew_act_success_lte_total · chk_crew_act_success_nonneg ·
--   --       chk_crew_act_total_nonneg · chk_crew_cum_weeks · chk_crew_growth_rate · chk_crew_rank_positive
--
-- SELECT count(*) FROM public.cluster4_week_finalize_run_crew_results;
--   -- 기대: 기존 행 수 무변경(현재 0)

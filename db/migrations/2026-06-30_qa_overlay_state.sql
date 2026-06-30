-- 2026-06-30_qa_overlay_state.sql
-- QA 모드(mode=test) 운영 액션 결과를 운영 DB 와 분리해 보관하는 qa_* 오버레이.
--
-- 배경 / 설계 (claudedocs 설계안 — QA 오버레이):
--   기획자 QA 는 운영과 동일한 시즌/주차/기준일(weeks·seasons·캘린더 공유) 위에서,
--   "시간이 지나야 일어나는 운영 액션"(공표·검수완료·확정·체크기준)을 수동 버튼으로 먼저
--   실행해보고 그 결과를 어드민 + 고객앱(테스트 유저 한정)에서 확인한다.
--
--   핵심: 운영 액션이 바꾸는 상태는 두 종류로 갈린다.
--     1) per-week 글로벌 상태  — weeks.result_published_at / result_reviewed_at /
--        check_threshold, org_week_thresholds. 주차 1개당 1행, 전 유저 공유 → 오버레이 필요.
--     2) per-user 상태         — user_week_statuses · user_weekly_points ·
--        cluster4_weekly_card_snapshots(user_id 키) 등. 테스트 유저는 test_user_markers 로
--        분리된 disjoint user_id 집합이라 이미 QA-격리됨 → 오버레이 불필요.
--
--   따라서 본 마이그레이션은 글로벌 weeks/org_week_thresholds 운영 컬럼만 오버레이한다.
--
-- 상태 해석 스코프 = "대상 유저가 test_user_marker 인가"에서 파생(lib/operationalState).
--   테스트 유저 → qa_* 우선 읽음 · 실유저 → 운영 weeks/org_week_thresholds 만.
--   운영 경로는 본 테이블을 절대 읽지/쓰지 않는다 → 운영 동작 바이트 동일.
--
-- ⚠ QA 는 운영 weeks/seasons/캘린더를 fork 하지 않는다(기준 State 공유). 오버레이는
--   운영 "액션 결과 컬럼"만 미러.
--
-- 해석 규칙 = COALESCE(qa 오버레이, 운영 baseline) — QA 가 운영 위에 "덧쓰기"만 한다:
--   test 유저 공표상태 = qa_weeks_state.result_published_at ?? weeks.result_published_at.
--   이유: (1) 과거 주차(운영 공표 완료)는 QA 에서도 공표로 보여 baseline 일관,
--         (2) QA 액션은 아직 운영 미공표인 주차만 "먼저 공표"해보는 것 → 운영 무영향,
--         (3) qa_* 행 삭제(OFF/원복) 시 자동으로 운영 baseline 으로 복귀 — 검증 일관.
--   운영 경로는 이 COALESCE 를 절대 타지 않는다(qa 읽지 않음) → 운영 동작 불변.
--
-- 의존성: weeks (2026-06-01_weeks_result_published.sql · 2026-06-05_weeks_check_threshold.sql),
--   org_week_thresholds (2026-06-07_org_week_thresholds.sql).
-- Idempotent — 재실행 안전. Supabase SQL Editor 에서 수동 실행.


-- ═══════════════════════════════════════════════════════════════════════
-- PART 1: qa_weeks_state — weeks 운영 컬럼 오버레이 (주차 1개당 1행)
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.qa_weeks_state (
  week_id              uuid PRIMARY KEY REFERENCES public.weeks(id) ON DELETE CASCADE,

  -- 운영 weeks 컬럼 미러 (코드 계약 lib/operationalState: qa 값 ?? 운영 baseline)
  result_published_at  timestamptz NULL,   -- QA 공표 시점 (NULL=운영 baseline 상속)
  result_reviewed_at   timestamptz NULL,   -- QA 검수 완료 시점 (NULL=운영 baseline 상속)

  -- 체크 기준값: qa_weeks_state.check_threshold → (NULL 이면) weeks.check_threshold → 30
  check_threshold      integer NULL CHECK (check_threshold IS NULL OR check_threshold >= 0),

  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid NULL            -- 액션 실행 관리자(감사용)
);

COMMENT ON TABLE public.qa_weeks_state IS
  'QA 모드 주차 글로벌 운영상태 오버레이(weeks 미러). 테스트 유저 대상 read/write 만 사용 · 운영 경로 무접촉. 해석 = COALESCE(qa, 운영 baseline) — qa 값이 덧쓰기, NULL 이면 운영값 상속(행 삭제 시 운영 복귀).';
COMMENT ON COLUMN public.qa_weeks_state.result_published_at IS
  'QA 공표 시점. NULL=운영 weeks.result_published_at baseline 상속. 값 존재=QA 가 먼저 공표(운영 무영향, 테스트 유저만 노출).';
COMMENT ON COLUMN public.qa_weeks_state.check_threshold IS
  'QA 체크 기준값. NULL=폴백(weeks.check_threshold → 30). org 차원은 qa_org_week_thresholds.';


-- ═══════════════════════════════════════════════════════════════════════
-- PART 2: qa_org_week_thresholds — org_week_thresholds 오버레이
--   해석 순서(코드 계약 lib/operationalState · scope=qa):
--     1) qa_org_week_thresholds(week_id, organization_slug)
--     2) 없으면 qa_weeks_state.check_threshold
--     3) 없으면 weeks.check_threshold
--     4) 없으면 DEFAULT_WEEK_CHECK_THRESHOLD = 30
--   운영(scope=operating) 해석 순서는 기존과 동일(org_week_thresholds → weeks → 30) — 무변경.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.qa_org_week_thresholds (
  week_id            uuid NOT NULL REFERENCES public.weeks(id) ON DELETE CASCADE,
  organization_slug  text NOT NULL
    CHECK (organization_slug IN ('encre', 'oranke', 'phalanx')),
  check_threshold    integer NOT NULL CHECK (check_threshold >= 0),

  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid NULL,

  PRIMARY KEY (week_id, organization_slug)
);

COMMENT ON TABLE public.qa_org_week_thresholds IS
  'QA 모드 조직별 주차 체크 기준값 오버레이(org_week_thresholds 미러). 해제는 행 삭제(폴백 복귀). 운영 경로 무접촉.';


-- ═══════════════════════════════════════════════════════════════════════
-- PART 3: qa_action_log — QA 액션 감사 로그(원복·검증·디버깅)
--   모든 QA Writer 가 before/after 스냅을 남긴다. 운영 액션은 본 로그를 쓰지 않는다.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.qa_action_log (
  id          bigserial PRIMARY KEY,
  action      text NOT NULL
    CHECK (action IN ('publish', 'review', 'finalize', 'check_threshold', 'org_check_threshold', 'sweep')),
  week_id     uuid NULL REFERENCES public.weeks(id) ON DELETE SET NULL,
  scope_mode  text NOT NULL DEFAULT 'qa' CHECK (scope_mode = 'qa'),  -- 본 로그는 QA 전용
  before_json jsonb NULL,
  after_json  jsonb NULL,
  actor       uuid NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qa_action_log_week
  ON public.qa_action_log (week_id, created_at DESC);

COMMENT ON TABLE public.qa_action_log IS
  'QA 모드 운영 액션 감사 로그(publish/review/finalize/check_threshold/org_check_threshold/sweep). scope_mode=qa 고정 · 운영 액션 미기록.';

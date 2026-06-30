-- 2026-06-30_week_auto_action_log.sql
-- 운영 자동 fallback(주차 공표/검수 자동 실행) 감사 로그.
--
-- 배경 / 설계 (Phase D — 운영 자동 fallback):
--   공표/검수는 "수동 우선 + 미실행 시 자동 fallback" 구조다. 자동 실행은 수동 버튼과
--   **동일한 Action Service**(publishWeekResult / markWeekResultReviewed, scope=operating)를
--   호출하며, 차이는 호출 주체(스케줄러)뿐이다.
--     · 공표 자동 데드라인 = N+1주차 목 14:00 KST (= weeks.end_date + 4일 14:00 KST)
--     · 검수 자동 데드라인 = N+1주차 금 16:00 KST (= weeks.end_date + 5일 16:00 KST)
--
--   본 테이블은 "자동 fallback이 실제로 무엇을 바꿨는가"(실사용자 카드에 영향 주는 공표 등)를
--   명시적으로 남긴다(요구사항: 변경 범위를 로그로). 운영 액션 전용 — QA(qa_action_log)와 분리.
--
-- ⚠ 멱등: 이미 수동/이전-자동으로 처리된 주차는 Action Service 가드(409)로 skip 되며,
--   그 경우도 outcome='skipped' 로 1행 남긴다(중복 적립/중복 변경 없음). 운영 데이터는
--   "due + 미처리" 주차에만 변경된다.
--
-- Idempotent. Supabase SQL Editor 에서 수동 실행.

CREATE TABLE IF NOT EXISTS public.week_auto_action_log (
  id              bigserial PRIMARY KEY,
  action          text NOT NULL CHECK (action IN ('publish', 'review')),
  week_id         uuid NULL REFERENCES public.weeks(id) ON DELETE SET NULL,
  week_start_date date NULL,        -- 가독성/조회용(week 삭제돼도 보존)
  outcome         text NOT NULL CHECK (outcome IN ('done', 'skipped', 'failed')),
  -- done    : Action Service 가 실제로 운영 컬럼을 세팅(공표/검수) — 변경 발생
  -- skipped : 이미 처리됨(409) — 변경 없음(수동 우선 정책의 정상 경로)
  -- failed  : 실행 중 오류 — 다음 주기 재시도(주차가 여전히 due+미처리이므로 자연 재시도)
  detail          jsonb NULL,       -- {cutoffIso, alreadyDone, error, snapshotRecompute, resultAt}
  actor           text NOT NULL DEFAULT 'auto-fallback',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_week_auto_action_log_week
  ON public.week_auto_action_log (week_id, action, created_at DESC);

COMMENT ON TABLE public.week_auto_action_log IS
  '운영 자동 fallback(주차 공표/검수 자동 실행) 감사 로그. 수동 버튼과 동일 Action Service(scope=operating) 호출 결과 기록. done=변경발생/skipped=이미처리(409)/failed=재시도. QA(qa_action_log)와 분리.';

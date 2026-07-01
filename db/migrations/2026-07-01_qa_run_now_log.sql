-- 2026-07-01_qa_run_now_log.sql
-- QA "즉시 실행"(run-now) 어드민 버튼 감사 로그.
--
-- 배경 / 설계:
--   QA 테스트 기간 동안 관리자가 기존 "시간이 지나야 도는" 자동 로직을 기다리지 않고
--   버튼으로 1회 수동 실행할 수 있게 한다. 버튼은 기존 service/function 을 **변경 없이**
--   재호출하는 입구일 뿐이며, 동작은 항상 테스트 사용자/테스트 크루로 fail-closed 스코프된다.
--     · process_check : runDueProcessCheckSweep(scope='qa') — scope_mode='test' 강제
--     · snapshot_batch: recomputeWeeklyCardsSnapshotsForUsers(test_user_markers 전수)
--     · user_snapshot : recomputeWeeklyCardsSnapshotsForUsers(선택한 test userIds, fail-closed)
--
--   본 테이블은 "어떤 버튼이 언제·누구에 의해·무엇을 대상으로·어떤 결과로" 실행됐는지를 남긴다.
--   기존 자동 fallback 로그(week_auto_action_log)·QA 오버레이 로그(qa_action_log)와 분리한다
--   (run-now 는 수동 어드민 트리거 전용 — 자동 스케줄러와 구분).
--
-- ⚠ best-effort 로깅: 본 테이블이 없거나(미적용) insert 가 실패해도 버튼 동작 자체는 막지 않는다
--   (코드가 fail-soft 로 무시). 따라서 본 마이그레이션 미적용 시 로그만 비고, 실행은 정상.
--
-- Idempotent. Supabase SQL Editor 에서 수동 실행.

CREATE TABLE IF NOT EXISTS public.qa_run_now_log (
  id           bigserial PRIMARY KEY,
  action       text NOT NULL CHECK (action IN ('process_check', 'snapshot_batch', 'user_snapshot')),
  mode         text NOT NULL CHECK (mode IN ('dry_run', 'execute')),
  scope        text NOT NULL DEFAULT 'test' CHECK (scope IN ('test')),  -- run-now 는 항상 test 스코프(운영 미허용)
  outcome      text NOT NULL CHECK (outcome IN ('success', 'partial', 'failed')),
  actor        text NULL,        -- 실행 관리자(세션 식별자/이메일/표시명 — 가용한 것)
  target       jsonb NULL,       -- {userIds?, onlyIds?, testUserCount, ...} 실행 대상 요약
  result       jsonb NULL,       -- 서비스 함수 반환 요약(sweep/recompute 결과 + 반영 확인)
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qa_run_now_log_created
  ON public.qa_run_now_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_qa_run_now_log_action_created
  ON public.qa_run_now_log (action, created_at DESC);

COMMENT ON TABLE public.qa_run_now_log IS
  'QA 즉시 실행(run-now) 어드민 버튼 감사 로그. 기존 자동 로직을 변경 없이 수동 1회 호출한 결과 기록(항상 test 스코프 fail-closed). 자동 fallback(week_auto_action_log)·QA 오버레이(qa_action_log)와 분리. best-effort(미적용 시 로그만 비고·실행 정상).';

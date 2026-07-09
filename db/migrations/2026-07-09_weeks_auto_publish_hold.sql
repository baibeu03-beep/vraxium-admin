-- 2026-07-09_weeks_auto_publish_hold.sql
-- 자동 sweep(dueWeekActionsSweep) 재공표 보류 플래그.
--
-- 배경: 자동 sweep 은 "마감(N+1 목 14:00 KST) 지남 + 미공표"인 운영 주차를 자동 공표한다.
--   그런데 관리자가 [실행 취소](주차 검수 되돌리기)로 공표를 의도적으로 내리면, sweep 이
--   같은 주차를 곧(≤10분) 다시 공표해 취소가 무효가 된다. → "관리자가 의도적으로 취소했다"는
--   상태를 남겨 sweep 이 그 주차를 건너뛰게 한다. 다시 [검수 완료](공표) 를 누르면 해제된다.
--
-- 스코프 분리(운영/QA 동일 로직·저장소만 스코프별):
--   · operating : weeks.auto_publish_hold_at        (실행 취소 시 now, 재공표 시 NULL)
--   · qa        : qa_weeks_state.auto_publish_hold_at (동일 의미·QA 격리)
--   자동 sweep 은 operating 전용이므로 weeks.auto_publish_hold_at 만 게이트로 읽는다.
--
-- 의미: NOT NULL = 관리자가 실행 취소함(자동 재공표 보류). NULL = 보류 없음(자동 공표 가능).
-- Idempotent — 재실행 안전. Supabase SQL Editor 에서 수동 실행.

ALTER TABLE public.weeks
  ADD COLUMN IF NOT EXISTS auto_publish_hold_at timestamptz NULL;

ALTER TABLE public.qa_weeks_state
  ADD COLUMN IF NOT EXISTS auto_publish_hold_at timestamptz NULL;

COMMENT ON COLUMN public.weeks.auto_publish_hold_at IS
  '관리자가 검수 완료를 실행 취소한 주차 — 자동 sweep 재공표 보류. 재검수(공표) 시 NULL 로 해제.';
COMMENT ON COLUMN public.qa_weeks_state.auto_publish_hold_at IS
  'QA 오버레이: 실행 취소 재공표 보류(자동 sweep 은 operating 전용이라 참조 안 함·의미 미러).';

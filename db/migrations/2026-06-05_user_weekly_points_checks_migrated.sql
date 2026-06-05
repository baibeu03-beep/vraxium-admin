-- 2026-06-05_user_weekly_points_checks_migrated.sql
-- check 게이트 명시적 전환 플래그 (휴리스틱 CHECK_GATE_DATA_SIGNAL_MIN 대체).
--
-- 배경: 레거시(2026 여름 W1 이전) 주차 성공 판정의 check 게이트는 "check 데이터가
--   이관된 행"에만 강제(enforce)되어야 한다. 종전에는 사용자별 check 최대값 >= 10
--   휴리스틱으로 추론했으나, 부분 시즌 이관·저분포 사용자에서 오판하므로
--   행 단위 provenance 플래그로 교체한다.
--
-- 계약(중요 — 향후 실사용자 check 이관 작업의 의무):
--   * 이관 파이프라인이 user_weekly_points 행을 기록/갱신할 때 checks_migrated=true 로
--     설정해야 그 (사용자, 주차)의 check 게이트가 자동 활성화된다. 별도 코드 수정 불필요.
--   * 이관 대상 주차에 check 가 0건이어도 행(points=0, checks_migrated=true)을 기록할 것 —
--     행 부재/false = "미이관"으로 간주되어 기존 주차 결과가 보존된다(fail-safe).
--   * 행·주차 단위이므로 일부 사용자만, 일부 시즌만 이관해도 정확히 그 범위에만 적용된다.
--
-- 기존 잔존값(이관 전 자동 시드 0~4 스케일)은 default false 로 전부 "미이관" 처리된다.
-- 더미 테스터 행은 시드 스크립트(apply-legacy-check-case-seed.ts)가 true 로 기록한다.
--
-- Idempotent. Supabase SQL Editor 에서 수동 실행.

ALTER TABLE public.user_weekly_points
  ADD COLUMN IF NOT EXISTS checks_migrated boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.user_weekly_points.checks_migrated IS
  'point.check 값이 정식 이관/집계된 행인지 (provenance). true 인 행만 레거시 주차 성공 check 게이트가 강제된다. 이관 파이프라인은 행 기록 시 반드시 true 설정(0건이어도 행 기록). false/행 부재 = 미이관 → 기존 주차 결과 보존.';

-- 프로세스 체크 포인트 원장 소프트 취소(soft-cancel) 상태 추가.
-- ─────────────────────────────────────────────────────────────────────
-- 관리자가 특정 크루의 특정 액트 결과를 "무효화(취소)"할 수 있게 한다. 원장 행은 삭제하지 않고
-- cancelled_at 을 채워 취소 상태로 남긴다(감사 추적 보존). 포인트 합산·집계는 취소 행을 제외한다.
--
-- 핵심 규칙(코드 lib/processPointAccrual.ts 가 강제):
--   · user_weekly_points 재합산(recomputeWeeklyPoints)은 cancelled_at IS NULL 행만 더한다 → 취소분
--     즉시 반영(Point C 감소 시 최종 Point B 복원). 모든 포인트 합산 경로가 이 공통 레이어를 탄다.
--   · 재적립/정합(reconcileAwards)은 취소된 행을 삭제하지 않고 보존한다(회수 delete 에 cancelled_at
--     IS NULL 조건) → 체크가 재실행돼도 upsert 가 취소 상태를 덮어쓰지 않아 부활하지 않는다.
--   · 취소는 (source,ref_id) 코호트 전체가 아니라 개별 원장 행(id, user_id) 단위로만 수행한다.
--
-- ⚠ 수동 적용: Supabase SQL Editor 에서 실행(프로젝트 관례). 미적용 시 코드가 컬럼 부재를 감지해
--    기존 동작(취소 없음)으로 우아하게 폴백한다 — 미취소 데이터 합계는 적용 전후 동일(무손실).

alter table public.process_point_awards
  add column if not exists cancelled_at  timestamptz,
  add column if not exists cancelled_by  uuid,
  add column if not exists cancel_reason text;

-- 미취소 행만 스캔하는 합산 쿼리 가속(부분 인덱스). 취소 행은 소수이므로 인덱스에서 제외.
create index if not exists idx_ppa_active_user_week
  on public.process_point_awards (user_id, year, week_number)
  where cancelled_at is null;

-- ============================================================================
-- 라인 개설 포인트 지급(line-open payout) — process_point_awards.source 에 'line' 추가.
--
--   기존: source in ('regular','irregular')  (2026-06-15_process_point_awards.sql:23)
--   추가: 'line' — 라인 개설 시 대상자에게 지급되는 라인 강화 Point.A/B 원장.
--         ref_id = '<lineId>:<weekId>' (cluster4_lines.id : weeks.id) · 멱등키 (source,ref_id,user_id) 재사용.
--         point_check = 활성 Point.A · point_advantage = 활성 Point.B · point_penalty 미사용(0).
--
--   유니크키/인덱스/재합산(recomputeWeeklyPoints)/스냅샷 무효화는 source 무관이라 스키마 변경 없음.
--   ⚠ 수동 적용(SQL Editor). 미적용 시 accrual 은 fail-open(원장 미생성) — 런타임 무회귀.
-- ============================================================================

ALTER TABLE public.process_point_awards
  DROP CONSTRAINT IF EXISTS process_point_awards_source_check;

ALTER TABLE public.process_point_awards
  ADD CONSTRAINT process_point_awards_source_check
  CHECK (source IN ('regular', 'irregular', 'line'));

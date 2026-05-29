-- 2026-05-29_cluster4_lines_drop_activity_type_global_unique.sql
-- 배경:
--   기존 cluster4_lines_activity_type_id_active_unique 인덱스는
--     ON public.cluster4_lines (activity_type_id)
--     WHERE activity_type_id IS NOT NULL AND is_active = true
--   형태의 "전역" 부분 유니크였다.
--
--   그러나 Cluster4 실무 정보 라인의 주차 SoT 는 cluster4_lines 가 아니라
--   cluster4_line_targets.week_id 이다. cluster4_lines 에는 week_id 컬럼이 없으므로,
--   이 전역 유니크는 "12주차 community(active) 상태에서 13주차 community 개설" 을
--   DB INSERT 단계(23505)에서 차단해, 주차 단위 중복 정책
--   (week_id + activity_type_id)과 정면 충돌했다.
--
-- 정책:
--   - 주차 단위 중복은 애플리케이션 레벨(info-lines POST)에서
--     active cluster4_lines(activity_type_id) ∩ cluster4_line_targets.week_id 로 검사한다.
--   - cluster4_lines 에 week_id 가 없으므로 "주차 단위" DB 유니크는 만들 수 없다.
--     → 잘못된(전역) 유니크를 새로 만들지 않는다.
--   - 조회용 비유니크 인덱스 cluster4_lines_activity_type_id_idx 는 그대로 유지한다.

BEGIN;

DROP INDEX IF EXISTS public.cluster4_lines_activity_type_id_active_unique;

COMMIT;

-- Rollback (참고용 — 정책상 복원하지 말 것):
-- BEGIN;
-- CREATE UNIQUE INDEX IF NOT EXISTS cluster4_lines_activity_type_id_active_unique
--   ON public.cluster4_lines (activity_type_id)
--   WHERE activity_type_id IS NOT NULL AND is_active = true;
-- COMMIT;

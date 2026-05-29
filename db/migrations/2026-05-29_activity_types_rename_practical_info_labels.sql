-- 2026-05-29_activity_types_rename_practical_info_labels.sql
-- 실무 정보(practical_info) 활동 유형 2건의 표시명(activity_types.name)을 운영 요청 라벨로 정정.
--
-- 배경:
--   탭 표시 순서는 프론트(PracticalInfoManager)에서 id 기준으로 고정 완료.
--   다만 표시 텍스트는 SoT 인 activity_types.name 에서 오는데, 2건이 요청 라벨과 불일치.
--     - practical_lecture: (운영 DB 실측값 '아카데미') → '실무특강'
--     - etc_a:             '기타'                      → '기타A'
--   * 주의: 2026-05-27 seed 의 표기('프랙티컬 렉처')와 운영 DB 실측값('아카데미')이
--     서로 달랐다. 따라서 옛 name 값에 의존하지 않고 id 기준으로 목표값을 강제한다.
--   id 는 변경하지 않는다 (practical_lecture / etc_a 유지). 정렬 순서도 그대로 유지.
--
-- 재실행 안전:
--   id 기준 UPDATE + 이미 목표값이면 제외(name <> 목표값) → 재실행 시 0 rows (idempotent).

BEGIN;

UPDATE public.activity_types
SET name = '실무특강'
WHERE id = 'practical_lecture'
  AND cluster_id = 'practical_info'
  AND name <> '실무특강';

UPDATE public.activity_types
SET name = '기타A'
WHERE id = 'etc_a'
  AND cluster_id = 'practical_info'
  AND name <> '기타A';

COMMIT;

-- ============================================================
-- ROLLBACK (필요 시)
-- ============================================================
/*
-- 주의: 롤백 시 practical_lecture 의 원복 대상은 운영 실측값 '아카데미'.
BEGIN;
UPDATE public.activity_types
SET name = '아카데미'
WHERE id = 'practical_lecture' AND cluster_id = 'practical_info' AND name = '실무특강';

UPDATE public.activity_types
SET name = '기타'
WHERE id = 'etc_a' AND cluster_id = 'practical_info' AND name = '기타A';
COMMIT;
*/

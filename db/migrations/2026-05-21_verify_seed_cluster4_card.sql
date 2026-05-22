-- 2026-05-21_verify_seed_cluster4_card.sql
-- Cluster4-card 검증용 최소 seed (TEST FIXTURE ONLY — 운영 seed 아님).
--
-- 목적:
--   v1 schema drift 패치 적용 후 /cluster-4-card-ec/?userId=<u> 진입 검증.
--   activity_types CREATE TABLE 직후 row 0 건 상태에서 4-grid 카드 슬롯
--   생성을 확인하기 위한 최소 fixture.
--
-- 운영 seed 와 구분:
--   - id 가 'verify-*' prefix → 운영 taxonomy 마스터와 충돌 회피
--   - 모든 row idempotent (ON CONFLICT DO NOTHING)
--   - 파일 맨 아래 ROLLBACK 섹션으로 일괄 제거 가능
--
-- 선행 조건:
--   1) 2026-05-21_activity_types_canonical.sql 적용 완료
--   2) public.activity_types 테이블 존재
--
-- 미포함 (의도된 분리):
--   - 운영용 taxonomy seed → 운영 정책 결정 후 별도 단계
--   - seasons / weeks fixture → 운영 DB 의 기존 데이터 사용 전제. 운영 weeks
--     가 비어 있어 "표시할 주차가 없습니다" 가 사라지지 않으면 별도 단계에서
--     verify-fixture-weeks seed 추가 결정.
--   - user_edit_windows fixture → Weekly Review POST 권한 부여용. admin
--     계정으로 검증하면 불필요. 본 파일 끝의 OPTIONAL 섹션 참조.

BEGIN;

-- ============================================================
-- B1. activity_types: 3 cluster_id 별 1 건씩 (4-grid 카드 슬롯 생성용)
-- ============================================================
INSERT INTO public.activity_types
  (id, name, line_code, cluster_id, description,
   eligible_min_approved_weeks, eligible_max_approved_weeks,
   count_once_in_total, is_active)
VALUES
  ('verify-comp-1', '[검증] 실무 역량 샘플', 'CP-VERIFY-01',
   'practical_competency', 'verify-fixture-2026-05-21',
   NULL, NULL, false, true),
  ('verify-exp-1',  '[검증] 실무 경험 샘플', 'EX-VERIFY-01',
   'practical_experience', 'verify-fixture-2026-05-21',
   NULL, NULL, false, true),
  ('verify-car-1',  '[검증] 실무 경력 샘플', 'CR-VERIFY-01',
   'practical_career',     'verify-fixture-2026-05-21',
   NULL, NULL, false, true)
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- ============================================================
-- (OPTIONAL) Weekly Review POST 권한 부여용 user_edit_windows row
--   본인 user_id 로 <YOUR_USER_ID> 치환 후 적용. admin email 계정이면 불필요.
--   현재 24시간 윈도우 (테스트용).
-- ============================================================
/*
INSERT INTO public.user_edit_windows
  (id, user_id, resource_key, opened_at, expires_at, note)
VALUES
  ( gen_random_uuid(),
    '<YOUR_USER_ID>'::uuid,
    'cluster4.weekly_reviews',
    now() - interval '1 hour',
    now() + interval '24 hours',
    'verify-fixture-2026-05-21 weekly_reviews')
ON CONFLICT (user_id, resource_key) DO UPDATE
SET opened_at  = EXCLUDED.opened_at,
    expires_at = EXCLUDED.expires_at,
    note       = EXCLUDED.note;
*/

-- ============================================================
-- ROLLBACK — 검증 종료 후 fixture 제거
-- ============================================================
/*
BEGIN;
-- user_edit_windows OPTIONAL row 제거 (적용한 경우만)
DELETE FROM public.user_edit_windows
WHERE resource_key = 'cluster4.weekly_reviews'
  AND note LIKE 'verify-fixture-2026-05-21%';

-- activity_types verify fixture
DELETE FROM public.activity_types
WHERE id IN ('verify-comp-1','verify-exp-1','verify-car-1');
COMMIT;
*/

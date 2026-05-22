-- 2026-05-21_peer_review_pivot_step1_rename_score_grid.sql
-- Cluster4 데이터 모델 pivot: score-grid → peer-review.
-- 기존 admin score-grid 테이블 3개를 *_scores 로 rename 하여 보존.
-- 본 파일은 rename 만 수행. 새 peer-review 테이블 생성은 step2.
--
-- 운영 row count (적용 직전 확인):
--   weekly_reputations    = 0
--   season_reputations    = 0
--   reputation_keywords   = 6  (admin seed: leadership/communication/responsibility/execution/teamwork/creativity)
-- → 데이터 손실 없음.
--
-- 재실행 가능: `ALTER TABLE IF EXISTS … RENAME TO …`.

BEGIN;

ALTER TABLE IF EXISTS public.reputation_keywords
  RENAME TO reputation_score_keys;

ALTER TABLE IF EXISTS public.weekly_reputations
  RENAME TO weekly_reputation_scores;

ALTER TABLE IF EXISTS public.season_reputations
  RENAME TO season_reputation_scores;

COMMIT;

-- 주의:
-- (1) Rename 은 테이블 identifier 만 바꾼다. 컬럼/CHECK/UNIQUE/INDEX/TRIGGER 에 박힌
--     'weekly_reputations_*' 등 식별자 이름은 그대로 남는다. 기능 영향 없음, 가독성만 떨어짐.
--     필요 시 후속 cleanup PR 에서 개별 RENAME CONSTRAINT/INDEX 로 정리.
-- (2) FK (예: weekly_reputation_scores.keyword_key → reputation_score_keys.keyword_key) 는
--     PostgreSQL 이 object id 로 추적하므로 rename 후에도 그대로 유효하다.
-- (3) Admin Cluster4Editor 의 readonly 탭은 본 step 이후 `from("weekly_reputations")` /
--     `from("reputation_keywords")` 호출이 step2 에서 생성될 비어 있는 peer-review 테이블을
--     가리키게 된다. 본 단계에서는 의도된 동작. Admin 측 코드를 *_scores 로 갈아끼우는
--     PR 은 별도.

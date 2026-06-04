-- ═══════════════════════════════════════════════════════════════════════
-- tester-experience-success-backfill-v13-20260604
--
-- 목적: 테스터(90명, test_user_markers)의 과거 확정 공표 주차에 실무 경험(slot1/2/3)
--       라인을 마스터 카탈로그에서 주차별 개설(cluster4_lines 인스턴스 생성)하고
--       테스터에게 배정(cluster4_line_targets) + user_week_statuses fail→success 보정.
--       세 슬롯 전부 본인 타깃+마감 경과 → verdict-pass → success 가 허브/이력서/누적에
--       일관 반영되고 v11/v13 sync 에서 회귀하지 않는다.
--
-- 안전:
--   * 대상 사용자 = test_user_markers 만
--   * 후보 주차 = end_date < 오늘 AND result_published_at IS NOT NULL
--                AND is_official_rest=false AND start_date < '2026-05-04'
--     (2026-05-04 = 실유저 최초 활동주차 — 그 이후 주차에 라인을 개설하면 분모A(org 필터
--      없음)·required-slot verdict(org 무관)가 실유저까지 오염되므로 절대 금지)
--   * uws 는 status='fail' 행만 success 로 (rest/기존 success 불변)
--   * 라인/타깃 INSERT 만 — 기존 행 UPDATE 없음 (uws 제외)
--   * 마커: cluster4_lines.source_file_name = 'tester-experience-success-backfill-v13-20260604'
--
-- ⚠ 주차 선택의 "테스터별 3~18주 랜덤"은 시드 RNG(스크립트 mulberry32, seed=마커+user_id)로
--   결정된다. 본 SQL 은 구조·감사·원복용이며, 실제 선택 쌍은 실행 로그
--   claudedocs/tester-experience-success-backfill-v13-20260604-inserted.json 이 SoT 다.
--   (SQL 만으로 동일 셔플을 재현할 수 없음 — 수동 재실행 시 스크립트를 사용할 것.)
-- ═══════════════════════════════════════════════════════════════════════

-- ───────────────────────── [PREVIEW] (read-only) ─────────────────────────
-- 후보 주차
WITH cand_weeks AS (
  SELECT id, start_date FROM weeks
  WHERE end_date < '2026-06-04'
    AND result_published_at IS NOT NULL
    AND is_official_rest = false
    AND start_date < '2026-05-04'
)
SELECT
  (SELECT count(*) FROM cand_weeks)                                            AS 후보_주차수,   -- 기대 25
  (SELECT count(*) FROM test_user_markers)                                     AS 테스터수,      -- 기대 90
  (SELECT count(*) FROM user_week_statuses uws
     JOIN cand_weeks w ON w.start_date = uws.week_start_date
     JOIN test_user_markers t ON t.user_id = uws.user_id
     WHERE uws.status = 'fail')                                                AS 가용_fail_주차쌍, -- 풀(선택은 이 중 608)
  (SELECT count(*) FROM cluster4_experience_line_masters
     WHERE is_active AND experience_slot_order IN (1,2,3))                     AS 사용가능_마스터수;
-- 실행 플랜(시드 고정): lines 189 (org×주차 63 × slot3) / targets 1,824 / uws 보정 608 / 실유저 0

-- ───────────────────────── [APPLY 구조] (트랜잭션 — 스크립트 실행분과 동등) ─────────────────────────
-- BEGIN;
-- 1) (org × slot1/2/3 × 선택주차) 라인 인스턴스 — 마스터 콘텐츠 그대로, 주차 마감(수 13:00Z)
--    INSERT INTO cluster4_lines
--      (part_type, experience_line_master_id, line_code, main_title,
--       submission_opens_at, submission_closes_at, is_active, week_id,
--       source_file_name, created_by, updated_by)
--    SELECT 'experience', m.id, m.line_code, m.default_main_title,
--           (w.start_date::timestamptz - interval '1 day' + interval '15 hours'),
--           (w.start_date::timestamptz + interval '2 days' + interval '13 hours'),
--           true, w.id,
--           'tester-experience-success-backfill-v13-20260604',
--           'c28b2409-4118-49fc-a42e-68e18dbd194c', 'c28b2409-4118-49fc-a42e-68e18dbd194c'
--    FROM <선택주차 × org> JOIN cluster4_experience_line_masters m
--      ON m.organization_slug = <org> AND m.experience_slot_order IN (1,2,3) AND m.is_active
--    WHERE NOT EXISTS (SELECT 1 FROM cluster4_lines l
--      WHERE l.source_file_name='tester-experience-success-backfill-v13-20260604'
--        AND l.experience_line_master_id=m.id AND l.week_id=w.id);
--
-- 2) 타깃 — 선택 (tester, week) × slot 3, NOT EXISTS 중복 가드 (unique constraint 부재 보완)
--    INSERT INTO cluster4_line_targets
--      (line_id, week_id, target_mode, target_user_id, target_rule, created_by, updated_by)
--    SELECT l.id, w.id, 'user', sel.user_id, '{}'::jsonb,
--           'c28b2409-4118-49fc-a42e-68e18dbd194c', 'c28b2409-4118-49fc-a42e-68e18dbd194c'
--    FROM <선택쌍 sel(user_id, week_id, org)> JOIN <1)의 라인 l (org·week·slot 매칭)>
--    WHERE NOT EXISTS (SELECT 1 FROM cluster4_line_targets x
--      WHERE x.line_id=l.id AND x.week_id=w.id AND x.target_mode='user' AND x.target_user_id=sel.user_id);
--
-- 3) uws fail → success 보정 (선택쌍만, fail 가드)
--    UPDATE user_week_statuses uws SET status='success', updated_at=now()
--    FROM <선택쌍 sel> WHERE uws.user_id=sel.user_id AND uws.week_start_date=sel.week_start
--      AND uws.status='fail';
--
-- 4) 검증 (기대: 라인 189 / 타깃 1824 / uws 608 / 실유저 0) → 일치 시 COMMIT, 아니면 ROLLBACK
-- COMMIT;

-- ───────────────────────── [검증 SELECT] ─────────────────────────
SELECT
  (SELECT count(*) FROM cluster4_lines
     WHERE source_file_name='tester-experience-success-backfill-v13-20260604')   AS 생성_라인수,   -- 기대 189
  (SELECT count(*) FROM cluster4_line_targets x
     JOIN cluster4_lines l ON l.id = x.line_id
     WHERE l.source_file_name='tester-experience-success-backfill-v13-20260604') AS 생성_타깃수,   -- 기대 1824
  (SELECT count(*) FROM cluster4_line_targets x
     JOIN cluster4_lines l ON l.id = x.line_id
     WHERE l.source_file_name='tester-experience-success-backfill-v13-20260604'
       AND NOT EXISTS (SELECT 1 FROM test_user_markers t WHERE t.user_id = x.target_user_id)) AS 실유저_타깃_오염, -- 기대 0
  (SELECT count(*) FROM user_week_statuses uws
     JOIN test_user_markers t ON t.user_id = uws.user_id
     WHERE uws.status='success' AND uws.week_start_date < '2026-05-04')           AS 테스터_success_주차; -- ≒ 608

-- ───────────────────────── [REVERT] ─────────────────────────
-- BEGIN;
-- DELETE FROM cluster4_line_targets x USING cluster4_lines l
--   WHERE x.line_id = l.id
--     AND l.source_file_name = 'tester-experience-success-backfill-v13-20260604';
-- DELETE FROM cluster4_lines
--   WHERE source_file_name = 'tester-experience-success-backfill-v13-20260604';
-- -- uws 원복: 실행 로그의 (user_id, week_start_date) 쌍에 한해 success→fail
-- --   (정밀 원복 = scripts/revert-tester-exp-success-backfill.ts --apply 권장.
-- --    SQL 일괄 원복이 꼭 필요하면: 테스터 + <05-04 + success 를 fail 로 — 단 이 경우
-- --    백필 이전부터 success 였던 행이 없음을 먼저 확인할 것. 2026-06-04 시점 기준
-- --    테스터 <05-04 success 는 0건이었으므로 일괄 원복과 로그 원복이 동치.)
-- COMMIT;

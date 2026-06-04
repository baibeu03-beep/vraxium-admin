-- ═══════════════════════════════════════════════════════════════════════
-- 테스터 과거 fail 주차 "라인 개설" 더미 데이터 보강 (2026-06-04)
--
-- 목적: v11 sync(2026-06-04 01:06Z)로 fail 전환된 테스터 과거 주차에,
--       실제 라인 개설이 있었던 것처럼 info 라인 개설(타깃) 데이터를 보강한다.
--       v11 verdict / user_week_statuses(fail) 는 일절 변경하지 않는다.
--
-- 안전 근거:
--   * 대상 사용자 = test_user_markers 등재 90명만 (실유저 절대 비포함)
--   * info 라인은 line_code NULL → org 판정 불가 → 미배정 사용자에게 fail-closed(숨김)
--     → 같은 org 실유저의 카드/분모/강화율에 영향 없음
--   * experience 필수 슬롯 verdict(slot 1/2/3) 와 무관 → 주차 fail 판정 불변
--   * 기존 라인 행은 UPDATE 하지 않음 (신규 INSERT 만)
--
-- 후보 정의:
--   user_week_statuses.status='fail'
--   AND updated_at ∈ [2026-06-04T01:00Z, 2026-06-04T01:10Z)   -- 오늘 v11 flip 분만
--   AND week_start_date < '2026-05-25'                         -- tallying(05-25)/running(06-01) 제외
--   AND user_id ∈ test_user_markers
--   AND (user, week) 에 user-mode 타깃이 아직 없음              -- 중복 INSERT 금지
--
-- 실행: Supabase SQL Editor 에서 [PREVIEW] 블록 먼저 실행해 수치 확인 후,
--       [APPLY] 블록(BEGIN~)을 실행. 검증 SELECT 수치가 PREVIEW 와 다르면 ROLLBACK.
-- ═══════════════════════════════════════════════════════════════════════

-- ───────────────────────── [PREVIEW] (read-only) ─────────────────────────
WITH cand AS (
  SELECT uws.user_id, uws.week_start_date, w.id AS week_id
  FROM user_week_statuses uws
  JOIN weeks w  ON w.start_date = uws.week_start_date
  JOIN test_user_markers t ON t.user_id = uws.user_id
  WHERE uws.status = 'fail'
    AND uws.updated_at >= '2026-06-04T01:00:00Z'
    AND uws.updated_at <  '2026-06-04T01:10:00Z'
    AND uws.week_start_date < '2026-05-04'  -- min(tallying 05-25, 실유저 최초 활동주차 05-04): info=common 노출이라 실유저 카드 범위 주차는 보강 금지
), dedup AS (
  SELECT c.* FROM cand c
  WHERE NOT EXISTS (
    SELECT 1 FROM cluster4_line_targets x
    WHERE x.week_id = c.week_id AND x.target_mode = 'user' AND x.target_user_id = c.user_id
  )
)
SELECT
  (SELECT count(DISTINCT user_id)        FROM dedup)                          AS 대상_테스터수,
  (SELECT count(DISTINCT week_start_date) FROM dedup)                         AS 대상_주차수,
  (SELECT count(*)                        FROM dedup)                         AS 타깃_INSERT_예정,
  (SELECT count(*) FROM cand) - (SELECT count(*) FROM dedup)                  AS 중복_제외,
  (SELECT count(DISTINCT d.week_id) FROM dedup d
    WHERE NOT EXISTS (
      SELECT 1 FROM cluster4_lines l
      WHERE l.part_type='info' AND l.is_active AND l.week_id = d.week_id))    AS 신규_더미라인_필요_주차수;
-- 기대값 (2026-06-04 preview, cutoff 05-04): 테스터 90 / 주차 32 / 타깃 941 / 중복 0 / 신규 라인 14
-- (최초 cutoff 05-25 로 1001 타깃/16 라인 적용 후, 05-04·05-11 두 주차가 실유저 카드 범위와
--  겹쳐 분모A 오염 확인 → 60 타깃/2 라인 부분 원복. 최종 적용분 = 941 타깃/14 라인.)

-- ───────────────────────── [APPLY] (트랜잭션) ─────────────────────────
BEGIN;

-- 1) info 라인이 없는 후보 주차에 더미 info 라인 신설 (16 row 예상)
--    audit 마커: source_file_name = 'tester-backfill-20260604' (ROLLBACK/원복 식별 키)
WITH cand_weeks AS (
  SELECT DISTINCT w.id AS week_id, w.start_date
  FROM user_week_statuses uws
  JOIN weeks w ON w.start_date = uws.week_start_date
  JOIN test_user_markers t ON t.user_id = uws.user_id
  WHERE uws.status = 'fail'
    AND uws.updated_at >= '2026-06-04T01:00:00Z'
    AND uws.updated_at <  '2026-06-04T01:10:00Z'
    AND uws.week_start_date < '2026-05-04'  -- min(tallying 05-25, 실유저 최초 활동주차 05-04): info=common 노출이라 실유저 카드 범위 주차는 보강 금지
)
INSERT INTO cluster4_lines
  (part_type, main_title, activity_type_id, is_recurring_content,
   output_link_1, output_links, recognition_mode,
   submission_opens_at, submission_closes_at,
   is_active, week_id, source_file_name, created_by, updated_by)
SELECT
  'info',
  '관심있는 산업/직무 분야에서 정보를 얻을 수 있는 어떤 일정들이 있을까? 내 성장을 플래닝하기!',
  'calendar',
  false,  -- is_recurring_content=true 는 excel source 체크 제약 위반 → 단발성
  'https://cafe.naver.com/oranke/24106',
  '[{"url":"https://cafe.naver.com/oranke/24106","label":"[캘린더] 라인 진행 장소"},{"url":"https://peppermint-geese-bc8.notion.site/ORANKALENDAR-152de44d123881a08538f2e19002da0b?pvs=4","label":"[캘린더] 클럽 공식 캘린더"}]'::jsonb,
  'legacy_allowed',
  (cw.start_date::timestamptz - interval '1 day' + interval '15 hours'),
  (cw.start_date::timestamptz + interval '2 days' + interval '13 hours'),
  true,
  cw.week_id,
  'tester-backfill-20260604',
  'c28b2409-4118-49fc-a42e-68e18dbd194c',
  'c28b2409-4118-49fc-a42e-68e18dbd194c'
FROM cand_weeks cw
WHERE NOT EXISTS (
  SELECT 1 FROM cluster4_lines l
  WHERE l.part_type = 'info' AND l.is_active AND l.week_id = cw.week_id
);

-- 2) 주차별 대표 info 라인 1개에 테스터 user-mode 타깃 INSERT (1001 row 예상, NOT EXISTS 중복 방지)
WITH cand AS (
  SELECT uws.user_id, w.id AS week_id
  FROM user_week_statuses uws
  JOIN weeks w  ON w.start_date = uws.week_start_date
  JOIN test_user_markers t ON t.user_id = uws.user_id
  WHERE uws.status = 'fail'
    AND uws.updated_at >= '2026-06-04T01:00:00Z'
    AND uws.updated_at <  '2026-06-04T01:10:00Z'
    AND uws.week_start_date < '2026-05-04'  -- min(tallying 05-25, 실유저 최초 활동주차 05-04): info=common 노출이라 실유저 카드 범위 주차는 보강 금지
), pick AS (
  SELECT DISTINCT ON (l.week_id) l.week_id, l.id AS line_id
  FROM cluster4_lines l
  WHERE l.part_type = 'info' AND l.is_active
    AND l.week_id IN (SELECT week_id FROM cand)
  ORDER BY l.week_id, l.submission_opens_at NULLS LAST, l.id
)
INSERT INTO cluster4_line_targets
  (line_id, week_id, target_mode, target_user_id, target_rule, created_by, updated_by)
SELECT
  p.line_id, c.week_id, 'user', c.user_id, '{}'::jsonb,
  'c28b2409-4118-49fc-a42e-68e18dbd194c',
  'c28b2409-4118-49fc-a42e-68e18dbd194c'
FROM cand c
JOIN pick p ON p.week_id = c.week_id
WHERE NOT EXISTS (
  SELECT 1 FROM cluster4_line_targets x
  WHERE x.week_id = c.week_id AND x.target_mode = 'user' AND x.target_user_id = c.user_id
);

-- 3) 검증: PREVIEW 기대값과 일치해야 COMMIT
SELECT
  (SELECT count(*) FROM cluster4_lines
    WHERE source_file_name = 'tester-backfill-20260604')                       AS 신규_라인수,    -- 기대 14
  (SELECT count(*) FROM cluster4_line_targets x
    WHERE x.created_by = 'c28b2409-4118-49fc-a42e-68e18dbd194c'
      AND x.created_at >= now() - interval '10 minutes'
      AND EXISTS (SELECT 1 FROM test_user_markers t WHERE t.user_id = x.target_user_id)) AS 신규_타깃수, -- 기대 1001
  (SELECT count(*) FROM cluster4_line_targets x
    WHERE NOT EXISTS (SELECT 1 FROM test_user_markers t WHERE t.user_id = x.target_user_id)
      AND x.created_at >= now() - interval '10 minutes')                       AS 실유저_타깃_오염; -- 기대 0

-- 수치 일치 → COMMIT; / 불일치 → ROLLBACK;
COMMIT;
-- ROLLBACK;   -- ← 검증 실패 시 이 줄만 실행

-- ───────────────────────── [REVERT] (사후 원복) ─────────────────────────
-- COMMIT 후에도 audit 마커로 전량 원복 가능:
-- BEGIN;
-- DELETE FROM cluster4_line_targets x
--   USING test_user_markers t
--   WHERE x.target_user_id = t.user_id AND x.target_mode='user'
--     AND x.created_by = 'c28b2409-4118-49fc-a42e-68e18dbd194c'
--     AND x.created_at >= '2026-06-04T02:00:00Z';   -- 실행 시각 이후로 좁히기
-- DELETE FROM cluster4_lines WHERE source_file_name = 'tester-backfill-20260604';
-- COMMIT;
-- (정밀 원복은 scripts/revert-tester-line-open-backfill.ts — 삽입 ID 로그 기반 삭제 — 사용 권장)

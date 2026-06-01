-- ════════════════════════════════════════════════════════════════════════
-- 2026-06-01_backfill_2025_autumn_weeks_1_3.sql
-- ════════════════════════════════════════════════════════════════════════
--
-- 목적:
--   2025-autumn 시즌의 누락된 1~3주차 weeks row 를 보강한다.
--   (시즌은 2025-09-01 시작이지만 기존 weeks 는 4주차(2025-09-22)부터 존재해
--    첫 3주가 누락 → operation-health-check 의 uws_week_unmapped 12건 발생.)
--
--   보강 대상:
--     - 1주차: iso 2025-W36, 2025-09-01 ~ 2025-09-07
--     - 2주차: iso 2025-W37, 2025-09-08 ~ 2025-09-14
--     - 3주차: iso 2025-W38, 2025-09-15 ~ 2025-09-21
--   규칙(기존 2025-autumn row 관찰):
--     - week_index        = iso_week
--     - is_official_rest  = false (시즌 초반, 시험기간 아님)
--     - result_published_at = end_date + 1일 (형제 row 패턴)
--     - started_at/ended_at = start_date/end_date 의 UTC 자정
--     - season_id         = 기존 2025-autumn weeks row 에서 가져옴(아래 meta CTE)
--
-- ⚠ 멱등(idempotent):
--     - 같은 (iso_year, iso_week) 가 이미 있으면 INSERT 하지 않는다(NOT EXISTS).
--     - 기존 2025-autumn weeks row 가 하나도 없으면 season_id 를 못 구하므로
--       meta CTE 가 0행 → CROSS JOIN 0행 → INSERT 0건(안전한 no-op).
--     - 여러 번 실행해도 결과 동일.
--
-- ⛔ 이 변경은 이미 현재 DB 에 직접 반영됨(2026-06-01). 이 파일은 "다른 환경 재현용"이며
--    현재 DB 에는 다시 실행할 필요가 없다(재실행해도 멱등이라 무해).
--
-- 의존성: weeks(season_id, week_index, iso_year, iso_week, start_date, end_date,
--         started_at, ended_at, result_published_at, is_official_rest, season_key 등),
--         season_definitions('2025-autumn'). resolve_season_key 등 함수 불필요.
--
-- ── 사전 조건(읽기전용, 실행 전 수동 확인 권장) ──────────────────────────
--   -- (a) 시즌 시작일이 2025-09-01 인지
--   SELECT start_date FROM public.season_definitions WHERE season_key = '2025-autumn';
--   -- (b) 기존 2025-autumn 이 4주차부터 시작하고 1~3주차가 없는지
--   SELECT min(week_number), max(week_number) FROM public.weeks WHERE season_key = '2025-autumn';
--   -- (c) iso 36/37/38 와 start_date 09-01/09-08/09-15 가 아직 없는지 (둘 다 0행 기대)
--   SELECT count(*) FROM public.weeks WHERE iso_year = 2025 AND iso_week IN (36,37,38);
--   SELECT count(*) FROM public.weeks WHERE start_date IN (DATE '2025-09-01', DATE '2025-09-08', DATE '2025-09-15');
-- ════════════════════════════════════════════════════════════════════════


WITH meta AS (
  -- season_id 는 기존 2025-autumn weeks row 에서 가져온다(없으면 0행 → no-op).
  SELECT season_id
  FROM public.weeks
  WHERE season_key = '2025-autumn'
    AND season_id IS NOT NULL
  LIMIT 1
),
new_weeks (week_number, iso_year, iso_week, start_date, end_date) AS (
  VALUES
    (1::smallint, 2025::smallint, 36::smallint, DATE '2025-09-01', DATE '2025-09-07'),
    (2::smallint, 2025::smallint, 37::smallint, DATE '2025-09-08', DATE '2025-09-14'),
    (3::smallint, 2025::smallint, 38::smallint, DATE '2025-09-15', DATE '2025-09-21')
)
INSERT INTO public.weeks (
  season_id, season_key, week_number, week_index,
  iso_year, iso_week, start_date, end_date,
  started_at, ended_at, result_published_at, updated_at,
  is_official_rest, holiday_name
)
SELECT
  m.season_id,
  '2025-autumn',
  n.week_number,
  n.iso_week,                                              -- week_index = iso_week
  n.iso_year,
  n.iso_week,
  n.start_date,
  n.end_date,
  (n.start_date::timestamp AT TIME ZONE 'UTC'),            -- started_at  = start 00:00 UTC
  (n.end_date::timestamp   AT TIME ZONE 'UTC'),            -- ended_at    = end   00:00 UTC
  ((n.end_date + 1)::timestamp AT TIME ZONE 'UTC'),        -- result_published_at = end+1일 00:00 UTC
  now(),
  false,                                                   -- is_official_rest
  NULL                                                     -- holiday_name
FROM new_weeks n
CROSS JOIN meta m
WHERE NOT EXISTS (                                         -- 멱등 가드: 같은 ISO 주차 이미 있으면 skip
  SELECT 1 FROM public.weeks w
  WHERE w.iso_year = n.iso_year
    AND w.iso_week = n.iso_week
);


-- ── 사후 검증(읽기전용, 실행 후 수동 확인) ───────────────────────────────
--   -- (1) 2025-autumn 이 1~17 로 연속인지
--   SELECT week_number, iso_week, start_date, end_date
--   FROM public.weeks WHERE season_key = '2025-autumn' ORDER BY week_number;
--
--   -- (2) 더 이상 매칭 안 되는 uws 가 없는지 (0 기대)
--   SELECT count(*) AS still_unmapped
--   FROM public.user_week_statuses uws
--   WHERE NOT EXISTS (
--     SELECT 1 FROM public.weeks w
--     WHERE w.iso_year = uws.year AND w.iso_week = uws.week_number
--   );
--
--   -- (3) 신규 3주가 uws 12건과 매칭되는지 (각 4건, 합 12 기대)
--   SELECT w.week_number, w.iso_week, count(uws.id) AS matched_uws
--   FROM public.weeks w
--   JOIN public.user_week_statuses uws
--     ON uws.year = w.iso_year AND uws.week_number = w.iso_week
--   WHERE w.season_key = '2025-autumn' AND w.week_number IN (1,2,3)
--   GROUP BY w.week_number, w.iso_week ORDER BY w.week_number;


-- ════════════════════════════════════════════════════════════════════════
-- 롤백 SQL (필요 시 — 이 migration 으로 추가한 3행만 제거)
-- ════════════════════════════════════════════════════════════════════════
-- uws 는 weeks 에 FK 가 없어(ISO join) 삭제가 cascade 되지 않는다.
-- 롤백 후 operation-health-check 의 week_mapping_mismatch_count 는 다시 12 로 돌아간다.
--
--   DELETE FROM public.weeks
--   WHERE season_key = '2025-autumn'
--     AND iso_year = 2025
--     AND iso_week IN (36, 37, 38)
--     AND week_number IN (1, 2, 3)
--     AND start_date IN (DATE '2025-09-01', DATE '2025-09-08', DATE '2025-09-15');
-- ════════════════════════════════════════════════════════════════════════

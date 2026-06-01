-- ════════════════════════════════════════════════════════════════════════
-- 2026-06-01_winter_week1_transition_fix.sql
-- ════════════════════════════════════════════════════════════════════════
--
-- "전환 주차는 시즌당 최대 1주" 정책(A안) 정정 — 최종본.
--   ※ 이 파일은 검토 완료(A안 확정)되었으나, 운영 DB 적용은 §1 확인 후
--     §2 트랜잭션을 수동 실행(검증→COMMIT/ROLLBACK)하는 것을 전제로 한다.
--
-- ── 확정 원인 ────────────────────────────────────────────────────────────
--   season_definitions.2026-winter.start_date 가 라이브 DB 에서 2025-12-30(화)로
--   잘못 시드됨(정답 = 2025-12-29 월). autumn(end 12-28) 과 winter(start 12-30)
--   사이 12-29(월) 1일이 gap 이 되어 resolve_season_key('2025-12-29') 가
--   직전 시즌 2025-autumn 으로 귀속 → autumn 18주차(전환)라는 잘못된 결과 발생.
--
-- ── 확정 정책 (A안) ──────────────────────────────────────────────────────
--   - 2025-12-22 ~ 2025-12-28 = 2025-autumn 17주차(전환)          [유지]
--   - 2025-12-29 ~ 2026-01-04 = 2026-winter  1주차                [정정: autumn 18 → winter 1]
--   - 기존 2026-winter 1~8주차 → 2~9주차로 +1 시프트
--   - 2026-02-23 ~ 2026-03-01 = 2026-winter  9주차(전환)
--   - 2025-autumn 은 17주차까지만 존재
--   - 전환 주차는 시즌당 최대 1주만 존재
--
-- ── 수정 범위 ────────────────────────────────────────────────────────────
--   (1) season_definitions : 2026-winter.start_date  2025-12-30 → 2025-12-29
--   (2) weeks              : winter 1~8 → 2~9 시프트 + 12-29 행 winter/1 재귀속
--   (3) user_week_statuses : 12-29 주차 season_key → 2026-winter (week_number 불변)
--
-- ── 스키마 메모 ──────────────────────────────────────────────────────────
--   weeks              : UNIQUE(iso_year, iso_week). (season_key, week_number) 제약 없음.
--   user_week_statuses : UNIQUE(user_id, year, week_number). week_number=ISO주차(시즌무관)
--                        → season_key 만 갱신, 키 충돌 없음.
--
-- ── 실행 순서 ────────────────────────────────────────────────────────────
--   §1 (읽기전용 사전확인) → §2 (BEGIN~가드~검증~COMMIT) → §3 (사후 읽기검증)
--   §2 의 검증/NOTICE 가 기대와 다르면 COMMIT 대신 ROLLBACK.
--   ※ 비멱등(1회성). §2-0 가드가 재실행·이미적용 상태를 차단한다.
-- ════════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════════
-- §1. 사전 확인 (읽기전용)
-- ════════════════════════════════════════════════════════════════════════

-- 1-1. 경계값 확인 — 2026-winter.start_date = 2025-12-30(화, start_dow=2) 예상
SELECT season_key, start_date, end_date,
       EXTRACT(ISODOW FROM start_date) AS start_dow,  -- 1=월(정상), 2=화(오류)
       EXTRACT(ISODOW FROM end_date)   AS end_dow
FROM public.season_definitions
WHERE season_key IN ('2025-autumn', '2026-winter')
ORDER BY start_date;

-- 1-2. 현재 winter 번호 분포 (시프트 전) — 1..8 예상
SELECT week_number, start_date, end_date
FROM public.weeks
WHERE season_key = '2026-winter'
ORDER BY start_date;

-- 1-3. 12-29 주차 행의 현재 귀속 — autumn/18 또는 NULL 예상
SELECT id, season_key, week_number, start_date, end_date, iso_year, iso_week
FROM public.weeks
WHERE start_date = DATE '2025-12-29';

-- 1-4. autumn 최대 주차 — 18 예상(정정 후 17)
SELECT max(week_number) AS autumn_max_week, count(*) AS autumn_rows
FROM public.weeks
WHERE season_key = '2025-autumn';

-- 1-5. 12-29 주차 uws 분포 — 변경 대상 건수 미리보기
SELECT season_key, count(*) AS rows
FROM public.user_week_statuses
WHERE week_start_date = DATE '2025-12-29'
GROUP BY season_key
ORDER BY season_key NULLS FIRST;


-- ════════════════════════════════════════════════════════════════════════
-- §2. 데이터 수정 (TRANSACTION)
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── 2-0. 안전 가드 — 선행조건 위배 시 즉시 중단 ──────────────────────────
DO $$
DECLARE
  v_1229_is_winter int;
  v_winter_max     int;
BEGIN
  SELECT count(*) INTO v_1229_is_winter
  FROM public.weeks
  WHERE start_date = DATE '2025-12-29' AND season_key = '2026-winter';
  IF v_1229_is_winter > 0 THEN
    RAISE EXCEPTION '중단: 2025-12-29 주차가 이미 2026-winter 로 귀속됨(이미 적용). ROLLBACK 하세요.';
  END IF;

  SELECT COALESCE(max(week_number), 0) INTO v_winter_max
  FROM public.weeks WHERE season_key = '2026-winter';
  IF v_winter_max <> 8 THEN
    RAISE EXCEPTION '중단: 2026-winter 최대 주차 기대값 8, 실제 %. 수동 점검 필요.', v_winter_max;
  END IF;
END $$;

-- ── 2-1. season_definitions: 2026-winter.start_date 교정 (12-30 → 12-29) ──
UPDATE public.season_definitions
   SET start_date = DATE '2025-12-29'
 WHERE season_key = '2026-winter'
   AND start_date = DATE '2025-12-30';

DO $$
DECLARE v_start date;
BEGIN
  SELECT start_date INTO v_start FROM public.season_definitions WHERE season_key = '2026-winter';
  RAISE NOTICE '2026-winter.start_date (교정 후) = %  (기대: 2025-12-29)', v_start;
  IF v_start <> DATE '2025-12-29' THEN
    RAISE EXCEPTION '중단: 2026-winter.start_date 가 2025-12-29 가 아님(=%).', v_start;
  END IF;
END $$;

-- ── 2-2. weeks: 기존 winter 1~8 → 2~9 로 +1 시프트 (02-23: 8→9 전환) ──────
UPDATE public.weeks
   SET week_number = week_number + 1
 WHERE season_key = '2026-winter';

-- ── 2-3. weeks: 12-29 주차를 winter 1주차로 재귀속 ────────────────────────
UPDATE public.weeks
   SET season_key = '2026-winter',
       week_number = 1
 WHERE start_date = DATE '2025-12-29'
   AND season_key IS DISTINCT FROM '2026-winter';

-- ── 2-4. user_week_statuses: 12-29 주차 season_key → winter ───────────────
--   week_number(ISO=1)는 시즌무관이라 변경하지 않음. 유니크 키 충돌 없음.
UPDATE public.user_week_statuses
   SET season_key = '2026-winter',
       updated_at = now()
 WHERE week_start_date = DATE '2025-12-29'
   AND season_key IS DISTINCT FROM '2026-winter';

-- ── 2-5. 트랜잭션 내 최종 검증 (COMMIT 전) ────────────────────────────────
-- 2-5-a. winter 1~9 연속·유일
SELECT week_number, start_date, end_date
FROM public.weeks
WHERE season_key = '2026-winter'
ORDER BY week_number;

-- 2-5-b. (season_key, week_number) 의미 중복 0건
SELECT season_key, week_number, count(*) AS dup
FROM public.weeks
WHERE season_key = '2026-winter'
GROUP BY season_key, week_number
HAVING count(*) > 1;

-- 2-5-c. autumn 최대 17, 18 부재
SELECT max(week_number) AS autumn_max_week,
       count(*) FILTER (WHERE week_number = 18) AS autumn_w18_remaining
FROM public.weeks
WHERE season_key = '2025-autumn';

-- 2-5-d. 핵심 경계 행 스냅샷
SELECT season_key, week_number, start_date, end_date
FROM public.weeks
WHERE start_date IN (DATE '2025-12-22', DATE '2025-12-29', DATE '2026-02-23')
ORDER BY start_date;

-- ✅ 아래 기대값과 일치하면 COMMIT, 아니면 ROLLBACK:
--    2025-12-22 → 2025-autumn / 17
--    2025-12-29 → 2026-winter / 1
--    2026-02-23 → 2026-winter / 9
--    autumn_max_week=17, autumn_w18_remaining=0, winter=1..9 연속, dup 0건
COMMIT;
-- ROLLBACK;


-- ════════════════════════════════════════════════════════════════════════
-- §3. 사후 검증 (읽기전용) — COMMIT 후
-- ════════════════════════════════════════════════════════════════════════

-- 3-1. winter 전체 주차표 (기대: 1..9 / 12-29 ~ 03-01)
SELECT week_number, start_date, end_date
FROM public.weeks
WHERE season_key = '2026-winter'
ORDER BY week_number;
--   기대:
--     1  2025-12-29  2026-01-04   (← autumn 18 에서 이동)
--     2  2026-01-05  2026-01-11
--     3  2026-01-12  2026-01-18
--     4  2026-01-19  2026-01-25
--     5  2026-01-26  2026-02-01
--     6  2026-02-02  2026-02-08
--     7  2026-02-09  2026-02-15
--     8  2026-02-16  2026-02-22
--     9  2026-02-23  2026-03-01   (전환 주차)

-- 3-2. (season_key, week_number) 전체 중복 점검 — 0건 정상
SELECT season_key, week_number, count(*) AS dup
FROM public.weeks
WHERE season_key IS NOT NULL AND week_number IS NOT NULL
GROUP BY season_key, week_number
HAVING count(*) > 1
ORDER BY season_key, week_number;

-- 3-3. "전환 주차 최대 1주" 불변식 — 정규주수 초과분이 1 이하인지 (위반 0건 정상)
SELECT w.season_key,
       max(w.week_number) AS max_week,
       max(w.week_number) - CASE sd.season_type
         WHEN 'winter' THEN 8 WHEN 'summer' THEN 8 ELSE 16 END AS transition_weeks
FROM public.weeks w
JOIN public.season_definitions sd ON sd.season_key = w.season_key
WHERE w.week_number IS NOT NULL
GROUP BY w.season_key, sd.season_type
HAVING max(w.week_number) > CASE sd.season_type
         WHEN 'winter' THEN 9 WHEN 'summer' THEN 9 ELSE 17 END
ORDER BY w.season_key;

-- 3-4. weeks ↔ uws 귀속 일관성 (시즌 불일치 0건 정상)
SELECT count(*) AS mismatched
FROM public.user_week_statuses uws
JOIN public.weeks w ON w.start_date = uws.week_start_date
WHERE uws.season_key IS NOT NULL AND w.season_key IS NOT NULL
  AND uws.season_key <> w.season_key;

-- 3-5. 12-29 주차 uws 가 모두 winter 로 이동했는지
SELECT season_key, count(*) AS rows
FROM public.user_week_statuses
WHERE week_start_date = DATE '2025-12-29'
GROUP BY season_key
ORDER BY season_key NULLS FIRST;

-- 3-6. season_definitions 연속성 — autumn.end +1 = winter.start (true 정상)
SELECT a.end_date AS autumn_end, w.start_date AS winter_start,
       (w.start_date = a.end_date + 1) AS contiguous_ok
FROM public.season_definitions a
JOIN public.season_definitions w ON w.season_key = '2026-winter'
WHERE a.season_key = '2025-autumn';

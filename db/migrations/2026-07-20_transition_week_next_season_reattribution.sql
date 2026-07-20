-- ════════════════════════════════════════════════════════════════════════
-- 2026-07-20_transition_week_next_season_reattribution.sql
-- ════════════════════════════════════════════════════════════════════════
--
-- 정책: 시즌 전환 주차(시즌 사이 1주 브릿지)를 "이전 시즌의 마지막 주차"가 아니라
--       **다음 시즌의 0주차**로 귀속한다.
--         - weeks.season_key / season_id = 다음 시즌
--         - weeks.week_number            = 0
--         - user_week_statuses.season_key = 다음 시즌 (week_number=ISO주차, 불변)
--       season_definitions / seasons 의 공식 시즌 경계(1주차 시작)는 그대로 둔다
--       (봄 종료 06-21 · 여름 1주차 시작 06-29 유지). 전환 주차는 그 사이 gap 에
--       위치한 다음 시즌의 0주차로 들어간다.
--
-- ── 대상(재귀속 전 상태, 2026-07-20 실측) ────────────────────────────────
--   weeks.id  기간                 기존              → 변경
--   0e37c07a  2024-06-24~06-30     2024-spring W17   → 2024-summer W0
--   69723c73  2025-12-22~12-28     2025-autumn W17   → 2026-winter W0
--   92ae6aef  2026-02-23~03-01     2026-winter W9    → 2026-spring W0
--   dd479e91  2026-06-22~06-28     2026-spring W17   → 2026-summer W0   (+ is_official_rest true→false 정정)
--   user_week_statuses: 위 4개 주 시작일 매칭 86행 season_key 이동(7+19+60, 06-22는 0행)
--
--   ※ 참고: 이미 신 모델(다음 시즌 W0)인 전환 주차 2건은 대상이 아니다(그대로 둔다) —
--     2024-spring W0(2024-02-26~03-03, 겨울→봄, uws 2024-spring=12),
--     2024-autumn W0(2024-08-26~09-01, 여름→가을, uws 2024-autumn=7).
--     날짜 기준 전체 전환 주차는 6건이며 그중 신 모델 2건 + 구 모델 4건. 본 SQL 은 구 모델 4건만
--     변환한다(week_number > 정규주수 = 구 모델 식별자). §2-0 가드의 "기대 4건"이 이를 보장.
--
-- ── 스키마 메모 ──────────────────────────────────────────────────────────
--   weeks              : UNIQUE(iso_year, iso_week). (season_key, week_number) 제약 없음.
--                        재귀속은 (iso_year,iso_week) 불변 → 유니크 충돌 없음. week_id 유지
--                        → cluster4_lines(17)·cluster4_line_targets(11) 하위행 재생성 불필요.
--   user_week_statuses : UNIQUE(user_id, year, week_number). week_number=ISO주차(시즌무관)
--                        → season_key 만 갱신, 키 충돌 없음.
--   cluster4_weekly_card_snapshots : user_id 단위 cards JSON. 전환 주차는 날짜(isTransitionWeekStart)
--                        기준으로 카드에서 이미 제외 → 본 재귀속으로 카드 내용/집계 불변(강제 재계산 불필요).
--
-- ── 실행 순서 ────────────────────────────────────────────────────────────
--   §1 (읽기전용 사전확인·백업 미리보기) → §2 (BEGIN~백업~가드~UPDATE~검증~COMMIT/ROLLBACK)
--   → §3 (사후 읽기검증). §2-0 가드가 재실행/이미적용/대상수 불일치를 차단한다(비멱등 1회성).
--   ⚠ §2 의 검증/NOTICE 가 기대와 다르면 COMMIT 대신 ROLLBACK.
-- ════════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════════
-- §1. 사전 확인 (읽기전용) — 실행 후 결과를 캡처해 백업으로 보관
-- ════════════════════════════════════════════════════════════════════════

-- 1-1. 현재 전환 주차 4건(정규 주수 초과분) — 기대 4행
SELECT w.id, w.season_key, w.week_number, w.start_date, w.end_date,
       w.iso_year, w.iso_week, w.is_official_rest, w.holiday_name, w.season_id,
       sd.season_type
FROM public.weeks w
JOIN public.season_definitions sd ON sd.season_key = w.season_key
WHERE w.week_number > CASE sd.season_type
        WHEN 'winter' THEN 8 WHEN 'summer' THEN 8 ELSE 16 END
ORDER BY w.start_date;

-- 1-2. 재귀속 대상 uws(전환 4주의 week_start_date) 현재 season_key 분포 — 기대 86행 요약
SELECT week_start_date, season_key, count(*) AS rows
FROM public.user_week_statuses
WHERE week_start_date IN (DATE '2024-06-24', DATE '2025-12-22',
                          DATE '2026-02-23', DATE '2026-06-22')
GROUP BY week_start_date, season_key
ORDER BY week_start_date, season_key;

-- 1-3. 다음 시즌 정의/시즌행 존재 확인 — 4개 모두 존재해야 함(없으면 §2 중단)
SELECT sd.season_key, sd.season_label, sd.start_date, sd.end_date,
       s.id AS seasons_id
FROM public.season_definitions sd
LEFT JOIN public.seasons s ON s.name = sd.season_label
WHERE sd.season_key IN ('2024-summer','2026-winter','2026-spring','2026-summer')
ORDER BY sd.start_date;

-- 1-4. (season_key, week_number)=(다음시즌, 0) 기존 존재 여부 — 전부 0 이어야 함(충돌 없음)
SELECT season_key, count(*) AS existing_w0
FROM public.weeks
WHERE week_number = 0
  AND season_key IN ('2024-summer','2026-winter','2026-spring','2026-summer')
GROUP BY season_key;

-- 1-5. 전환 주차(06-22~06-28)와 겹치는 활성 공식 휴식 기간 — 전환은 휴식 아님 → 있으면 비활성 대상
SELECT id, name, type, start_date, end_date, is_active
FROM public.official_rest_periods
WHERE is_active = true
  AND start_date <= DATE '2026-06-28' AND end_date >= DATE '2026-06-22';


-- ════════════════════════════════════════════════════════════════════════
-- §2. 데이터 수정 (TRANSACTION)
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── 2-0. 안전 가드 — 선행조건 위배 시 즉시 중단 ──────────────────────────
DO $$
DECLARE
  v_transition_cnt int;
  v_next_missing   int;
  v_w0_collision   int;
BEGIN
  -- (a) 재귀속 대상 전환 주차가 정확히 4건인가(이미 적용됐으면 0 → 중단)
  SELECT count(*) INTO v_transition_cnt
  FROM public.weeks w
  JOIN public.season_definitions sd ON sd.season_key = w.season_key
  WHERE w.week_number > CASE sd.season_type
          WHEN 'winter' THEN 8 WHEN 'summer' THEN 8 ELSE 16 END;
  IF v_transition_cnt <> 4 THEN
    RAISE EXCEPTION '중단: 전환 주차 대상 기대 4건, 실제 %건(이미 적용/데이터 변동). ROLLBACK 하세요.', v_transition_cnt;
  END IF;

  -- (b) 다음 시즌 정의+seasons 행이 4개 모두 존재하는가
  SELECT count(*) INTO v_next_missing
  FROM (VALUES ('2024-summer'),('2026-winter'),('2026-spring'),('2026-summer')) AS x(k)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.season_definitions sd
    JOIN public.seasons s ON s.name = sd.season_label
    WHERE sd.season_key = x.k);
  IF v_next_missing > 0 THEN
    RAISE EXCEPTION '중단: 다음 시즌 정의/seasons 행 누락 %건. 먼저 시즌을 등록하세요.', v_next_missing;
  END IF;

  -- (c) 다음 시즌에 이미 week_number=0 이 있는가(충돌)
  SELECT count(*) INTO v_w0_collision
  FROM public.weeks
  WHERE week_number = 0
    AND season_key IN ('2024-summer','2026-winter','2026-spring','2026-summer');
  IF v_w0_collision > 0 THEN
    RAISE EXCEPTION '중단: 대상 다음 시즌에 이미 0주차 %건 존재(중복). 원인 확인 후 수동 병합.', v_w0_collision;
  END IF;
END $$;

-- ── 2-1. 백업 — 원본 행을 백업 테이블로 보존(롤백/감사용) ──────────────────
CREATE TABLE IF NOT EXISTS public._backup_transition_weeks_20260720 AS
SELECT w.* FROM public.weeks w
JOIN public.season_definitions sd ON sd.season_key = w.season_key
WHERE w.week_number > CASE sd.season_type
        WHEN 'winter' THEN 8 WHEN 'summer' THEN 8 ELSE 16 END;

CREATE TABLE IF NOT EXISTS public._backup_transition_uws_20260720 AS
SELECT * FROM public.user_week_statuses
WHERE week_start_date IN (DATE '2024-06-24', DATE '2025-12-22',
                          DATE '2026-02-23', DATE '2026-06-22');

-- ── 2-2. 전환 주차 → 다음 시즌 0주차 재귀속 (매핑 CTE) ────────────────────
WITH tgt AS (
  SELECT w.id,
         split_part(w.season_key,'-',1)::int AS yr,
         split_part(w.season_key,'-',2)      AS typ
  FROM public.weeks w
  JOIN public.season_definitions sd ON sd.season_key = w.season_key
  WHERE w.week_number > CASE sd.season_type
          WHEN 'winter' THEN 8 WHEN 'summer' THEN 8 ELSE 16 END
),
mapped AS (
  SELECT id,
         CASE typ
           WHEN 'winter' THEN yr       || '-spring'
           WHEN 'spring' THEN yr       || '-summer'
           WHEN 'summer' THEN yr       || '-autumn'
           WHEN 'autumn' THEN (yr + 1) || '-winter'
         END AS next_key
  FROM tgt
)
UPDATE public.weeks w
   SET season_key      = m.next_key,
       season_id       = s.id,
       week_number     = 0,
       is_official_rest = false,   -- 전환 주차는 공식 휴식 아님(06-22 anomaly 정정 포함)
       updated_at      = now()
FROM mapped m
JOIN public.season_definitions sd2 ON sd2.season_key = m.next_key
JOIN public.seasons s               ON s.name = sd2.season_label
WHERE w.id = m.id;

-- ── 2-3. user_week_statuses.season_key → 다음 시즌 (week_start_date 매칭) ──
WITH map(week_start_date, next_key) AS (
  VALUES (DATE '2024-06-24', '2024-summer'),
         (DATE '2025-12-22', '2026-winter'),
         (DATE '2026-02-23', '2026-spring'),
         (DATE '2026-06-22', '2026-summer')
)
UPDATE public.user_week_statuses uws
   SET season_key = m.next_key,
       updated_at = now()
FROM map m
WHERE uws.week_start_date = m.week_start_date
  AND uws.season_key IS DISTINCT FROM m.next_key;

-- ── 2-4. 전환 주(06-22~06-28)와 겹치는 활성 공식 휴식 기간 비활성화 ────────
--   전환 주차는 공식 휴식이 아니다. 06-22 행 등록 시 잘못 생성됐을 수 있는 period 를 끈다.
--   (다른 주차와 겹치지 않는, 이 전환 주 전용 기간만 대상 — 정확 경계 일치로 한정.)
UPDATE public.official_rest_periods
   SET is_active = false, updated_at = now()
WHERE is_active = true
  AND start_date = DATE '2026-06-22' AND end_date = DATE '2026-06-28';

-- ── 2-5. resolve_season_key(date) 재정의 — 전환 주차 우선 판정 ─────────────
--   판정 순서(요구사항):
--     1) 등록된 전환 주차(weeks.week_number = 0)에 날짜가 포함되면 그 주차의 season_key(다음 시즌)
--     2) season_definitions 범위 안이면 해당 시즌
--     3) (방어) 그 외 gap → 직전 시즌 (전환은 1)에서 처리되므로 정상 데이터에선 발생 안 함)
--   → 더 이상 전환 주차 날짜를 "이전 시즌"으로 반환하지 않는다.
CREATE OR REPLACE FUNCTION public.resolve_season_key(p_date date)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_key text;
BEGIN
  -- 1) 등록된 전환 주차(week_number = 0) — weeks 를 SoT 로 사용(날짜 추측 금지)
  SELECT season_key INTO v_key
  FROM public.weeks
  WHERE week_number = 0
    AND p_date >= start_date AND p_date <= end_date
  ORDER BY start_date
  LIMIT 1;
  IF v_key IS NOT NULL THEN RETURN v_key; END IF;

  -- 2) season_definitions 범위
  SELECT season_key INTO v_key
  FROM public.season_definitions
  WHERE p_date >= start_date AND p_date <= end_date
  ORDER BY start_date
  LIMIT 1;
  IF v_key IS NOT NULL THEN RETURN v_key; END IF;

  -- 3) 방어적 폴백 — 직전 시즌(등록 안 된 gap 등). 전환 주차는 1)에서 처리됨.
  SELECT season_key INTO v_key
  FROM public.season_definitions
  WHERE end_date < p_date
  ORDER BY end_date DESC
  LIMIT 1;
  RETURN v_key;
END;
$$;
GRANT EXECUTE ON FUNCTION public.resolve_season_key(date) TO anon, authenticated;

-- ── 2-6. 트랜잭션 내 최종 검증 (COMMIT 전) ────────────────────────────────
-- 2-6-a. 전환 4주가 다음 시즌 0주차로 이동했는가 (기대 4행, 전부 week_number=0)
SELECT id, season_key, week_number, start_date, end_date, is_official_rest
FROM public.weeks
WHERE id IN (SELECT id FROM public._backup_transition_weeks_20260720)
ORDER BY start_date;
--   기대:
--     2024-06-24 → 2024-summer / 0 / is_official_rest=false
--     2025-12-22 → 2026-winter / 0 / false
--     2026-02-23 → 2026-spring / 0 / false
--     2026-06-28 종료행(06-22) → 2026-summer / 0 / false

-- 2-6-b. 이전 시즌에 전환 주차가 남아있지 않은가 (정규 주수 초과분 0건)
SELECT w.season_key, max(w.week_number) AS max_week
FROM public.weeks w
JOIN public.season_definitions sd ON sd.season_key = w.season_key
GROUP BY w.season_key, sd.season_type
HAVING max(w.week_number) > CASE sd.season_type
         WHEN 'winter' THEN 8 WHEN 'summer' THEN 8 ELSE 16 END;
--   기대: 0행 (봄=16, 겨울=8 이 최대. 17/9 없음)

-- 2-6-c. (season_key, week_number) 의미 중복 0건
SELECT season_key, week_number, count(*) AS dup
FROM public.weeks
WHERE season_key IS NOT NULL AND week_number IS NOT NULL
GROUP BY season_key, week_number
HAVING count(*) > 1;
--   기대: 0행

-- 2-6-d. uws season_key 이동 결과 (기대: 각 다음 시즌으로)
SELECT week_start_date, season_key, count(*) AS rows
FROM public.user_week_statuses
WHERE week_start_date IN (DATE '2024-06-24', DATE '2025-12-22',
                          DATE '2026-02-23', DATE '2026-06-22')
GROUP BY week_start_date, season_key
ORDER BY week_start_date;
--   기대: 2024-06-24→2024-summer(7), 2025-12-22→2026-winter(19), 2026-02-23→2026-spring(60)

-- 2-6-e. resolve_season_key 가 전환 날짜를 다음 시즌으로 반환하는가
SELECT d AS test_date, public.resolve_season_key(d) AS resolved
FROM (VALUES (DATE '2026-06-22'),(DATE '2026-06-28'),  -- → 2026-summer
             (DATE '2026-06-21'),                       -- → 2026-spring (경계 유지)
             (DATE '2026-06-29'),                       -- → 2026-summer (1주차 시작)
             (DATE '2026-02-23'),                       -- → 2026-spring
             (DATE '2025-12-22')) AS t(d);              -- → 2026-winter

-- ✅ 위 기대값과 일치하면 COMMIT, 아니면 ROLLBACK:
COMMIT;
-- ROLLBACK;


-- ════════════════════════════════════════════════════════════════════════
-- §3. 사후 검증 (읽기전용) — COMMIT 후
-- ════════════════════════════════════════════════════════════════════════

-- 3-1. weeks ↔ uws 귀속 일관성 (시즌 불일치 0건 정상)
SELECT count(*) AS mismatched
FROM public.user_week_statuses uws
JOIN public.weeks w ON w.start_date = uws.week_start_date
WHERE uws.season_key IS NOT NULL AND w.season_key IS NOT NULL
  AND uws.season_key <> w.season_key;

-- 3-2. 전환 4주 최종 스냅샷
SELECT id, season_key, week_number, start_date, end_date, is_official_rest, iso_year, iso_week
FROM public.weeks
WHERE id IN (SELECT id FROM public._backup_transition_weeks_20260720)
ORDER BY start_date;

-- 3-3. 백업 테이블 보존 확인(롤백 시 원본 복원 소스)
SELECT 'weeks' AS tbl, count(*) FROM public._backup_transition_weeks_20260720
UNION ALL
SELECT 'uws', count(*) FROM public._backup_transition_uws_20260720;


-- ════════════════════════════════════════════════════════════════════════
-- §4. 롤백 절차 (필요 시 — COMMIT 이후 되돌리기)
-- ════════════════════════════════════════════════════════════════════════
--   BEGIN;
--     UPDATE public.weeks w SET
--       season_key = b.season_key, season_id = b.season_id,
--       week_number = b.week_number, is_official_rest = b.is_official_rest,
--       updated_at = now()
--     FROM public._backup_transition_weeks_20260720 b WHERE w.id = b.id;
--
--     UPDATE public.user_week_statuses uws SET
--       season_key = b.season_key, updated_at = now()
--     FROM public._backup_transition_uws_20260720 b WHERE uws.id = b.id;
--
--     -- resolve_season_key 는 2026-05-25_week_season_key_attribution.sql 의 정의로 되돌린다.
--   COMMIT;
--   -- 확인 후 백업 테이블 정리: DROP TABLE public._backup_transition_weeks_20260720,
--   --                                    public._backup_transition_uws_20260720;

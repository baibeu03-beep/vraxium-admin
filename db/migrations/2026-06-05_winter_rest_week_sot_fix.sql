-- ════════════════════════════════════════════════════════════════════════
-- 2026-06-05_winter_rest_week_sot_fix.sql
-- ════════════════════════════════════════════════════════════════════════
--
-- 2026-winter 휴식주 legacy 데이터 정정 — W5/W8 역전 해소.
--   ※ 데이터 전용(스키마 변경 없음). scripts/apply-winter-rest-week-sot-fix.mjs
--     로 적용 가능하며, 이 파일은 동일 변경의 SQL 기록 + 수동 적용 경로다.
--
-- ── 확정 원인 ────────────────────────────────────────────────────────────
--   2025년 설(1월 말 = ISO 5주차) 패턴이 2026-winter 에 그대로 시드되어
--   weeks.is_official_rest 가 W5(01-26~02-01)=true 로 잘못 기록됨.
--   실제 2026년 설은 2/17 → 휴식주 = W8(02-16~02-22).
--   official_rest_weeks(2026, 5) 도 동일 패턴의 stale 행.
--
--   판정 SoT(신규)는 이미 season_rule ∨ official_rest_periods 로 통일되어
--   uws·weekly-card snapshot 은 정답(W5=성장, W8=공식휴식)을 기록 중이다.
--   (운영 실측 2026-06-05: W5 uws=success 27/fail 3, W8 uws=official_rest 51,
--    snapshot 카드도 동일. 전원 테스터, 실유저 영향 0.)
--   따라서 본 정정은 legacy 표시 컬럼만 손대며 uws/snapshot 재계산이 필요 없다.
--
-- ── 확정 값 ──────────────────────────────────────────────────────────────
--   - 2026-winter W5 (2026-01-26~02-01) = 정상주   [is_official_rest true → false]
--   - 2026-winter W8 (2026-02-16~02-22) = 공식 휴식 [is_official_rest false → true]
--   - W9 (02-23~03-01) = 전환주 [불변 — week_number > 8 파생 판정]
--   - official_rest_weeks (2026, 5) → (2026, 8)  '설 연휴'
--   - official_rest_periods '2026 설 연휴' 02-16~02-22 active = 이미 정답 [불변]
--
-- ── 실행 순서 ────────────────────────────────────────────────────────────
--   §1 (읽기전용 사전확인) → §2 (BEGIN~가드~검증~COMMIT) → §3 (사후 읽기검증)
--   ※ §2-0 가드가 재실행·이미적용 상태를 차단한다(비멱등 1회성).
-- ════════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════════
-- §1. 사전 확인 (읽기전용)
-- ════════════════════════════════════════════════════════════════════════

-- 1-1. 대상 weeks 행 — W5=true/'설 연휴', W8=false/NULL 예상
SELECT week_number, start_date, end_date, is_official_rest, holiday_name
FROM public.weeks
WHERE season_key = '2026-winter' AND week_number IN (5, 8)
ORDER BY week_number;

-- 1-2. official_rest_weeks stale 행 — (2026, 5) '설 연휴' 1건 예상, (2026, 8) 0건 예상
SELECT id, year, week_number, reason
FROM public.official_rest_weeks
WHERE year = 2026
ORDER BY week_number;

-- 1-3. official_rest_periods — '2026 설 연휴' 02-16~02-22 active 1건 예상 (불변 확인용)
SELECT name, type, start_date, end_date, is_active
FROM public.official_rest_periods
WHERE start_date <= DATE '2026-02-22' AND end_date >= DATE '2026-02-16';

-- 1-4. uws 가 이미 정답인지 — W5: success/fail 만, W8: official_rest 만 예상
SELECT week_start_date, status, count(*)
FROM public.user_week_statuses
WHERE week_start_date IN (DATE '2026-01-26', DATE '2026-02-16')
GROUP BY week_start_date, status
ORDER BY week_start_date, status;


-- ════════════════════════════════════════════════════════════════════════
-- §2. 데이터 수정 (TRANSACTION)
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── 2-0. 안전 가드 — 선행조건 위배 시 즉시 중단 ──────────────────────────
DO $$
DECLARE
  v_w5_rest boolean;
  v_w8_rest boolean;
  v_orw_2026_8 int;
BEGIN
  SELECT is_official_rest INTO v_w5_rest
  FROM public.weeks WHERE season_key = '2026-winter' AND week_number = 5;
  SELECT is_official_rest INTO v_w8_rest
  FROM public.weeks WHERE season_key = '2026-winter' AND week_number = 8;
  IF v_w5_rest IS DISTINCT FROM true OR v_w8_rest IS DISTINCT FROM false THEN
    RAISE EXCEPTION '중단: W5/W8 현재값 기대(true/false)와 다름(%/%) — 이미 적용되었거나 수동 점검 필요.',
      v_w5_rest, v_w8_rest;
  END IF;

  SELECT count(*) INTO v_orw_2026_8
  FROM public.official_rest_weeks WHERE year = 2026 AND week_number = 8;
  IF v_orw_2026_8 > 0 THEN
    RAISE EXCEPTION '중단: official_rest_weeks(2026, 8) 이미 존재(%건) — UNIQUE 충돌 위험.', v_orw_2026_8;
  END IF;
END $$;

-- ── 2-1. weeks W5: 정상주로 정정 ─────────────────────────────────────────
UPDATE public.weeks
   SET is_official_rest = false,
       holiday_name = NULL,
       updated_at = now()
 WHERE season_key = '2026-winter' AND week_number = 5;

-- ── 2-2. weeks W8: 공식 휴식주로 정정 ────────────────────────────────────
UPDATE public.weeks
   SET is_official_rest = true,
       holiday_name = '설 연휴',
       updated_at = now()
 WHERE season_key = '2026-winter' AND week_number = 8;

-- ── 2-3. official_rest_weeks: (2026, 5) → (2026, 8) ──────────────────────
UPDATE public.official_rest_weeks
   SET week_number = 8
 WHERE year = 2026 AND week_number = 5;

-- ── 2-4. 트랜잭션 내 최종 검증 (COMMIT 전) ────────────────────────────────
-- 기대: W5 false/NULL, W8 true/'설 연휴'
SELECT week_number, is_official_rest, holiday_name
FROM public.weeks
WHERE season_key = '2026-winter' AND week_number IN (5, 8)
ORDER BY week_number;

-- 기대: (2026, 8) '설 연휴' 1건, (2026, 5) 0건
SELECT year, week_number, reason FROM public.official_rest_weeks WHERE year = 2026;

-- ✅ 기대값과 일치하면 COMMIT, 아니면 ROLLBACK:
COMMIT;
-- ROLLBACK;


-- ════════════════════════════════════════════════════════════════════════
-- §3. 사후 검증 (읽기전용) — COMMIT 후
-- ════════════════════════════════════════════════════════════════════════

-- 3-1. winter 전체 주차 — 휴식 플래그는 W8 단 1건 예상
SELECT week_number, start_date, end_date, is_official_rest, holiday_name
FROM public.weeks
WHERE season_key = '2026-winter'
ORDER BY week_number;

-- 3-2. raw ↔ official_rest_periods 정합 — 불일치 0건 예상 (전 시즌)
--   (봄/가을 시험기간 rule 주차는 is_official_rest 와 periods 둘 다 아닌 경우가
--    있을 수 있으므로 winter 한정 점검)
SELECT w.week_number, w.is_official_rest,
       EXISTS (
         SELECT 1 FROM public.official_rest_periods p
         WHERE p.is_active
           AND p.start_date <= w.end_date
           AND p.end_date >= w.start_date
       ) AS period_rest
FROM public.weeks w
WHERE w.season_key = '2026-winter'
  AND w.is_official_rest <> EXISTS (
        SELECT 1 FROM public.official_rest_periods p
        WHERE p.is_active
          AND p.start_date <= w.end_date
          AND p.end_date >= w.start_date
      );

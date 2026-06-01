-- ════════════════════════════════════════════════════════════════════════
-- 2026-06-01_season_key_null_backfill.DRAFT.sql
-- ════════════════════════════════════════════════════════════════════════
--
-- ⚠️⚠️ DRAFT — 아직 실행하지 마세요. 검토용 초안입니다. ⚠️⚠️
--
-- ⛔ 실행 보류 / 현재 DB 기준 적용 대상 없음 (2026-06-01 점검).
--    연결된 DB 점검 결과 다음이 모두 0건이라 이 백필은 no-op:
--      - user_week_statuses.season_key NULL = 0
--      - weeks.season_key NULL              = 0
--      - weeks.week_number NULL             = 0
--    operation-health-check 재실행에서도 season_key_mismatch_count = 0,
--    week_mapping_mismatch_count = 0 으로 확인됨.
--    → 정식 migration 으로 승격하지 않고 DRAFT(보류) 상태로 유지한다.
--      NULL 이 실재하는 환경에서만, 검토 노트(ISO-join + 모호성/롤백)대로 재검증 후 실행.
--
-- 목적:
--   weeks.season_key / user_week_statuses.season_key 의 NULL 정합성 복구 +
--   "전환 주차(시즌 사이 gap 주차)" 정책 확정에 따른 week_number 보정.
--
-- ── 확정된 전환 주차 정책 ────────────────────────────────────────────────
--   1) 시즌과 시즌 사이 gap 주차 = "전환 주차".
--   2) season_key = 앞(직전) 시즌에 귀속  → resolve_season_key(start_date) 규칙 #2 와 동일.
--   3) week_number = 앞 시즌의 마지막 주차 번호(max) + 순번(같은 시즌 내 전환주차를
--      start_date 오름차순으로 1,2,3…).
--   예) 가을→겨울 전환 주차는 autumn 에 귀속, autumn 마지막이 16주차면 17·18주차.
--
-- 배경(조사 결과):
--   - season_definitions canonical 재시드(DELETE→재INSERT) 시 FK(ON DELETE SET NULL)로
--     season_key 가 NULL 로 떨어졌고, 일회성 backfill 이 재실행되지 않아 잔존.
--   - weeks: 36행 중 3행 NULL (모두 전환 주차):
--       2025-12-22(w52), 2025-12-29(w1) → 2025-autumn (마지막 16 → 17,18)
--       2026-02-23(w9)                  → 2026-winter (마지막  7 →  8)
--   - user_week_statuses: NULL 다수(조사 시 ~912건, 정확 수치는 §1 사전 카운트로 확정).
--
-- 스키마 메모:
--   - user_week_statuses 에는 week_id 컬럼이 없음 → week_start_date 기준 귀속.
--   - user_week_statuses.week_number 는 NOT NULL CHECK(1..53) = "달력(ISO) 주차".
--     weeks.week_number 는 "시즌 상대 주차(1..17)" 로 의미가 다름(§4 참고).
--   - weeks / uws 모두 동일 함수(resolve_season_key)로 귀속 → 일관성 보장.
--
-- 실행 순서 권장:
--   §0(전제) → §1(사전 카운트·미리보기, 읽기전용) → §2(BEGIN~검증~COMMIT)
--   → §3(사후 검증, 읽기전용). §2 의 NOTICE 가 예상과 다르면 COMMIT 대신 ROLLBACK.
-- ════════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════════
-- §0. 전제 점검 (읽기전용) — resolve_season_key 함수 존재 확인
-- ════════════════════════════════════════════════════════════════════════
SELECT
  EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'resolve_season_key'
      AND pronamespace = 'public'::regnamespace
  ) AS resolve_season_key_exists;
-- → false 이면 week_season_key_attribution.sql 의 함수 정의 선행 필요.


-- ════════════════════════════════════════════════════════════════════════
-- §1. 사전 카운트·미리보기 — 변경 대상/결과를 실행 전에 확인 (읽기전용)
-- ════════════════════════════════════════════════════════════════════════

-- 1-1. weeks: NULL 건수 + 귀속 가능 여부
SELECT
  count(*)                                                  AS weeks_null_total,
  count(*) FILTER (WHERE start_date IS NOT NULL)            AS weeks_null_with_date,
  count(*) FILTER (
    WHERE start_date IS NOT NULL
      AND public.resolve_season_key(start_date) IS NOT NULL
  )                                                          AS weeks_resolvable,
  count(*) FILTER (
    WHERE start_date IS NOT NULL
      AND public.resolve_season_key(start_date) IS NULL
  )                                                          AS weeks_unresolvable
FROM public.weeks
WHERE season_key IS NULL;

-- 1-2. weeks: 전환 주차 각 행에 부여될 season_key + week_number 미리보기
--      (정책: max(앞 시즌 week_number) + start_date 순번)
WITH bases AS (
  SELECT season_key, max(week_number) AS base_max
  FROM public.weeks
  WHERE week_number IS NOT NULL
  GROUP BY season_key
),
targets AS (
  SELECT
    w.id, w.start_date, w.end_date,
    public.resolve_season_key(w.start_date) AS will_season_key,
    row_number() OVER (
      PARTITION BY public.resolve_season_key(w.start_date)
      ORDER BY w.start_date
    ) AS seq
  FROM public.weeks w
  WHERE w.season_key IS NULL
    AND w.start_date IS NOT NULL
    AND public.resolve_season_key(w.start_date) IS NOT NULL
)
SELECT
  t.id, t.start_date, t.end_date,
  t.will_season_key,
  COALESCE(b.base_max, 0)            AS season_last_week_number,
  COALESCE(b.base_max, 0) + t.seq    AS will_week_number
FROM targets t
LEFT JOIN bases b ON b.season_key = t.will_season_key
ORDER BY t.will_season_key, t.start_date;

-- 1-3. user_week_statuses: NULL 건수 + 귀속 가능 여부
SELECT
  count(*)                                                  AS uws_null_total,
  count(*) FILTER (WHERE week_start_date IS NOT NULL)       AS uws_null_with_date,
  count(*) FILTER (
    WHERE week_start_date IS NOT NULL
      AND public.resolve_season_key(week_start_date) IS NOT NULL
  )                                                          AS uws_resolvable,
  count(*) FILTER (
    WHERE week_start_date IS NOT NULL
      AND public.resolve_season_key(week_start_date) IS NULL
  )                                                          AS uws_unresolvable
FROM public.user_week_statuses
WHERE season_key IS NULL;

-- 1-4. user_week_statuses: 귀속될 시즌별 분포 미리보기
SELECT
  public.resolve_season_key(week_start_date) AS will_set_season_key,
  count(*)                                   AS row_count
FROM public.user_week_statuses
WHERE season_key IS NULL
GROUP BY 1
ORDER BY 1 NULLS FIRST;

-- 1-5. (교차검증) uws 와 weeks 가 같은 week_start_date 에 다른 시즌으로 귀속되는지 — 0건 정상
SELECT
  uws.week_start_date,
  public.resolve_season_key(uws.week_start_date) AS uws_resolved,
  w.season_key                                   AS weeks_existing
FROM public.user_week_statuses uws
JOIN public.weeks w ON w.start_date = uws.week_start_date
WHERE w.season_key IS NOT NULL
  AND w.season_key <> public.resolve_season_key(uws.week_start_date)
GROUP BY 1, 2, 3
ORDER BY 1;


-- ════════════════════════════════════════════════════════════════════════
-- §2. 데이터 수정 (TRANSACTION) — 검토 후 COMMIT / 문제 시 ROLLBACK
-- ════════════════════════════════════════════════════════════════════════
-- ⚠ 아래 블록 전체를 한 번에 실행. 마지막 COMMIT 전까지 미확정.
--   순서 중요: (2-1 season_key) → (2-2 week_number) → (2-3 uws). 의존 관계 있음.

BEGIN;

-- ── 2-1. weeks.season_key 채우기 (전환 주차 = 직전 시즌 귀속) ───────────────
WITH updated AS (
  UPDATE public.weeks
     SET season_key = public.resolve_season_key(start_date)
   WHERE season_key IS NULL
     AND start_date IS NOT NULL
     AND public.resolve_season_key(start_date) IS NOT NULL
  RETURNING id
)
SELECT count(*) AS weeks_season_key_updated FROM updated;

DO $$
DECLARE v_remaining int;
BEGIN
  SELECT count(*) INTO v_remaining FROM public.weeks WHERE season_key IS NULL;
  RAISE NOTICE 'weeks: season_key 채운 후 남은 NULL = %', v_remaining;
END $$;

-- ── 2-2. weeks.week_number 보정 (전환 주차 번호 = 앞 시즌 max + 순번) ───────
--   2-1 이후 실행되어야 함(전환 주차에 season_key 가 채워진 상태 전제).
--   base_max 는 week_number 가 이미 있는 정규 주차에서만 계산 → 멱등/안전.
WITH bases AS (
  SELECT season_key, max(week_number) AS base_max
  FROM public.weeks
  WHERE week_number IS NOT NULL
  GROUP BY season_key
),
targets AS (
  SELECT
    w.id,
    w.season_key,
    row_number() OVER (PARTITION BY w.season_key ORDER BY w.start_date) AS seq
  FROM public.weeks w
  WHERE w.week_number IS NULL
    AND w.season_key IS NOT NULL
    AND w.start_date IS NOT NULL
),
upd AS (
  UPDATE public.weeks w
     SET week_number = (COALESCE(b.base_max, 0) + t.seq)::smallint
    FROM targets t
    LEFT JOIN bases b ON b.season_key = t.season_key
   WHERE w.id = t.id
  RETURNING w.id
)
SELECT count(*) AS weeks_week_number_updated FROM upd;

DO $$
DECLARE v_remaining int;
BEGIN
  SELECT count(*) INTO v_remaining
  FROM public.weeks WHERE week_number IS NULL AND season_key IS NOT NULL;
  RAISE NOTICE 'weeks: week_number 보정 후 (season_key 有 & week_number NULL) = %', v_remaining;
END $$;

-- ── 2-3. user_week_statuses.season_key 채우기 (동일 기준) ─────────────────
UPDATE public.user_week_statuses
   SET season_key = public.resolve_season_key(week_start_date),
       updated_at = now()
 WHERE season_key IS NULL
   AND week_start_date IS NOT NULL
   AND public.resolve_season_key(week_start_date) IS NOT NULL;

DO $$
DECLARE v_remaining int;
BEGIN
  SELECT count(*) INTO v_remaining FROM public.user_week_statuses WHERE season_key IS NULL;
  RAISE NOTICE 'user_week_statuses: season_key 채운 후 남은 NULL = %', v_remaining;
END $$;

-- ── 2-4. 트랜잭션 내 최종 검증 (COMMIT 전) ────────────────────────────────
-- 2-4-a. weeks 시즌별 분포 + 전환 주차(정규 주수 초과분) 확인
SELECT season_key, count(*) AS weeks,
       min(week_number) AS min_wk, max(week_number) AS max_wk
FROM public.weeks
GROUP BY season_key
ORDER BY season_key NULLS FIRST;

-- 2-4-b. 방금 번호가 부여된 전환 주차 목록(시즌 범위 밖 = start_date > season.end_date)
SELECT w.season_key, w.week_number, w.start_date, w.end_date,
       sd.end_date AS season_end_date
FROM public.weeks w
JOIN public.season_definitions sd ON sd.season_key = w.season_key
WHERE w.start_date > sd.end_date
ORDER BY w.start_date;

-- ✅ 위 결과가 예상과 일치하면 COMMIT, 아니면 ROLLBACK.
COMMIT;
-- ROLLBACK;


-- ════════════════════════════════════════════════════════════════════════
-- §3. 사후 검증 (읽기전용) — COMMIT 후 실행
-- ════════════════════════════════════════════════════════════════════════

-- 3-1. NULL 잔존 총괄
SELECT 'weeks.season_key' AS metric,
       count(*) FILTER (WHERE season_key IS NULL) AS null_remaining, count(*) AS total
FROM public.weeks
UNION ALL
SELECT 'weeks.week_number(season_key有)',
       count(*) FILTER (WHERE week_number IS NULL AND season_key IS NOT NULL), count(*)
FROM public.weeks
UNION ALL
SELECT 'user_week_statuses.season_key',
       count(*) FILTER (WHERE season_key IS NULL), count(*)
FROM public.user_week_statuses;

-- 3-2. FK 무결성 — season_key 가 season_definitions 에 모두 존재(고아 0 정상)
SELECT 'weeks' AS tbl, count(*) AS orphan_season_key
FROM public.weeks w
LEFT JOIN public.season_definitions sd ON sd.season_key = w.season_key
WHERE w.season_key IS NOT NULL AND sd.season_key IS NULL
UNION ALL
SELECT 'user_week_statuses', count(*)
FROM public.user_week_statuses uws
LEFT JOIN public.season_definitions sd ON sd.season_key = uws.season_key
WHERE uws.season_key IS NOT NULL AND sd.season_key IS NULL;

-- 3-3. 전환 주차 week_number 중복 점검 — 같은 시즌 내 (season_key, week_number) 유일해야 정상
SELECT season_key, week_number, count(*) AS dup
FROM public.weeks
WHERE season_key IS NOT NULL AND week_number IS NOT NULL
GROUP BY season_key, week_number
HAVING count(*) > 1
ORDER BY season_key, week_number;

-- 3-4. weeks ↔ uws 귀속 일관성 — 같은 week_start_date 시즌 불일치 0건 정상
SELECT count(*) AS mismatched_attribution
FROM public.user_week_statuses uws
JOIN public.weeks w ON w.start_date = uws.week_start_date
WHERE uws.season_key IS NOT NULL AND w.season_key IS NOT NULL
  AND uws.season_key <> w.season_key;


-- ════════════════════════════════════════════════════════════════════════
-- §4. (요구 4) user_week_statuses.week_number NULL 보정 — "제안만"
-- ════════════════════════════════════════════════════════════════════════
-- 결론: 현재 스키마상 user_week_statuses.week_number 는 NOT NULL CHECK(1..53) 이라
--       NULL 자체가 존재할 수 없음. 아래 탐지 쿼리는 항상 0 이어야 함.
SELECT count(*) AS uws_week_number_null
FROM public.user_week_statuses
WHERE week_number IS NULL;
--
-- ⚠ 더 중요한 의미 차이(보정 제안의 본질):
--   uws.week_number = 달력(ISO) 주차(예: 2026w9 → 9),
--   weeks.week_number = 시즌 상대 주차(예: 2026-winter 8주차).
--   두 값은 체계가 달라 단순 복사하면 의미가 깨짐. 따라서 "weeks.week_start_date 기준
--   복사"는 권장하지 않음. 만약 uws 에 '시즌 상대 주차'가 별도로 필요하다면
--   새 컬럼(uws.season_week_number) 추가 후 weeks 와 JOIN 하여 채우는 방식을 제안.
--
-- (제안 전용, 실행 금지) 예시 — 신규 컬럼을 둘 경우:
--   ALTER TABLE public.user_week_statuses ADD COLUMN IF NOT EXISTS season_week_number smallint;
--   UPDATE public.user_week_statuses uws
--      SET season_week_number = w.week_number
--     FROM public.weeks w
--    WHERE w.start_date = uws.week_start_date
--      AND uws.season_week_number IS NULL;
--   -- weeks row 가 없는 날짜(예: 2025-09-01·09-08·09-15)는 NULL 로 남음 → 별도 검토.


-- ════════════════════════════════════════════════════════════════════════
-- §5. (요구 7) season-weeks 화면 "전환 주차" 구분 표시 — API/UI 필드 제안
-- ════════════════════════════════════════════════════════════════════════
-- 권장안 A (스키마 변경 없음 · 파생): 전환 주차 = 주차 시작일이 귀속 시즌 범위 밖.
--   조건:  weeks.start_date > season_definitions.end_date   (= gap 에 위치)
--   - API(app/api/admin/season-weeks/route.ts): SeasonWeekDto 에 is_transition:boolean 추가.
--       const isTransition = !!(week.start_date && season.end_date
--                               && week.start_date > season.end_date);
--   - UI(components/admin/SeasonWeeksTable.tsx): is_transition 이면 "전환 주차" 뱃지 표시,
--       week_label 을 "{n}주차 · 전환" 형태로.
--   장점: 마이그레이션 불필요, 단일 판정식, 과거/미래 전환 주차 자동 인식.
--
--   (검증용) 파생식으로 잡히는 전환 주차 목록:
--   SELECT w.season_key, w.week_number, w.start_date
--   FROM public.weeks w
--   JOIN public.season_definitions sd ON sd.season_key = w.season_key
--   WHERE w.start_date > sd.end_date
--   ORDER BY w.start_date;
--
-- 대안 B (명시 컬럼 · 영속화가 필요할 때):
--   ALTER TABLE public.weeks ADD COLUMN IF NOT EXISTS is_transition boolean NOT NULL DEFAULT false;
--   UPDATE public.weeks w
--      SET is_transition = true
--     FROM public.season_definitions sd
--    WHERE sd.season_key = w.season_key AND w.start_date > sd.end_date;
--   - API 는 컬럼을 그대로 select, UI 동일. 장점: 수동 지정/예외 케이스 표현 가능.
--   - 단점: 컬럼 추가 + 재시드/번호변경 시 재계산 필요.
--
--   ※ 권장: 우선 A(파생)로 화면 표시부터 적용, 영속 플래그가 꼭 필요할 때 B 로 승격.

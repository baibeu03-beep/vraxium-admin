-- ════════════════════════════════════════════════════════════════════════
-- 2026-06-02_cluster4_lines_period_label_backfill.sql
-- ════════════════════════════════════════════════════════════════════════
--
-- 목적:
--   cluster4_lines.period_label 표기를 "{YY} {시즌명} {N}주차" 로 통일한다.
--   (예: "2025-W52" / "2026-W03"(ISO) · "25 가을 11주차"(직접입력) 혼재 → 정규화)
--
--   생성 기준(SoT) — week_id → weeks 조인 후:
--     - YY     : weeks.iso_year 의 끝 2자리         (2026 → "26")
--     - 시즌명 : weeks.season_key 의 시즌 suffix → 한글 (winter→겨울 …)
--     - N      : weeks.week_number (시즌 상대 주차 — SoT)
--   ⛔ start_date 기반 자체 계산 금지. 직접 입력값(Excel 셀)·ISO 표기도 신뢰하지 않는다.
--   (lib/cluster4PeriodLabel.ts 의 resolvePeriodLabelFromWeek 와 동일 규칙.)
--
-- 예시:
--   2025-autumn week 7  → "25 가을 7주차"
--   2026-winter week 5  → "26 겨울 5주차"
--   2026-spring week 12 → "26 봄 12주차"
--
-- 대상:
--   week_id 가 있고 weeks.iso_year / season_key / week_number 가 모두 존재하는 행.
--   (현재 period_label 을 가진 행은 모두 excel_import info 라인이며 week_id 보유.
--    admin 수기 생성 라인은 week_id 가 NULL → 대상 아님, period_label NULL 유지.)
--
-- ⚠ 멱등(idempotent): 같은 입력이면 같은 결과 → 여러 번 실행해도 무해.
-- 의존성: weeks(iso_year, season_key, week_number), cluster4_lines(week_id, period_label).
--          DB 컬럼 추가/삭제 없음 — 기존 컬럼 값만 갱신한다(컬럼 삭제는 보류).
--
-- ── 사전 점검(읽기전용, 실행 전 권장) ──────────────────────────────────────
--   -- (a) 현재 표기 분포 (ISO/직접입력 혼재 확인)
--   SELECT period_label, count(*) FROM public.cluster4_lines
--   WHERE period_label IS NOT NULL GROUP BY period_label ORDER BY count(*) DESC;
--   -- (b) week_id 는 있으나 iso_year/season_key/week_number 가 비어 백필 불가한 행 (0 기대)
--   SELECT count(*) FROM public.cluster4_lines l JOIN public.weeks w ON w.id = l.week_id
--   WHERE l.week_id IS NOT NULL
--     AND (w.iso_year IS NULL OR w.season_key IS NULL OR w.week_number IS NULL);
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

UPDATE public.cluster4_lines AS l
SET period_label =
      right(w.iso_year::text, 2)                            -- YY (iso_year SoT)
      || ' '
      || CASE lower(split_part(w.season_key, '-', 2))       -- 시즌명(한글)
           WHEN 'spring' THEN '봄'
           WHEN 'summer' THEN '여름'
           WHEN 'autumn' THEN '가을'
           WHEN 'fall'   THEN '가을'
           WHEN 'winter' THEN '겨울'
           ELSE split_part(w.season_key, '-', 2)
         END
      || ' '
      || w.week_number::text || '주차'                       -- N주차 (week_number SoT)
FROM public.weeks AS w
WHERE l.week_id = w.id
  AND w.iso_year IS NOT NULL
  AND w.season_key IS NOT NULL
  AND w.week_number IS NOT NULL
  -- 멱등 가드: 이미 정규 표기와 동일하면 갱신 생략.
  AND l.period_label IS DISTINCT FROM (
      right(w.iso_year::text, 2) || ' '
      || CASE lower(split_part(w.season_key, '-', 2))
           WHEN 'spring' THEN '봄'
           WHEN 'summer' THEN '여름'
           WHEN 'autumn' THEN '가을'
           WHEN 'fall'   THEN '가을'
           WHEN 'winter' THEN '겨울'
           ELSE split_part(w.season_key, '-', 2)
         END
      || ' ' || w.week_number::text || '주차'
  );

COMMIT;

-- ── 사후 검증(읽기전용, 실행 후 권장) ─────────────────────────────────────
--   -- (1) ISO 표기("YYYY-Wnn")가 남아있지 않은지 (0 기대)
--   SELECT count(*) FROM public.cluster4_lines WHERE period_label ~ '^\d{4}-W\d{2}$';
--   -- (2) 정규 표기 수렴 샘플 확인
--   SELECT l.period_label, w.iso_year, w.season_key, w.week_number
--   FROM public.cluster4_lines l JOIN public.weeks w ON w.id = l.week_id
--   WHERE l.period_label IS NOT NULL ORDER BY w.start_date DESC LIMIT 20;

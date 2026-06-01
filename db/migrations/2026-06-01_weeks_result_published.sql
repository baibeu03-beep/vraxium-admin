-- 2026-06-01_weeks_result_published.sql
-- 주차 결과 집계/공표 완료 시점을 weeks 단위로 기록하는 result_published_at 컬럼 추가.
--   - NULL  → 해당 주차는 아직 집계/공표 미완료 → 고객 카드에서 "성장(집계 중)"(tallying) 으로 표시.
--   - 값 존재 → 집계/공표 완료 → user_week_statuses.status 기준으로 성장(성공)/성장(실패) 표시.
--
-- 정책 배경:
--   n주차 활동은 n+1주차 이후 집계/공표가 끝나야 성공/실패가 확정된다. 목요일 등 날짜로
--   자동 확정하지 않고, 운영자가 이 컬럼을 세팅(공표)한 시점부터만 success/fail 을 노출한다.
--   공표는 사용자별이 아니라 "n주차 전체 결과"를 확정하는 주차 단위 이벤트이므로 weeks 에 둔다.
--
-- ⚠ tallying(집계 중)은 read-time 표시 상태일 뿐 DB 저장값이 아니다.
--   user_week_statuses.status CHECK(success/fail/personal_rest/official_rest)는 변경하지 않는다.
--
-- 의존성: weeks (2026-05-25_cluster4_weeks_schema_alignment.sql). Idempotent — 재실행 안전.


-- ═══════════════════════════════════════════════════════════════════════
-- PART 1: result_published_at 컬럼 추가
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.weeks
  ADD COLUMN IF NOT EXISTS result_published_at timestamptz NULL;

COMMENT ON COLUMN public.weeks.result_published_at
  IS '주차 결과 집계/공표 완료 시점. NULL=미공표(고객 카드 "성장(집계 중)"), 값 존재=공표 완료(success/fail 노출). 운영자가 Admin 에서 세팅. 사용자별이 아닌 주차 전역 이벤트.';


-- ═══════════════════════════════════════════════════════════════════════
-- PART 2: 기존(이미 종료된) 주차 일괄 백필
--   배포 전 시드/운영 데이터의 과거 주차는 이미 success/fail 로 "운영"되고 있으므로,
--   미공표(NULL)로 두면 전부 "집계 중"으로 회귀해 버린다. 이를 방지하기 위해
--   오늘 이전에 이미 끝난 주차(end_date < CURRENT_DATE)는 공표 완료로 일괄 백필한다.
--   현재 진행 주차/미래 주차(end_date >= CURRENT_DATE)는 NULL 유지 → 진행 중/집계 중 정상 동작.
--   멱등: result_published_at IS NULL 인 행만 갱신.
--   ⚠ 일회성 백필. 배포 이후 새로 끝나는 주차는 운영자가 명시적으로 공표한다.
-- ═══════════════════════════════════════════════════════════════════════

UPDATE public.weeks
SET result_published_at = (end_date + 1)::timestamptz
WHERE result_published_at IS NULL
  AND end_date IS NOT NULL
  AND end_date < CURRENT_DATE;

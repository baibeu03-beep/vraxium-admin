-- 2026-05-31_official_rest_periods.sql
-- 날짜 이동형 공식 휴식(설/추석/임시)을 실제 start_date/end_date 로 관리하는 신규 테이블.
--   - 시험기간 휴식(봄/가을 6~8·14~16주차)은 DB에 등록하지 않는다 → seasonCalendar.ts(getCalendarWeekStatus)로 자동 계산.
--   - 기존 official_rest_weeks(year + ISO week_number)는 삭제하지 않고 legacy/deprecated 로 유지(주석만 부착).
--
-- 의존성: 없음 (독립 테이블).
-- Idempotent — 재실행 안전.


-- ═══════════════════════════════════════════════════════════════════════
-- PART 1: official_rest_periods 테이블
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.official_rest_periods (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  type        text NOT NULL
              CHECK (type IN ('lunar_new_year', 'chuseok', 'temporary', 'other')),
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  description text NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT official_rest_periods_date_order_chk CHECK (end_date >= start_date)
);

COMMENT ON TABLE public.official_rest_periods
  IS '날짜 이동형 공식 휴식(설/추석/임시). 실제 start_date~end_date 기준. 시험기간 휴식은 등록하지 않고 seasonCalendar.ts 로 계산.';
COMMENT ON COLUMN public.official_rest_periods.type
  IS 'lunar_new_year(설/구정) | chuseok(추석) | temporary(임시 휴식) | other(기타)';
COMMENT ON COLUMN public.official_rest_periods.is_active
  IS 'false 면 조회 레이어에서 제외(soft-disable). 과거 휴식 보존용.';


-- ═══════════════════════════════════════════════════════════════════════
-- PART 2: updated_at 자동 갱신 trigger
--   네이밍: touch_<table>_updated_at() / <table>_set_updated_at
--   (기존 weekly_reviews / weekly_colleagues / permissions 트리거와 동일 컨벤션)
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.touch_official_rest_periods_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS official_rest_periods_set_updated_at
  ON public.official_rest_periods;
CREATE TRIGGER official_rest_periods_set_updated_at
  BEFORE UPDATE ON public.official_rest_periods
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_official_rest_periods_updated_at();


-- ═══════════════════════════════════════════════════════════════════════
-- PART 3: index
--   주 조회 패턴 = "특정 날짜가 활성 휴식 기간에 속하는가" (범위 overlap).
-- ═══════════════════════════════════════════════════════════════════════

-- 3-1. 활성 기간만 날짜 범위로 조회 (가장 빈번한 lookup)
CREATE INDEX IF NOT EXISTS official_rest_periods_active_range_idx
  ON public.official_rest_periods (start_date, end_date)
  WHERE is_active;

-- 3-2. type 별 필터/관리 화면용
CREATE INDEX IF NOT EXISTS official_rest_periods_type_idx
  ON public.official_rest_periods (type);


-- ═══════════════════════════════════════════════════════════════════════
-- PART 4: 권한 (README 정책: 신규 테이블은 anon/authenticated SELECT 만,
--          write 는 service_role 경유 admin API)
-- ═══════════════════════════════════════════════════════════════════════

GRANT SELECT ON public.official_rest_periods TO anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 5: legacy 테이블 deprecated 표기 (official_rest_weeks 는 삭제하지 않음)
--   - 데이터/스키마 변경 없음. COMMENT 만 부착하여 의도 명시.
--   - 신규 API/정책은 official_rest_periods 를 참조하고 official_rest_weeks 참조는 제거 예정.
-- ═══════════════════════════════════════════════════════════════════════

COMMENT ON TABLE public.official_rest_weeks
  IS '[DEPRECATED 2026-05-31] year + ISO week_number 기반 공식 휴식. 날짜 이동형 명절 관리 부적합 → official_rest_periods(start_date/end_date) 로 대체. 신규 참조/입력 금지. 기존 데이터 오류 여부는 별도 정리 예정. drop 미정.';

-- weeks.is_official_rest 도 신규 판정에서 제외(legacy). 컬럼은 삭제하지 않으며 backfill/재계산도 하지 않는다.
-- 최종 공식 휴식 = seasonCalendar rule(시험기간) OR official_rest_periods 날짜 overlap 으로 API 에서 계산.
COMMENT ON COLUMN public.weeks.is_official_rest
  IS '[DEPRECATED 2026-05-31] 날짜형 공식 휴식의 비정규화 flag. 신규 판정은 official_rest_periods overlap 으로 계산하므로 더 이상 SoT 아님. backfill/업데이트 금지, 컬럼 보존만.';

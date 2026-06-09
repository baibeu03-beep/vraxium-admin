-- 2026-06-09_line_opening_windows.sql
-- "라인 개설 예외 설정" — 자동 주차 정책(목요일 경계 규칙) 외에, 운영자가
-- 특정 주차/라인을 "추가 개설 가능" 상태로 여는 예외 테이블.
--
-- 배경:
--   실무 정보 라인 개설(/admin/line-opening/practical-info)은 자동 정책에 의해
--   "개설 가능 주차"가 하나로 고정된다(getOpenableWeekStartMs — 목요일 경계).
--   하지만 ① 지난 주차 뒤늦은 개설 ② 라인 재개설 ③ 운영 실수 복구
--   ④ 시스템 장애 복구 등 상황에선 다른 주차를 추가로 열어야 한다.
--
-- 정책(주차 기반 — 시작일/종료일 기간 방식 아님):
--   라인 개설 가능 여부 = 자동 정책 허용  OR  line_opening_windows 활성 예외 존재.
--   "활성 예외" = is_active = true AND allow_opening = true 인 행.
--
-- activity_type_id 의미:
--   NULL      → 해당 주차 전체(모든 실무 정보 라인) 개설 허용.
--   값 존재   → 해당 주차의 특정 활동 유형(라인)만 개설 허용.
--
-- ⚠ 이 테이블은 "어드민이 라인을 개설할 수 있는 주차"만 넓힌다. 스냅샷 생성/조회,
--   demoUserId 경로, 일반 사용자 경로의 로직은 전혀 건드리지 않는다. (예외 행 자체는
--   라인이 생기기 전까지 고객 앱에 아무 영향이 없다 — info-lines POST 게이트에서만 읽힌다.)
--
-- Idempotent — 재실행 안전.

CREATE TABLE IF NOT EXISTS public.line_opening_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  week_id uuid NOT NULL
    REFERENCES public.weeks(id) ON DELETE CASCADE,

  -- NULL = 해당 주차 전체, 값 존재 = 특정 활동 유형(라인)만.
  -- ⚠ activity_types.id 는 text(slug: 'wisdom','essay','infodesk' …)이므로 text 로 맞춘다(uuid 아님).
  activity_type_id text NULL
    REFERENCES public.activity_types(id) ON DELETE CASCADE,

  -- 예외의 의미. 현재는 항상 true(개설 허용). 향후 "차단" 예외 확장 여지를 위해 컬럼 유지.
  allow_opening boolean NOT NULL DEFAULT true,

  -- 비활성화 시 판정에서 제외(행은 보존 — 감사/재활성 가능).
  is_active boolean NOT NULL DEFAULT true,

  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.line_opening_windows
  IS '라인 개설 예외 — 자동 주차 정책 외에 특정 주차/라인을 추가 개설 가능 상태로 여는 주차 기반 예외.';
COMMENT ON COLUMN public.line_opening_windows.activity_type_id
  IS 'NULL = 해당 주차 전체 라인 허용, 값 존재 = 특정 활동 유형(라인)만 허용.';
COMMENT ON COLUMN public.line_opening_windows.allow_opening
  IS '예외의 의미(현재 항상 true=개설 허용). 판정은 is_active=true AND allow_opening=true.';

-- ── 중복 방지(부분 unique) — week_id 단위로 "전체 1행 + 라인별 1행"까지만 허용 ──
-- 같은 주차 + 같은 활동유형(또는 둘 다 전체)의 예외가 중복 생성되지 않도록.
-- (재등록 시 데이터 레이어가 기존 행을 찾아 is_active=true 로 되살린다.)
CREATE UNIQUE INDEX IF NOT EXISTS line_opening_windows_week_activity_uniq
  ON public.line_opening_windows (week_id, activity_type_id)
  WHERE activity_type_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS line_opening_windows_week_all_uniq
  ON public.line_opening_windows (week_id)
  WHERE activity_type_id IS NULL;

-- ── 조회/판정용 인덱스 ──
CREATE INDEX IF NOT EXISTS line_opening_windows_week_id_idx
  ON public.line_opening_windows (week_id);

-- "이 주차의 이 활동유형을 지금 개설할 수 있는 활성 예외가 있는가?" 판정 경로 최적화.
CREATE INDEX IF NOT EXISTS line_opening_windows_active_idx
  ON public.line_opening_windows (week_id, activity_type_id, is_active, allow_opening);

-- ── updated_at 자동 갱신 트리거 ──
CREATE OR REPLACE FUNCTION public.touch_line_opening_windows_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS line_opening_windows_set_updated_at
  ON public.line_opening_windows;

CREATE TRIGGER line_opening_windows_set_updated_at
BEFORE UPDATE ON public.line_opening_windows
FOR EACH ROW
EXECUTE FUNCTION public.touch_line_opening_windows_updated_at();


-- ═══════════════════════════════════════════════════════════════════════
-- 검증 (DML 아님 — 참고용)
-- ═══════════════════════════════════════════════════════════════════════
/*
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'line_opening_windows'
ORDER BY ordinal_position;

SELECT indexname FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'line_opening_windows';

-- 활성 예외 분포
SELECT week_id, activity_type_id, allow_opening, is_active, count(*)
FROM public.line_opening_windows
GROUP BY week_id, activity_type_id, allow_opening, is_active;
*/

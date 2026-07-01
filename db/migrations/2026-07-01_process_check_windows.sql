-- 2026-07-01_process_check_windows.sql
-- "프로세스 체크 예외 주차 설정" — 프로세스 체크(정규/변동) 주차 드롭다운의 기본 정책
--   (현재 시즌 W1~현재주차 · 현재 주차만 편집 가능) 외에, 운영자가 특정 주차를
--   "추가 선택·편집 가능" 상태로 여는 예외 테이블.
--
-- 배경:
--   프로세스 체크 주차 드롭다운(resolveSelectableProcessWeeks)은 현재 시즌 W1~현재 주차만
--   노출하고, 그중 현재 주차만 편집 가능(과거=조회 전용·미래=미노출)하다.
--   하지만 ① 지난 주차 뒤늦은 체크 ② 미래 주차 사전 준비 ③ 운영 실수 복구 등
--   상황에선 다른 주차를 추가로 열어(선택·생성/설정 가능하게) 할 필요가 있다.
--
-- 정책(주차 기반 — 기간 방식 아님 · line_opening_windows 와 동형):
--   프로세스 체크 주차 선택/편집 가능 여부 = 기본 정책  OR  process_check_windows 활성 예외 존재.
--   "활성 예외" = is_active = true AND allow_selection = true 인 행.
--   ⚠ 예외는 기본 정책을 "대체"하지 않고 "추가 허용"한다(기본 허용 주차는 그대로 유지).
--
-- organization_slug / hub 의미(스코프):
--   organization_slug NULL → 전체 조직 · 값 존재 → 그 조직만.
--   hub NULL               → 전체 프로세스 허브 · 값 존재 → 그 허브만.
--     (허브 값: 'club' | 'info' | 'experience' | 'competency' | 'career' | 'irregular')
--
-- ⚠ 이 테이블은 "어드민이 프로세스 체크를 선택/생성/설정할 수 있는 주차"만 넓힌다.
--   프로세스 체크는 process_check_statuses/logs · process_irregular_acts 만 read/write 하며,
--   고객 앱 DTO · weekly-card · snapshot · user_weekly_points · demoUserId · checkGate 는
--   전혀 건드리지 않는다(운영 정책은 operating 기준으로 유지 · mode=test 무관).
--
-- Idempotent — 재실행 안전.

CREATE TABLE IF NOT EXISTS public.process_check_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  week_id uuid NOT NULL
    REFERENCES public.weeks(id) ON DELETE CASCADE,

  -- NULL = 전체 조직, 값 존재 = 해당 조직(encre|oranke|phalanx)만.
  organization_slug text NULL,

  -- NULL = 전체 프로세스 허브, 값 존재 = 해당 허브(club|info|experience|competency|career|irregular)만.
  hub text NULL,

  -- 예외의 의미. 현재는 항상 true(선택/편집 허용). 향후 "차단" 예외 확장 여지를 위해 컬럼 유지.
  allow_selection boolean NOT NULL DEFAULT true,

  -- 비활성화 시 판정에서 제외(행은 보존 — 감사/재활성 가능).
  is_active boolean NOT NULL DEFAULT true,

  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.process_check_windows
  IS '프로세스 체크 예외 주차 — 기본 주차 정책 외에 특정 주차를 (조직/허브 스코프로) 추가 선택·편집 가능하게 여는 주차 기반 예외.';
COMMENT ON COLUMN public.process_check_windows.organization_slug
  IS 'NULL = 전체 조직, 값 존재 = 해당 조직만.';
COMMENT ON COLUMN public.process_check_windows.hub
  IS 'NULL = 전체 프로세스 허브, 값 존재 = club|info|experience|competency|career|irregular 중 하나.';
COMMENT ON COLUMN public.process_check_windows.allow_selection
  IS '예외의 의미(현재 항상 true=선택/편집 허용). 판정은 is_active=true AND allow_selection=true.';

-- ── 중복 방지(부분 unique) — (week_id, org, hub) 조합당 1행 ──
--   NULL 을 빈 문자열로 접어(coalesce) 조합 단위 유일성을 보장한다.
--   (재등록 시 데이터 레이어가 기존 행을 찾아 is_active=true 로 되살린다.)
CREATE UNIQUE INDEX IF NOT EXISTS process_check_windows_scope_uniq
  ON public.process_check_windows (
    week_id,
    COALESCE(organization_slug, ''),
    COALESCE(hub, '')
  );

-- ── 조회/판정용 인덱스 ──
CREATE INDEX IF NOT EXISTS process_check_windows_week_id_idx
  ON public.process_check_windows (week_id);

-- "이 주차를 지금 선택/편집할 수 있는 활성 예외가 있는가?" 판정 경로 최적화.
CREATE INDEX IF NOT EXISTS process_check_windows_active_idx
  ON public.process_check_windows (is_active, allow_selection, week_id);

-- ── updated_at 자동 갱신 트리거 ──
CREATE OR REPLACE FUNCTION public.touch_process_check_windows_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS process_check_windows_set_updated_at
  ON public.process_check_windows;

CREATE TRIGGER process_check_windows_set_updated_at
BEFORE UPDATE ON public.process_check_windows
FOR EACH ROW
EXECUTE FUNCTION public.touch_process_check_windows_updated_at();


-- ═══════════════════════════════════════════════════════════════════════
-- 검증 (DML 아님 — 참고용)
-- ═══════════════════════════════════════════════════════════════════════
/*
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'process_check_windows'
ORDER BY ordinal_position;

SELECT indexname FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'process_check_windows';

-- 활성 예외 분포
SELECT week_id, organization_slug, hub, allow_selection, is_active, count(*)
FROM public.process_check_windows
GROUP BY week_id, organization_slug, hub, allow_selection, is_active;
*/

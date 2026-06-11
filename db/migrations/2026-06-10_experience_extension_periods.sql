-- 2026-06-10_experience_extension_periods.sql
-- 실무 경험 <확장> 류 라인의 "개설 기간" SoT.
--
-- 배경:
--   실무 경험 허브에는 일반 경험 라인(도출/분석/평가/관리) 외에 "확장"(extension) 계열
--   라인이 있고, 이 확장 라인은 매년 정해진 기간(온라인/오프라인)에만 운영된다.
--   라인 개설 상태창(운영 대시보드, /admin/line-opening/practical-experience [라인 개설])이
--   "지난 주(개설 대상 주차)가 확장 기간에 해당하는지"를 이 테이블로 판단한다.
--
-- 정책:
--   - 기간은 [start_date, end_date] 날짜 범위(포함). 상태창은 대상 주차의 [월~일] 범위와
--     겹치면(overlap) 해당 확장 기간으로 본다.
--   - organization_slug = NULL → 전체 조직 공통. 값 존재 → 그 조직 전용(향후 조직별 분기 확장 여지).
--   - extension_kind = 'online' | 'offline'.
--
-- 이번 범위(설계 결정):
--   - 테이블 생성 + 2026 확정 기간 seed 까지만. 어드민 편집 UI / 자동 개설 / snapshot 변경은 범위 외.
--   - 컬럼은 추후 어드민 편집 UI 가 붙어도 되도록 확장 가능하게 둔다(label, season_key, is_active).
--
-- ⚠ 이 테이블은 "상태창 표시"에만 쓰인다. 스냅샷 생성/조회, demoUserId 경로, 라인 개설 강제
--    로직은 전혀 건드리지 않는다. (read-only 소비)
--
-- Idempotent — 재실행 안전.

CREATE TABLE IF NOT EXISTS public.cluster4_experience_extension_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- NULL = 전체 조직 공통. 값 존재 = 그 조직 전용(확장성).
  organization_slug text NULL,

  -- 'online' | 'offline'.
  extension_kind text NOT NULL
    CHECK (extension_kind IN ('online', 'offline')),

  start_date date NOT NULL,
  end_date date NOT NULL,
  CONSTRAINT cluster4_experience_extension_periods_range_chk
    CHECK (end_date >= start_date),

  -- 선택 시즌 스코프(확장 여지) + 표시 라벨.
  season_key text NULL,
  label text NULL,

  -- 비활성화 시 판정에서 제외(행은 보존 — 감사/재활성 가능).
  is_active boolean NOT NULL DEFAULT true,

  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cluster4_experience_extension_periods
  IS '실무 경험 <확장> 라인 개설 기간 — 상태창이 대상 주차의 확장 기간 여부를 판단하는 SoT(표시 전용).';
COMMENT ON COLUMN public.cluster4_experience_extension_periods.organization_slug
  IS 'NULL = 전체 조직 공통, 값 존재 = 해당 조직 전용.';
COMMENT ON COLUMN public.cluster4_experience_extension_periods.extension_kind
  IS '확장 종류: online | offline.';

-- ── 중복 방지(멱등 seed 지원) ──
-- organization_slug NULL 을 동등 비교하기 위해 coalesce 표현식 unique index 사용.
CREATE UNIQUE INDEX IF NOT EXISTS cluster4_experience_extension_periods_uniq
  ON public.cluster4_experience_extension_periods
     (coalesce(organization_slug, ''), extension_kind, start_date, end_date);

-- ── 조회용 인덱스 (활성 + 날짜 범위 판정 경로) ──
CREATE INDEX IF NOT EXISTS cluster4_experience_extension_periods_active_idx
  ON public.cluster4_experience_extension_periods
     (is_active, start_date, end_date);

-- ── updated_at 자동 갱신 트리거 ──
CREATE OR REPLACE FUNCTION public.touch_cluster4_experience_extension_periods_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cluster4_experience_extension_periods_set_updated_at
  ON public.cluster4_experience_extension_periods;

CREATE TRIGGER cluster4_experience_extension_periods_set_updated_at
BEFORE UPDATE ON public.cluster4_experience_extension_periods
FOR EACH ROW
EXECUTE FUNCTION public.touch_cluster4_experience_extension_periods_updated_at();

-- ── 읽기 권한(상태창 표시 전용). write 는 service_role(supabaseAdmin)만. ──
GRANT SELECT ON public.cluster4_experience_extension_periods TO anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- Seed — 2026 확정 확장 기간 (전체 조직 공통, organization_slug = NULL)
--   온라인 확장 : 2026-07-27 ~ 2026-08-23
--   오프라인 확장: 2026-11-16 ~ 2026-11-29
-- 멱등: 동일 (org, kind, start, end) 행이 없을 때만 삽입.
-- ═══════════════════════════════════════════════════════════════════════
INSERT INTO public.cluster4_experience_extension_periods
  (organization_slug, extension_kind, start_date, end_date, label)
SELECT NULL, 'online', DATE '2026-07-27', DATE '2026-08-23', '2026 온라인 확장'
WHERE NOT EXISTS (
  SELECT 1 FROM public.cluster4_experience_extension_periods
  WHERE organization_slug IS NULL AND extension_kind = 'online'
    AND start_date = DATE '2026-07-27' AND end_date = DATE '2026-08-23'
);

INSERT INTO public.cluster4_experience_extension_periods
  (organization_slug, extension_kind, start_date, end_date, label)
SELECT NULL, 'offline', DATE '2026-11-16', DATE '2026-11-29', '2026 오프라인 확장'
WHERE NOT EXISTS (
  SELECT 1 FROM public.cluster4_experience_extension_periods
  WHERE organization_slug IS NULL AND extension_kind = 'offline'
    AND start_date = DATE '2026-11-16' AND end_date = DATE '2026-11-29'
);

-- ═══════════════════════════════════════════════════════════════════════
-- 검증 (DML 아님 — 참고용)
-- ═══════════════════════════════════════════════════════════════════════
/*
SELECT extension_kind, start_date, end_date, organization_slug, is_active, label
FROM public.cluster4_experience_extension_periods
ORDER BY start_date;
-- 기대: online 2026-07-27~2026-08-23, offline 2026-11-16~2026-11-29 (org NULL, active).
*/

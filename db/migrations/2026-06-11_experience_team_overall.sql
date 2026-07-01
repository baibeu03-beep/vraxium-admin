-- 2026-06-11_experience_team_overall.sql
-- 실무 경험 라인 개설 "팀 총괄" — 개설 검수(임시저장) · 개설 완료 · 개설 취소 상태 저장(standalone).
--
-- 배경:
--   /admin/line-opening/practical-experience?...&tab=open 의 [팀 총괄] 화면.
--   파트장들이 자기 파트에서 입력한 도출/분석/견문 신청(cluster4_experience_part_submissions)이
--   팀 총괄에 그대로 모이고, 팀장이 <관리>·<확장> 라인을 직접 입력한다. 각 라인(카테고리)별
--   아웃풋 링크/설명도 함께 입력한다.
--
--   버튼 4종:
--     [개설 검수] 에이전트 — 현재 입력값(관리/확장 셀 + 아웃풋)을 임시 저장(status='reviewed').
--                          크루 페이지 미반영. 재접속 시 그대로 복원.
--     [초기화]   프론트 전용(DB 무관).
--     [개설 완료] 팀장 — 최종 저장 + 크루 페이지(cluster4_lines) 반영(status='opened').
--     [개설 취소] 팀장 — opened 라인 전부 취소(크루 페이지 원복) + status='reviewed' 로 복귀.
--
-- 저장 범위(설계 결정):
--   - 도출/분석/견문 셀은 여기 저장하지 않는다 — 항상 파트 신청(part_submissions)에서 라이브로 읽는다.
--   - 이 테이블 셀에는 팀장이 직접 입력하는 <관리>(management)·<확장>(extension)만 저장한다.
--   - 아웃풋 링크/설명은 카테고리(라인)별 1세트. 아웃풋 이미지는 입력 UI 없음(라인 등록값 자동 반영).
--
-- ⚠ snapshot/weekly-cards/강화율 계산 로직은 건드리지 않는다. 고객 반영(개설 완료/취소)은 기존 라인 개설
--    구조(cluster4_lines · cluster4_line_targets · cluster4_experience_line_evaluations)를 재사용하고,
--    재계산은 markWeeklyCardsSnapshotStaleMany(저렴) + 기존 lazy recompute 경로에 위임한다.
--
-- Idempotent — 재실행 안전.

-- ── 팀 단위 총괄 헤더(org+week+team 1행) ──
CREATE TABLE IF NOT EXISTS public.cluster4_experience_team_overall (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  organization_slug text NOT NULL,
  week_id uuid NOT NULL,
  team_id uuid NOT NULL,

  -- 'reviewed' = 개설 검수(임시저장, 고객 미반영), 'opened' = 개설 완료(고객 반영).
  status text NOT NULL DEFAULT 'reviewed'
    CHECK (status IN ('reviewed', 'opened')),

  reviewed_by uuid NULL,
  reviewed_at timestamptz NULL,
  opened_by   uuid NULL,
  opened_at   timestamptz NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cluster4_experience_team_overall_uniq
    UNIQUE (organization_slug, week_id, team_id)
);

COMMENT ON TABLE public.cluster4_experience_team_overall
  IS '실무 경험 팀 총괄 — 개설 검수/완료 상태 헤더(org+week+team). 도출/분석/견문은 미저장(파트 신청 라이브). experience_drafts/snapshot 무관.';

-- ── 팀장 직접 입력 셀(관리/확장만) ──
CREATE TABLE IF NOT EXISTS public.cluster4_experience_team_overall_cells (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  overall_id uuid NOT NULL
    REFERENCES public.cluster4_experience_team_overall(id) ON DELETE CASCADE,

  crew_user_id uuid NOT NULL,
  -- 팀장 직접 입력 카테고리만: management(관리) · extension(확장).
  category text NOT NULL
    CHECK (category IN ('management', 'extension')),

  checked boolean NOT NULL DEFAULT true,
  score   smallint NOT NULL DEFAULT 7 CHECK (score >= 0 AND score <= 10),

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cluster4_experience_team_overall_cells_uniq
    UNIQUE (overall_id, crew_user_id, category)
);

COMMENT ON TABLE public.cluster4_experience_team_overall_cells
  IS '팀 총괄 팀장 직접 입력 셀 — (총괄, 크루, 관리|확장)별 checked+score. 강화 실패=!checked OR score<=3 (표시/반영용).';

-- ── 카테고리(라인)별 아웃풋 링크/설명 ──
CREATE TABLE IF NOT EXISTS public.cluster4_experience_team_overall_outputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  overall_id uuid NOT NULL
    REFERENCES public.cluster4_experience_team_overall(id) ON DELETE CASCADE,

  category text NOT NULL
    CHECK (category IN ('derivation', 'analysis', 'evaluation', 'extension', 'management')),

  output_link        text NULL,
  output_description  text NULL,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cluster4_experience_team_overall_outputs_uniq
    UNIQUE (overall_id, category)
);

COMMENT ON TABLE public.cluster4_experience_team_overall_outputs
  IS '팀 총괄 카테고리(라인)별 아웃풋 링크/설명. 이미지는 입력 UI 없음 — 개설 완료 시 라인 등록값 자동 반영.';

-- ── 개설 완료로 생성한 고객 라인 추적(개설 취소 원복용) ──
CREATE TABLE IF NOT EXISTS public.cluster4_experience_team_overall_opened_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  overall_id uuid NOT NULL
    REFERENCES public.cluster4_experience_team_overall(id) ON DELETE CASCADE,

  category text NOT NULL,
  line_id  uuid NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cluster4_experience_team_overall_opened_lines_uniq
    UNIQUE (overall_id, line_id)
);

COMMENT ON TABLE public.cluster4_experience_team_overall_opened_lines
  IS '팀 총괄 개설 완료로 생성한 cluster4_lines id 추적 — 개설 취소 시 이 라인/타깃/평가를 삭제해 크루 페이지를 원복한다.';

-- ── 조회용 인덱스 ──
CREATE INDEX IF NOT EXISTS cluster4_experience_team_overall_scope_idx
  ON public.cluster4_experience_team_overall (organization_slug, week_id, team_id);
CREATE INDEX IF NOT EXISTS cluster4_experience_team_overall_cells_overall_idx
  ON public.cluster4_experience_team_overall_cells (overall_id);
CREATE INDEX IF NOT EXISTS cluster4_experience_team_overall_outputs_overall_idx
  ON public.cluster4_experience_team_overall_outputs (overall_id);
CREATE INDEX IF NOT EXISTS cluster4_experience_team_overall_opened_lines_overall_idx
  ON public.cluster4_experience_team_overall_opened_lines (overall_id);

-- ── updated_at 자동 갱신 트리거(헤더) ──
CREATE OR REPLACE FUNCTION public.touch_cluster4_experience_team_overall_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cluster4_experience_team_overall_set_updated_at
  ON public.cluster4_experience_team_overall;

CREATE TRIGGER cluster4_experience_team_overall_set_updated_at
BEFORE UPDATE ON public.cluster4_experience_team_overall
FOR EACH ROW
EXECUTE FUNCTION public.touch_cluster4_experience_team_overall_updated_at();

-- ── 읽기 권한(표시 전용). write 는 service_role(supabaseAdmin)만. ──
GRANT SELECT ON public.cluster4_experience_team_overall TO anon, authenticated;
GRANT SELECT ON public.cluster4_experience_team_overall_cells TO anon, authenticated;
GRANT SELECT ON public.cluster4_experience_team_overall_outputs TO anon, authenticated;
GRANT SELECT ON public.cluster4_experience_team_overall_opened_lines TO anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 검증 (DML 아님 — 참고용)
-- ═══════════════════════════════════════════════════════════════════════
/*
SELECT o.organization_slug, o.week_id, o.team_id, o.status,
       (SELECT count(*) FROM public.cluster4_experience_team_overall_cells c WHERE c.overall_id = o.id)         AS cells,
       (SELECT count(*) FROM public.cluster4_experience_team_overall_outputs op WHERE op.overall_id = o.id)     AS outputs,
       (SELECT count(*) FROM public.cluster4_experience_team_overall_opened_lines l WHERE l.overall_id = o.id)  AS opened_lines
FROM public.cluster4_experience_team_overall o
ORDER BY o.updated_at DESC;
*/

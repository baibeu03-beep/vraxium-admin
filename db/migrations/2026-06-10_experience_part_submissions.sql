-- 2026-06-10_experience_part_submissions.sql
-- 실무 경험 라인 개설 "파트장 입력" 신청 데이터 — 신규 전용 저장(standalone).
--
-- 배경:
--   /admin/line-opening/practical-experience [라인 개설] 탭의 파트장 입력 그리드.
--   파트장이 자기 파트 크루들을 라인(도출/분석/견문)별로 체크+점수 입력 후 "개설 신청",
--   "신청 취소"로 되돌린다. 팀 총괄은 각 파트 신청을 통합 조회(집계)한다.
--
-- ⚠ 기존 experience 워크플로우(cluster4_experience_line_drafts 입력/검수/개설)와 **완전 분리**.
--    이 테이블은 이번 phase 의 "신청 저장/취소"만 담는다 — snapshot/weekly-cards/강화율 계산과 무연동.
--    (강화율 연동은 추후. 현재는 admin 입력 메타.)
--
-- 저장 단위: org + week + team + part + crew + line_type. 값: checked, score. 파트 단위 신청 상태(헤더) 관리.
-- 신청 취소 = 헤더 삭제(셀 cascade).
--
-- Idempotent — 재실행 안전.

-- ── 파트 단위 신청 헤더 ──
CREATE TABLE IF NOT EXISTS public.cluster4_experience_part_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  organization_slug text NOT NULL,
  week_id   uuid NOT NULL,
  team_id   uuid NOT NULL,
  part_name text NOT NULL,

  submitted_by uuid NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- 파트당 1신청/주차. 재신청은 기존 행 upsert.
  CONSTRAINT cluster4_experience_part_submissions_uniq
    UNIQUE (organization_slug, week_id, team_id, part_name)
);

COMMENT ON TABLE public.cluster4_experience_part_submissions
  IS '실무 경험 파트장 입력 — 파트 단위 신청 헤더(org+week+team+part). 취소=행 삭제. experience_drafts/snapshot 무관.';

-- ── 크루 × 라인 셀(체크+점수) ──
CREATE TABLE IF NOT EXISTS public.cluster4_experience_part_submission_cells (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  submission_id uuid NOT NULL
    REFERENCES public.cluster4_experience_part_submissions(id) ON DELETE CASCADE,

  crew_user_id uuid NOT NULL,
  -- 라인 종류: derivation(도출) · analysis(분석) · evaluation(견문, 구 '평가' 워딩).
  line_type text NOT NULL
    CHECK (line_type IN ('derivation', 'analysis', 'evaluation')),

  checked boolean NOT NULL DEFAULT true,
  score   smallint NOT NULL DEFAULT 7 CHECK (score >= 0 AND score <= 10),

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cluster4_experience_part_submission_cells_uniq
    UNIQUE (submission_id, crew_user_id, line_type)
);

COMMENT ON TABLE public.cluster4_experience_part_submission_cells
  IS '실무 경험 파트장 입력 셀 — (신청, 크루, 라인)별 checked+score. 강화 실패=!checked OR score<=3 (표시/저장만).';

-- ── 조회용 인덱스 ──
CREATE INDEX IF NOT EXISTS cluster4_experience_part_submissions_scope_idx
  ON public.cluster4_experience_part_submissions (organization_slug, week_id, team_id);

CREATE INDEX IF NOT EXISTS cluster4_experience_part_submission_cells_sub_idx
  ON public.cluster4_experience_part_submission_cells (submission_id);

-- ── updated_at 자동 갱신 트리거(헤더) ──
CREATE OR REPLACE FUNCTION public.touch_cluster4_experience_part_submissions_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cluster4_experience_part_submissions_set_updated_at
  ON public.cluster4_experience_part_submissions;

CREATE TRIGGER cluster4_experience_part_submissions_set_updated_at
BEFORE UPDATE ON public.cluster4_experience_part_submissions
FOR EACH ROW
EXECUTE FUNCTION public.touch_cluster4_experience_part_submissions_updated_at();

-- ── 읽기 권한(표시 전용). write 는 service_role(supabaseAdmin)만. ──
GRANT SELECT ON public.cluster4_experience_part_submissions TO anon, authenticated;
GRANT SELECT ON public.cluster4_experience_part_submission_cells TO anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 검증 (DML 아님 — 참고용)
-- ═══════════════════════════════════════════════════════════════════════
/*
SELECT s.organization_slug, s.week_id, s.team_id, s.part_name, count(c.*) AS cells
FROM public.cluster4_experience_part_submissions s
LEFT JOIN public.cluster4_experience_part_submission_cells c ON c.submission_id = s.id
GROUP BY s.id
ORDER BY s.submitted_at DESC;
*/

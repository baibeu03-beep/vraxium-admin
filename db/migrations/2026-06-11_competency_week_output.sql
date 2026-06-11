-- 2026-06-11_competency_week_output.sql
-- 실무 역량 [라인 개설] 주차 공통 아웃풋(링크/설명) — org+주차 단위 1행.
--
-- 배경:
--   실무 역량 허브는 [개설 완료] 시, 그 주차 카페 공표글 링크 1개 + 설명 1개를 입력하면
--   해당 주차의 모든 역량 라인칸(cluster4_lines.output_link_1 / output_links[0])에 공통 적용한다.
--   본 테이블은 (1) 폼 prefill 용 현재 적용값과 (2) [개설 취소] 원복용 라인별 직전 아웃풋 스냅샷을 보관한다.
--   라인 자체의 아웃풋(고객 반영)은 cluster4_lines 에 그대로 들어간다 — 본 테이블은 운영 메타/원복 보조.
--
-- ⚠ snapshot 생성/조회 로직·weekly-card DTO 무관. 라인 토글/아웃풋 반영은 cluster4_lines 에서 수행.
--    본 테이블 읽기/쓰기는 best-effort(미적용 시 라인 아웃풋은 그대로 반영되되 prefill/원복 스냅샷만 비활성).
--
-- Idempotent — 재실행 안전.

CREATE TABLE IF NOT EXISTS public.cluster4_competency_week_output (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  organization_slug text NOT NULL,
  week_id           uuid NOT NULL,

  -- 현재 적용된 공통 아웃풋(폼 prefill). 개설 취소 시 NULL 로 비운다.
  output_link_1      text NULL,
  output_description text NULL,

  -- 개설 완료(최초 적용) 시점의 라인별 직전 아웃풋 스냅샷 — 개설 취소 원복용.
  --   [{ line_id, output_link_1, output_links, output_link_2 }]
  prior_outputs jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- 현재 개설 완료(고객 반영) 상태인지.
  applied boolean NOT NULL DEFAULT false,

  updated_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organization_slug, week_id)
);

COMMENT ON TABLE public.cluster4_competency_week_output
  IS '실무 역량 [라인 개설] 주차 공통 아웃풋(링크/설명) + 개설 취소 원복용 라인별 직전 스냅샷. org+week 1행.';
COMMENT ON COLUMN public.cluster4_competency_week_output.prior_outputs
  IS '개설 완료 시 덮어쓰기 전 라인별 아웃풋 스냅샷(취소 원복용). [{line_id,output_link_1,output_links,output_link_2}].';

CREATE INDEX IF NOT EXISTS cluster4_competency_week_output_org_week_idx
  ON public.cluster4_competency_week_output (organization_slug, week_id);

-- ═══════════════════════════════════════════════════════════════════════
-- 검증 (DML 아님 — 참고용)
-- ═══════════════════════════════════════════════════════════════════════
/*
SELECT organization_slug, week_id, applied, output_link_1, output_description,
       jsonb_array_length(prior_outputs) AS prior_n, updated_at
FROM public.cluster4_competency_week_output
ORDER BY updated_at DESC;
*/

-- 2026-06-11_competency_applications.sql
-- 실무 역량 [라인 개설] 신청/승인 명단 — 고객 페이지(추후) 신청 + 운영자 수동 추가.
--
-- 배경:
--   고객 페이지에서 크루가 실무 역량 라인 개설을 신청하면 1행이 쌓인다(source='customer').
--   고객 입력 UI 가 아직 없으므로 이번 범위에서는 어드민 승인 명단 구조만 먼저 구축한다
--   (운영자 수동 추가 source='manual' 포함). 운영자는 카페 체크/승인 체크/반려 사유를 관리한다.
--
--   [개설 완료] 시 approval_checked=true 항목만 실제 고객 라인칸으로 반영(resolution='opened'),
--   approval_checked=false 는 반려(resolution='rejected'). 이때 제출 링크(submission_link)는
--   각 크루 라인의 output_link_2, 운영자 공통 카페 링크는 output_link_1 로 들어간다.
--   [개설 취소] 시 생성 라인 제거 + resolution='pending' 복귀.
--
-- ⚠ 어드민 승인 메타데이터. 고객 weekly-cards 반영은 [개설 완료]가 cluster4_lines 로 수행한다.
--    snapshot 생성/조회 로직·weekly-card DTO 무변경.
--
-- Idempotent — 재실행 안전.

CREATE TABLE IF NOT EXISTS public.cluster4_competency_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  organization_slug text NOT NULL,
  week_id           uuid NOT NULL,
  target_user_id    uuid NOT NULL,   -- 신청 크루.

  -- 신청 라인: 고객 신청은 마스터 연결, 수동 추가는 운영자 수기 라인명(마스터 없을 수 있음).
  competency_line_master_id uuid NULL,
  line_name text NOT NULL,

  submission_link text NULL,         -- 크루 제출 링크 → 개설 시 output_link_2.

  cafe_checked     boolean NOT NULL DEFAULT true,  -- 카페 게시글 존재/정상 여부.
  approval_checked boolean NOT NULL DEFAULT true,  -- 실제 개설(반영) 여부.
  rejection_reason text NULL,

  source     text NOT NULL DEFAULT 'customer' CHECK (source IN ('customer', 'manual')),
  -- 개설 반영 상태: pending(미반영) / opened(개설 완료 반영) / rejected(반려).
  resolution text NOT NULL DEFAULT 'pending' CHECK (resolution IN ('pending', 'opened', 'rejected')),

  -- 개설 완료로 생성한 고객 라인 추적(개설 취소 원복용).
  opened_line_id   uuid NULL,
  opened_target_id uuid NULL,

  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cluster4_competency_applications
  IS '실무 역량 라인 개설 신청/승인 명단(고객 신청 + 운영자 수동). 개설 완료 시 approval_checked=true 항목만 cluster4_lines 반영(제출링크→output_link_2).';
COMMENT ON COLUMN public.cluster4_competency_applications.resolution
  IS 'pending=미반영, opened=개설완료 반영(라인 생성), rejected=반려.';

CREATE INDEX IF NOT EXISTS cluster4_competency_applications_org_week_idx
  ON public.cluster4_competency_applications (organization_slug, week_id);
CREATE INDEX IF NOT EXISTS cluster4_competency_applications_user_idx
  ON public.cluster4_competency_applications (target_user_id);

-- 읽기 권한(어드민 표시 전용). write 는 service_role(supabaseAdmin)만.
GRANT SELECT ON public.cluster4_competency_applications TO anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 검증 (DML 아님 — 참고용)
-- ═══════════════════════════════════════════════════════════════════════
/*
SELECT organization_slug, week_id, source, resolution, approval_checked, cafe_checked,
       line_name, submission_link, target_user_id
FROM public.cluster4_competency_applications
ORDER BY created_at DESC LIMIT 30;
*/

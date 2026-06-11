-- 2026-06-11_competency_opening_logs.sql
-- 실무 역량 라인 개설 "행동 이력" 로그 — append-only.
--
-- 배경:
--   실무 역량(competency) 허브는 파트장 신청/검수 단계가 없다. [라인 개설] 탭에서
--   허브 전체를 [개설 완료] / [개설 취소] 하는 단순 토글이며, 그 행동을 시간순으로 남긴다.
--   experience 의 cluster4_experience_opening_logs 와 동일한 append-only/denormalized 패턴이되,
--   허브 전체 1건 단위(팀/파트 분기 없음)라 표시값을 단순화한다.
--
-- ⚠ 로그는 "최종 상태"가 아니라 "행동 이력"이다 — 덮어쓰기/수정/삭제 금지. 재개설/재취소 시 행이 추가된다.
-- ⚠ 어드민 메타데이터 — 고객 weekly-cards DTO/스냅샷 계산과 무관. 표시값은 쓰기 시점에 denormalize
--    되어 주차/프로필이 바뀌어도 이력이 보존된다. 쓰기는 best-effort(본 동작과 분리).
--
-- Idempotent — 재실행 안전.

CREATE TABLE IF NOT EXISTS public.cluster4_competency_opening_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 행동:
  --   open   = 개설 완료 (허브 전체 역량 라인 is_active=true 반영)
  --   cancel = 개설 취소 (허브 전체 역량 라인 is_active=false 원복)
  action text NOT NULL CHECK (action IN ('open', 'cancel')),

  -- 참조(무 FK·nullable) — 주차가 삭제돼도 로그는 보존.
  week_id           uuid NULL,
  organization_slug text NULL,

  -- 표시값(쓰기 시점 denormalize).
  period_label text NOT NULL,  -- "26년 여름 시즌 1주차"
  actor_name   text NOT NULL,  -- 실행자 display_name

  changed_by uuid NULL,        -- 실행 어드민(auth.users.id)
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cluster4_competency_opening_logs
  IS '실무 역량 라인 개설 행동 이력(append-only) — 개설 완료/취소(허브 전체). denormalized 표시값, 수정/삭제 금지.';
COMMENT ON COLUMN public.cluster4_competency_opening_logs.action
  IS 'open=개설완료(is_active=true), cancel=개설취소(is_active=false).';

-- ── 조회용 인덱스 (org + 주차 + 최신순) ──
CREATE INDEX IF NOT EXISTS cluster4_competency_opening_logs_org_week_idx
  ON public.cluster4_competency_opening_logs (organization_slug, week_id, created_at DESC);

CREATE INDEX IF NOT EXISTS cluster4_competency_opening_logs_created_idx
  ON public.cluster4_competency_opening_logs (created_at DESC);

-- ── 읽기 권한(로그창 표시 전용). write 는 service_role(supabaseAdmin)만. ──
GRANT SELECT ON public.cluster4_competency_opening_logs TO anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 검증 (DML 아님 — 참고용)
-- ═══════════════════════════════════════════════════════════════════════
/*
SELECT action, period_label, organization_slug, actor_name, created_at
FROM public.cluster4_competency_opening_logs
ORDER BY created_at DESC
LIMIT 20;
*/

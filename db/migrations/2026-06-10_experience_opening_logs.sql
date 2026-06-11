-- 2026-06-10_experience_opening_logs.sql
-- 실무 경험 라인 개설 "행동 이력" 로그 — append-only.
--
-- 배경:
--   실무 경험 라인 개설 워크플로우(개설 신청 → 개설 검수 → 개설 완료, 검수 반려, 개설 취소)의
--   각 행동을 시간순으로 남기는 로그. [라인 개설] 탭 로그창(운영 대시보드)이 최신순으로 보여준다.
--   practical-info 의 cluster4_line_opening_logs 와 동일한 append-only/denormalized 패턴을 따르되,
--   experience 전용 필드(팀/파트/실행자 크루상태)를 추가한다.
--
-- ⚠ 로그는 "최종 상태"가 아니라 "행동 이력"이다 — 덮어쓰기/수정/삭제 금지. 재완료/재신청 시 행이 추가된다.
-- ⚠ 어드민 메타데이터 — 고객 weekly-cards DTO/스냅샷 계산과 무관. 모든 표시값은 쓰기 시점에 denormalize
--    되어 라인/주차/프로필이 바뀌어도 이력이 보존된다. 쓰기는 best-effort(본 동작과 분리).
--
-- 실행 팀/파트/크루상태/사람 = "실행한 어드민 계정"의 크루 소속 기준(쓰기 시점 resolve).
--
-- Idempotent — 재실행 안전.

CREATE TABLE IF NOT EXISTS public.cluster4_experience_opening_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 행동:
  --   apply        = 개설 신청 (파트장이 제출)
  --   apply_cancel = 신청 취소 (파트장이 자기 파트 신청 철회) — 개설 취소(cancel)와 다른 이벤트
  --   review       = 개설 검수 (에이전트가 승인)
  --   reject       = 검수 반려 (에이전트가 반려) — 개설 취소와 다름
  --   open         = 개설 완료 (팀장이 개설)
  --   cancel       = 개설 취소 (개설 완료된 라인의 취소) — 향후 기능, 값만 예약
  action text NOT NULL
    CHECK (action IN ('apply', 'apply_cancel', 'review', 'reject', 'open', 'cancel')),

  -- 참조(무 FK·nullable) — 라인/주차/대상자가 삭제돼도 로그는 보존.
  draft_id        uuid NULL,
  week_id         uuid NULL,
  target_user_id  uuid NULL,
  organization_slug text NULL,

  -- 표시값(쓰기 시점 denormalize) — 실행자 계정 기준 소속.
  period_label      text NOT NULL,  -- "26년 여름 시즌 1주차"
  team_name         text NULL,      -- 실행자 user_profiles.current_team_name
  part_name         text NULL,      -- 실행자 user_profiles.current_part_name
  actor_crew_status text NULL,      -- memberStatusLabel(role, membership_level) — "팀장"/"심화(파트장)" 등
  actor_name        text NOT NULL,  -- 실행자 display_name

  changed_by uuid NULL,             -- 실행 어드민(auth.users.id)
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cluster4_experience_opening_logs
  IS '실무 경험 라인 개설 행동 이력(append-only) — 신청/검수/반려/완료/취소. denormalized 표시값, 수정/삭제 금지.';
COMMENT ON COLUMN public.cluster4_experience_opening_logs.action
  IS 'apply=개설신청, review=개설검수, reject=검수반려, open=개설완료, cancel=개설취소(향후).';
COMMENT ON COLUMN public.cluster4_experience_opening_logs.team_name
  IS '실행한 어드민 계정의 크루 소속 팀(실행자 기준).';

-- ── 조회용 인덱스 (org + 주차 + 최신순) ──
CREATE INDEX IF NOT EXISTS cluster4_experience_opening_logs_org_week_idx
  ON public.cluster4_experience_opening_logs (organization_slug, week_id, created_at DESC);

CREATE INDEX IF NOT EXISTS cluster4_experience_opening_logs_created_idx
  ON public.cluster4_experience_opening_logs (created_at DESC);

-- ── 읽기 권한(로그창 표시 전용). write 는 service_role(supabaseAdmin)만. ──
GRANT SELECT ON public.cluster4_experience_opening_logs TO anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 검증 (DML 아님 — 참고용)
-- ═══════════════════════════════════════════════════════════════════════
/*
SELECT action, period_label, team_name, part_name, actor_crew_status, actor_name, created_at
FROM public.cluster4_experience_opening_logs
ORDER BY created_at DESC
LIMIT 20;
*/

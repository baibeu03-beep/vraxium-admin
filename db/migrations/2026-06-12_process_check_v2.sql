-- 2026-06-12_process_check_v2.sql
-- 프로세스 체크 [실무 정보 급 등] 체크 상태 관리 시스템 — 정식 스키마(needed|pending|completed).
--
-- 정책 (2026-06-12 — 체크 동작 Phase):
--   - org × hub × week × act 단위 "체크 상태"(현재값) + append-only "행동 이력".
--   - 마스터(process_line_groups · process_acts)와 분리 — 마스터는 SoT 그대로.
--   - 상태: needed(체크 필요) → pending(체크 대기, 신청 후) → completed(체크 완료, 검수/포인트 후).
--     · request : needed → pending  (review_link + scheduled_check_at 입력, requested_at=now)
--     · cancel  : pending → needed  (now < scheduled_check_at 일 때만 · 입력값 제거)
--     · complete: pending → completed (검수 프로그램/포인트 반영 시스템이 기록 — 본 Phase 미구현)
--   - ⚠ user_weekly_points.points 자동 합산 · 주차 성장 계산 · snapshot 생성/조회 · checkGate 무접촉.
--     포인트 부여/크롤링 연동은 본 Phase 범위 밖 — completed 저장 컬럼(completed_at·checked_crew_count)만 정의.
--   - write 는 service_role(admin API) 경유만.
--
-- ⚠ 스펙의 최소 컬럼 목록에 더해 org/week 스코핑(organization_slug·hub·week_id·line_group_id)을 추가했다.
--    같은 액트라도 조직/주차마다 체크 상태가 달라야 하므로(org별 분기·이번 주 고정) 필수.
--
-- 선행(잘못된 스키마: requested|cancelled|completed) 테이블을 교체한다. 비어 있으면 안전, 데이터가 있어도
-- 본 Phase 정식 스키마로 재시작한다. Idempotent — 재실행 안전. Supabase SQL Editor 에서 수동 실행.

DROP TABLE IF EXISTS public.process_check_logs;
DROP TABLE IF EXISTS public.process_check_statuses;

-- ── 체크 상태 (현재값 — org × hub × week × act 당 1행) ────────────────────────
CREATE TABLE public.process_check_statuses (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  organization_slug  text NOT NULL,
  hub                text NOT NULL
    CHECK (hub IN ('club', 'info', 'experience', 'competency', 'career')),
  week_id            uuid NOT NULL,

  line_group_id      uuid NOT NULL REFERENCES public.process_line_groups(id) ON DELETE CASCADE,
  act_id             uuid NOT NULL REFERENCES public.process_acts(id) ON DELETE CASCADE,

  status             text NOT NULL DEFAULT 'needed'
    CHECK (status IN ('needed', 'pending', 'completed')),

  review_link        text NULL,         -- 네이버 카페 게시물 링크(신청 시 입력)
  scheduled_check_at timestamptz NULL,  -- 검수 예정 시각(신청 시 입력 · now<scheduled<=now+7d)
  requested_at       timestamptz NULL,  -- 신청 시각(now)
  completed_at       timestamptz NULL,  -- 검수/포인트 반영 완료 시각(후속 Phase)
  checked_crew_count integer NULL,      -- 실제 검수 완료 인원 수(후속 Phase)
  requested_by       uuid NULL,         -- 신청 실행 어드민(auth.users.id)

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organization_slug, hub, week_id, act_id)
);

CREATE INDEX idx_process_check_statuses_scope
  ON public.process_check_statuses (organization_slug, hub, week_id);
CREATE INDEX idx_process_check_statuses_act
  ON public.process_check_statuses (act_id);

-- ── 체크 행동 이력 (append-only) ──────────────────────────────────────────────
CREATE TABLE public.process_check_logs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  organization_slug text NOT NULL,
  hub               text NOT NULL
    CHECK (hub IN ('club', 'info', 'experience', 'competency', 'career')),
  week_id           uuid NULL,
  act_id            uuid NULL,
  line_group_id     uuid NULL,

  action            text NOT NULL
    CHECK (action IN ('check_requested', 'check_cancelled', 'check_completed')),

  -- 표시값(쓰기 시점 denormalize) — 주차/액트/프로필이 바뀌어도 이력 보존.
  period_label      text NOT NULL,  -- "26년 여름 시즌 2주차"
  line_group_name   text NOT NULL,
  act_name          text NOT NULL,
  actor_name        text NOT NULL,

  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_process_check_logs_scope
  ON public.process_check_logs (organization_slug, hub, week_id, created_at);
CREATE INDEX idx_process_check_logs_created
  ON public.process_check_logs (created_at DESC);

-- ── updated_at touch (마스터 마이그레이션 함수 재사용, idempotent) ────────────────
CREATE OR REPLACE FUNCTION public.touch_process_master_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_process_check_statuses_touch ON public.process_check_statuses;
CREATE TRIGGER trg_process_check_statuses_touch
  BEFORE UPDATE ON public.process_check_statuses
  FOR EACH ROW EXECUTE FUNCTION public.touch_process_master_updated_at();

COMMENT ON TABLE public.process_check_statuses IS
  '프로세스 체크 상태(현재값) — org×hub×week×act 당 1행. needed/pending/completed. 마스터 분리 · user_weekly_points/snapshot/checkGate 무접촉(2026-06-12 체크 Phase). 포인트/크롤링 연동은 후속 Phase.';
COMMENT ON TABLE public.process_check_logs IS
  '프로세스 체크 행동 이력(append-only) — check_requested/check_cancelled/check_completed. denormalized 표시값, 수정/삭제 금지.';

GRANT SELECT ON public.process_check_statuses TO anon, authenticated;
GRANT SELECT ON public.process_check_logs TO anon, authenticated;

-- PostgREST 스키마 캐시 즉시 리로드(신규 컬럼이 REST 로 바로 보이도록).
NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════
-- 검증 (참고용)
-- ═══════════════════════════════════════════════════════════════════════
/*
SELECT organization_slug, status, count(*) FROM public.process_check_statuses GROUP BY 1,2 ORDER BY 1,2;
SELECT action, period_label, line_group_name, act_name, actor_name, created_at
FROM public.process_check_logs ORDER BY created_at DESC LIMIT 20;
*/

-- 주차 검수 상태 SoT 를 (week_id, organization_slug, scope) 로 확장.
--   scope: 'operating'(운영 코호트 검수) / 'test'(테스트 코호트 검수) — 서로 독립.
--   운영/테스트는 같은 검수 흐름·같은 DTO 를 쓰되 대상 코호트만 다르다. 카드 표시는
--   "그 사용자의 scope(test-marker 여부)"에 맞는 행을 읽는다. QA_HIDE_REAL_USERS=true 동안
--   운영 화면 검수는 test 코호트를 대상으로 하므로 scope='test' 로 기록된다.
--   기존 (week_id, organization_slug) 행은 scope='operating' 로 승격되며, 상태 재도출은
--   scripts/migrate-week-org-result-states-scope.ts 가 담당한다(test-marker·finalize run provenance 기반).
--   idempotent.

ALTER TABLE public.cluster4_week_org_result_states
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'operating';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cluster4_week_org_result_states_scope_chk'
  ) THEN
    ALTER TABLE public.cluster4_week_org_result_states
      ADD CONSTRAINT cluster4_week_org_result_states_scope_chk
      CHECK (scope IN ('operating','test'));
  END IF;
END $$;

ALTER TABLE public.cluster4_week_org_result_states
  DROP CONSTRAINT IF EXISTS cluster4_week_org_result_states_pkey;

ALTER TABLE public.cluster4_week_org_result_states
  ADD CONSTRAINT cluster4_week_org_result_states_pkey
  PRIMARY KEY (week_id, organization_slug, scope);

COMMENT ON COLUMN public.cluster4_week_org_result_states.scope IS
  '검수 코호트 scope(operating/test). 운영/테스트 검수 상태는 독립. 카드 표시는 대상 사용자 scope 로 읽는다.';

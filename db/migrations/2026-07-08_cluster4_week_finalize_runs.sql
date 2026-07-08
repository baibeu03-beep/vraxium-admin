-- 2026-07-08_cluster4_week_finalize_runs.sql
-- 검수 완료(주차 결과 확정) 시 생성/갱신한 user_week_statuses(uws) 의 provenance 로그.
--
-- 목적:
--   2026-summer 이후 운영 주차의 검수 완료는 코호트(시즌 참여자)의 주차 verdict 를
--   user_week_statuses 에 upsert 한다(생성 또는 status 갱신). 실행 취소(↩) 시 정확히
--   되돌리기 위해, "이번 실행이 무엇을 생성했고 무엇을 어떤 값에서 바꿨는지"를 기록한다.
--
-- 정책:
--   - run 1건 = (week_id) 검수 완료 1회. 최신 run 이 롤백 대상(같은 주차 재실행 시 새 run append).
--   - created_uws_ids  = 이 실행이 새로 INSERT 한 uws.id[] → 롤백 시 DELETE.
--   - updated_uws      = 이 실행이 status 를 바꾼 기존 uws [{id, prev_status}] → 롤백 시 prev 로 복원.
--   - 레거시 uws·이관 uws 는 대상 아님(생성 단계가 레거시 주차를 스킵하므로 로그에도 안 남음).
--   - reverted_at 세팅 = 이미 되돌린 run(재롤백 방지·멱등).
--
-- 재실행 안전: CREATE TABLE IF NOT EXISTS.
-- 미적용 시: uws 생성은 동작하되 롤백이 "생성분 삭제"를 못 하므로, 코드가 테이블 부재를
--   감지하면 검수 완료를 안전하게 진행하되 provenance 미기록을 경고 로그로 남긴다(롤백 제한).

BEGIN;

CREATE TABLE IF NOT EXISTS public.cluster4_week_finalize_runs (
  id                 uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  week_id            uuid         NOT NULL,
  -- 확정 스코프 기록(감사용): 전역 공표라 org 는 참고값(전체 org 코호트 대상).
  scope              text         NOT NULL DEFAULT 'operating'
                       CHECK (scope IN ('operating','qa')),
  actor_id           uuid         NULL,
  -- 이 실행이 새로 만든 uws.id 배열(롤백 시 DELETE 대상).
  created_uws_ids    uuid[]       NOT NULL DEFAULT '{}',
  -- 이 실행이 status 를 바꾼 기존 uws: [{ "id": uuid, "prev_status": text }, ...] (롤백 시 복원).
  updated_uws        jsonb        NOT NULL DEFAULT '[]'::jsonb,
  -- 요약 카운트(관찰용).
  cohort_count       integer      NOT NULL DEFAULT 0,
  success_count      integer      NOT NULL DEFAULT 0,
  fail_count         integer      NOT NULL DEFAULT 0,
  rest_count         integer      NOT NULL DEFAULT 0,
  skipped_count      integer      NOT NULL DEFAULT 0,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  -- 롤백 완료 시각(멱등·재롤백 방지). NULL = 아직 유효한 run.
  reverted_at        timestamptz  NULL
);

-- 주차별 최신 run 조회(롤백 대상 선택)용.
CREATE INDEX IF NOT EXISTS cluster4_week_finalize_runs_week_created_idx
  ON public.cluster4_week_finalize_runs (week_id, created_at DESC);

GRANT SELECT ON public.cluster4_week_finalize_runs TO anon, authenticated;

COMMENT ON TABLE public.cluster4_week_finalize_runs
  IS '검수 완료 시 생성/갱신한 user_week_statuses provenance(실행 취소 정확 복원용). 2026-summer+ 운영 주차 전용.';

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK (필요 시)
-- ═══════════════════════════════════════════════════════════════════════
/*
BEGIN;
DROP TABLE IF EXISTS public.cluster4_week_finalize_runs;
COMMIT;
*/

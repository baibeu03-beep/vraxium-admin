-- 2026-07-24_experience_opening_logs_reapply.sql
-- 실무 경험 라인 개설 로그 action 에 'reapply'(개설 재신청)를 추가한다.
--
-- 기존 로그는 수정하거나 재분류하지 않는다. 적용 이후 파트 신청 POST 시 서버가 mutation 직전에
-- 확인한 기존 신청 헤더 존재 여부로 apply/reapply 를 구분해 신규 행에 기록한다.
-- 다른 라인 유형의 로그 테이블·이벤트는 변경하지 않는다.
--
-- 적용: 운영 DB(Supabase SQL Editor)에서 수동 실행. 재실행 안전(idempotent).

BEGIN;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.cluster4_experience_opening_logs'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%action%'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.cluster4_experience_opening_logs DROP CONSTRAINT %I',
      r.conname
    );
  END LOOP;
END $$;

ALTER TABLE public.cluster4_experience_opening_logs
  ADD CONSTRAINT cluster4_experience_opening_logs_action_check
  CHECK (
    action IN (
      'apply',
      'reapply',
      'apply_cancel',
      'review',
      'reject',
      'review_cancel',
      'open',
      'cancel'
    )
  );

COMMENT ON COLUMN public.cluster4_experience_opening_logs.action
  IS 'apply=개설 신청, reapply=개설 재신청, apply_cancel=개설 신청 취소, review=개설 검수 완료, reject=레거시 Draft 검수 반려, review_cancel=개설 검수 취소, open=개설 완료, cancel=개설 취소.';

COMMIT;

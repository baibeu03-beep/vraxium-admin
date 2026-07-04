-- 2026-07-04_process_check_logs_rollback_action.sql
-- process_check_logs.action CHECK 제약에 'check_rolled_back'(↩ 실행 취소) 값을 추가한다.
--
-- 배경: 기존 CHECK 는 ('check_requested','check_cancelled','check_completed') 3값만 허용했다.
--   ↩ 실행 취소(완료→대기 되돌림)를 로그창에 "실행 취소 · 관리자 이름" 으로 시간순 기록하려면
--   전용 액션값이 필요하다. 미적용 상태에서도 코드는 check_cancelled 로 폴백 기록하므로(로그 유실
--   방지), 이 마이그레이션 적용 후에야 정식 라벨("실행 취소")로 남는다.
--
-- 멱등: 제약을 DROP IF EXISTS 후 재생성. 여러 번 실행해도 동일 결과.

ALTER TABLE public.process_check_logs
  DROP CONSTRAINT IF EXISTS process_check_logs_action_check;

ALTER TABLE public.process_check_logs
  ADD CONSTRAINT process_check_logs_action_check
  CHECK (action IN ('check_requested', 'check_cancelled', 'check_completed', 'check_rolled_back'));

-- 확인용(적용 후 수동 실행):
-- SELECT action, count(*) FROM public.process_check_logs GROUP BY action ORDER BY action;

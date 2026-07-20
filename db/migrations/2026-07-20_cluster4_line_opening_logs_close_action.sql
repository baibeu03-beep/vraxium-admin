-- 라인 개설 로그에 "2차 기입 마감"(force-close) 액션 + 감사 note 컬럼 추가.
--
-- 배경(2026-07-20): 라인 개설 후 submission_closes_at 을 현재 시각으로 단축하는
--   수동 "2차 기입 마감"(force-close) 동작을 도입한다. 이 조기 마감 이벤트를 기존 라인 개설
--   로그(append-only audit)에 action='close' 로 남기고, 감사 정보(기존 마감 시각 → 변경 마감 시각)를
--   note 컬럼에 denormalized 로 보존한다.
--
-- 안전성: 코드 배포 전/후 어느 시점이든 안전.
--   · 컬럼/CHECK 미적용 상태에서 close 로그 write 는 best-effort skip(라인 마감 본 동작은 정상).
--   · note 미적용 상태에서도 write 는 note 없이 재시도(graceful, cafe_* 패턴과 동일).
--
-- 적용: 운영 DB(Supabase SQL Editor)에서 수동 실행.

BEGIN;

-- 1) action CHECK 에 'close' 추가.
ALTER TABLE public.cluster4_line_opening_logs
  DROP CONSTRAINT IF EXISTS cluster4_line_opening_logs_action_check;
ALTER TABLE public.cluster4_line_opening_logs
  ADD CONSTRAINT cluster4_line_opening_logs_action_check
  CHECK (action IN ('open', 'cancel', 'close'));

-- 2) 감사용 note 컬럼(선택) — 예: "기존 마감 2026-07-24 22:00 → 변경 마감 2026-07-20 15:03".
ALTER TABLE public.cluster4_line_opening_logs
  ADD COLUMN IF NOT EXISTS note text NULL;

COMMIT;

/*
-- 롤백
BEGIN;
ALTER TABLE public.cluster4_line_opening_logs
  DROP CONSTRAINT IF EXISTS cluster4_line_opening_logs_action_check;
ALTER TABLE public.cluster4_line_opening_logs
  ADD CONSTRAINT cluster4_line_opening_logs_action_check
  CHECK (action IN ('open', 'cancel'));
ALTER TABLE public.cluster4_line_opening_logs
  DROP COLUMN IF EXISTS note;
COMMIT;
*/

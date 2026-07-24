-- 2026-07-23_experience_overall_review_reset.sql
-- 실무 경험 [개설 검수] 무효화(검수 취소) 지원 — 팀 총괄 status='none' + 개설 로그 action='review_cancel'.
--
-- 배경(2026-07-23): 관리자가 [개설 검수]를 완료한 뒤 파트장이 자기 파트 탭에서 개설 신청 데이터를
--   실제로 변경하면, 이미 검수된 데이터와 저장 데이터가 어긋난다. 이때 검수 상태를 즉시 취소해
--   관리자가 다시 [개설 검수]를 수행하도록 만든다.
--
--   · 종전 status CHECK 는 ('reviewed','opened') 뿐이라 "검수 이전"을 표현할 수 없었다
--     (헤더 행이 없을 때만 검수 전). 검수 취소 시 헤더를 지우면 팀장이 입력한 관리/확장 셀과
--     아웃풋(cluster4_experience_team_overall_cells / _outputs)이 CASCADE 로 함께 사라진다.
--     → status='none' 을 허용해 헤더/입력값은 보존하고 상태만 "검수 전"으로 되돌린다.
--     (DTO 는 이미 OverallBoardStatus = 'none'|'reviewed'|'opened' 로 none 을 표현한다.)
--   · 로그는 append-only 감사 기록이므로 'review_cancel'(검수 취소) 액션을 추가한다.
--
-- 안전성: 코드 배포 전/후 어느 시점이든 안전.
--   · 기존 행(reviewed/opened)은 그대로 통과 — 값 변경/백필 없음.
--   · **미적용 상태에서도 기능은 동작한다** — status='none' UPDATE 가 거부되면 코드가
--     reviewed_at=NULL sentinel 로 폴백하고, 판독(lib/experienceReviewResetPolicy.resolveOverallStatus)이
--     두 표현을 모두 'none' 으로 읽는다. 적용하면 그때부터 정식 'none' 이 기록된다(둘 다 호환).
--   · 로그 write 는 best-effort 라 action CHECK 미적용 상태에서는 검수 취소 로그만 생략된다.
--   · CHECK 를 넓히기만 하므로 기존 write 경로는 전부 그대로 통과한다.
--
-- 적용: 운영 DB(Supabase SQL Editor)에서 수동 실행. 재실행 안전(idempotent).

BEGIN;

-- 1) 팀 총괄 status 에 'none'(검수 전 = 검수 취소 결과) 추가.
--    제약 이름이 환경별로 다를 수 있어 status 를 참조하는 CHECK 를 이름 무관하게 정리 후 재생성한다.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.cluster4_experience_team_overall'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.cluster4_experience_team_overall DROP CONSTRAINT %I',
      r.conname
    );
  END LOOP;
END $$;

ALTER TABLE public.cluster4_experience_team_overall
  ADD CONSTRAINT cluster4_experience_team_overall_status_check
  CHECK (status IN ('none', 'reviewed', 'opened'));

COMMENT ON COLUMN public.cluster4_experience_team_overall.status
  IS '''none'' = 검수 전(검수 취소 포함 — 헤더/입력값은 보존), ''reviewed'' = 개설 검수(고객 미반영), ''opened'' = 개설 완료(고객 반영).';

-- 2) 개설 로그 action 에 'review_cancel'(검수 취소) 추가.
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
  CHECK (action IN ('apply', 'apply_cancel', 'review', 'reject', 'review_cancel', 'open', 'cancel'));

COMMIT;

/*
-- 롤백(검수 취소 기능 제거 시). status='none' 행이 남아 있으면 먼저 정리해야 한다.
BEGIN;
DELETE FROM public.cluster4_experience_team_overall WHERE status = 'none';
ALTER TABLE public.cluster4_experience_team_overall
  DROP CONSTRAINT IF EXISTS cluster4_experience_team_overall_status_check;
ALTER TABLE public.cluster4_experience_team_overall
  ADD CONSTRAINT cluster4_experience_team_overall_status_check
  CHECK (status IN ('reviewed', 'opened'));
DELETE FROM public.cluster4_experience_opening_logs WHERE action = 'review_cancel';
ALTER TABLE public.cluster4_experience_opening_logs
  DROP CONSTRAINT IF EXISTS cluster4_experience_opening_logs_action_check;
ALTER TABLE public.cluster4_experience_opening_logs
  ADD CONSTRAINT cluster4_experience_opening_logs_action_check
  CHECK (action IN ('apply', 'apply_cancel', 'review', 'reject', 'open', 'cancel'));
COMMIT;
*/

-- 라인 강화 결과 확정 마커 — 자동 48h 스윕의 멱등/중복처리 방지용.
--
-- 배경(2026-07-20): 라인의 submission_closes_at 이 개설+48h(또는 수동 조기 마감)로 지나면,
--   info/competency 는 그 시점에 강화 성공이 확정되지만 원장(process_point_awards)은 reconcile
--   실행이 있어야 갱신된다. 이를 48h 시점에 자동 지급하는 run-due 스윕이 "이미 확정한 라인"을 매 폴링
--   재처리하지 않도록, 확정 완료 시각을 이 컬럼에 기록한다(프로세스 체크의 status='completed' 대응).
--
-- 의미:
--   · NULL          = 아직 결과 미확정(스윕 대상 후보).
--   · timestamptz   = finalizeLineResultAwards 가 지급 정합을 마친 시각(스윕 제외).
--   재-reconcile 자체는 원장 upsert(onConflict) 로 멱등이라, 마커는 성능 최적화이지 정합의 전제가 아니다
--   (마커가 없어도 이중지급은 발생하지 않는다). 주차 공표(publishWeekResult) 경로는 마커와 무관하게
--   항상 전원 재정합하므로, 스윕이 놓친 라인도 공표 시 반드시 지급된다.
--
-- 적용: 운영 DB(Supabase SQL Editor)에서 수동 실행. 코드 배포 전/후 안전(컬럼 미존재 시 스윕은 후보를
--   못 좁혀 재처리만 늘 뿐 정합은 유지 — 배포 후 조속 적용 권장).

BEGIN;

ALTER TABLE public.cluster4_lines
  ADD COLUMN IF NOT EXISTS result_finalized_at timestamptz NULL;

-- 스윕 후보 조회 인덱스: 활성 + 미확정 + 마감 지남.
CREATE INDEX IF NOT EXISTS cluster4_lines_due_close_sweep_idx
  ON public.cluster4_lines (part_type, is_active, result_finalized_at, submission_closes_at);

COMMIT;

/*
-- 롤백
BEGIN;
DROP INDEX IF EXISTS public.cluster4_lines_due_close_sweep_idx;
ALTER TABLE public.cluster4_lines DROP COLUMN IF EXISTS result_finalized_at;
COMMIT;
*/

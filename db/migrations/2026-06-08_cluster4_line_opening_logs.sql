-- 실무 정보 라인 개설 [섹션 0] 로그창 — 라인 개설/취소 이력(append-only audit).
--
-- info 라인의 개설(open)/취소(cancel) 이벤트를 기록한다. 로그만으로 이력 추적이 가능하도록
-- 표시값(activity_label/period_label/actor_name)을 denormalized 로 보존하며, 라인/주차가 삭제돼도
-- 로그가 남도록 FK cascade 를 두지 않는다. append-only(수정/삭제 금지).
--
-- 어드민 메타데이터로 고객 weekly-cards DTO/스냅샷 계산과 무관하다. 로그 insert 는 snapshot
-- invalidate/recompute 를 트리거하지 않는다(데이터 레이어가 invalidate 미호출).
--
-- 적용: 운영 DB(Supabase SQL Editor)에서 수동 실행. 코드 배포 전/후 어느 시점이든 안전
-- (테이블 미존재 시 read=빈 목록, write=best-effort skip — 라인 open/cancel 본 동작은 정상).

CREATE TABLE IF NOT EXISTS public.cluster4_line_opening_logs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action           text NOT NULL CHECK (action IN ('open', 'cancel')),
  line_id          uuid NULL,            -- 참조용(삭제돼도 로그 유지 → FK/cascade 없음)
  week_id          uuid NULL,            -- 참조용
  activity_type_id text NULL,            -- 현재 활동유형 탭 필터 기준(예: 'wisdom')
  activity_label   text NOT NULL,        -- 표시용 denormalized (예: 위즈덤)
  period_label     text NOT NULL,        -- 표시용 denormalized (예: 26년 여름 시즌 1주차)
  changed_by       uuid NULL,            -- 실행 어드민(참조)
  actor_name       text NOT NULL,        -- 표시용 denormalized (예: 홍길동)
  created_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cluster4_line_opening_logs IS
  '실무 정보 라인 개설/취소 이력(append-only, 어드민 메타 — 고객 DTO/스냅샷 무관). 라인 삭제돼도 보존.';

CREATE INDEX IF NOT EXISTS cluster4_line_opening_logs_activity_idx
  ON public.cluster4_line_opening_logs (activity_type_id, created_at DESC);

CREATE INDEX IF NOT EXISTS cluster4_line_opening_logs_created_idx
  ON public.cluster4_line_opening_logs (created_at DESC);

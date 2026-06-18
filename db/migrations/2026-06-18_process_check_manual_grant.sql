-- 2026-06-18_process_check_manual_grant.sql
-- 프로세스 체크 — "선별(selection) 액트 수동 부여" 컬럼 추가. ADDITIVE — 기존 스키마 보존.
--
-- 배경 (2026-06-18 — 선별 액트 수동 부여 Phase):
--   정규 기준표(process_acts)의 액트 종류(act_type) = '선별(selection)' 인 액트는 "체크 필요"
--   클릭 시 [검수 신청] / [수동 부여] 를 선택할 수 있다(변동 액트 페이지와 동일 방식).
--     · 검수 신청(review_request) = 기존 그대로 — needed→pending(review_link/scheduled_check_at),
--       worker 가 검수 시점 이후 크롤링·완료. (변경 없음)
--     · 수동 부여(manual_grant)   = 관리자가 대상 크루 + 포인트(A/B/C)를 직접 입력해 즉시 완료.
--       마스터 점수가 아니라 "자유 입력" 점수를 쓰므로 상태 행에 override 점수를 저장한다.
--
--   ⚠ '선별' 액트는 규칙상 포인트 C(미이행 페널티) = 0 강제(reactionAllowsPointC).
--   ⚠ 한 액트당 상태 행은 (org,hub,week,act,team) 1행(UNIQUE 인덱스). 수동 부여는 그 행을
--      status='completed' + completion_type='manual_grant' 로 각인하고, 대상 크루는 기존
--      process_check_review_recipients(source='regular', ref_id=status.id, match_type='matched') 에
--      저장한다(중복 부여 방지 = 같은 ref_id 내 user_id 중복 스킵 + 원장 UNIQUE).
--   ⚠ 포인트 적립/주차 성장/snapshot 반영은 lib/processPointAccrual(accrueForCompletedRegular)
--      단일 SoT 재사용 — 수동 부여 점수는 아래 manual_point_* 를 우선 사용한다.
--
-- Idempotent — 재실행 안전. Supabase SQL Editor 에서 수동 실행.

ALTER TABLE public.process_check_statuses
  -- 완료 경로 구분 — NULL(검수/일반 완료) / 'manual_grant'(관리자 수동 부여).
  ADD COLUMN IF NOT EXISTS completion_type        text NULL
    CHECK (completion_type IS NULL OR completion_type IN ('manual_grant')),
  -- 수동 부여 override 점수(A/B/C) — manual_grant 일 때만 채움. 마스터(process_acts) 대신 사용.
  --   '선별' 규칙상 C=0 고정이지만, 컬럼 제약은 0~20 으로 둔다(앱 레이어에서 0 강제).
  ADD COLUMN IF NOT EXISTS manual_point_check     smallint NULL
    CHECK (manual_point_check     IS NULL OR manual_point_check     BETWEEN 0 AND 20),
  ADD COLUMN IF NOT EXISTS manual_point_advantage smallint NULL
    CHECK (manual_point_advantage IS NULL OR manual_point_advantage BETWEEN 0 AND 20),
  ADD COLUMN IF NOT EXISTS manual_point_penalty   smallint NULL
    CHECK (manual_point_penalty   IS NULL OR manual_point_penalty   BETWEEN 0 AND 20),
  -- 수동 부여 표시/관리용 메타(액트 신청 사유 · 소요 시간).
  ADD COLUMN IF NOT EXISTS manual_reason          text NULL,
  ADD COLUMN IF NOT EXISTS manual_duration_minutes integer NULL
    CHECK (manual_duration_minutes IS NULL OR manual_duration_minutes BETWEEN 1 AND 600);

COMMENT ON COLUMN public.process_check_statuses.completion_type IS
  '완료 경로 — NULL(검수/worker 완료) / manual_grant(관리자 수동 부여). 선별(selection) 액트만 manual_grant 사용(2026-06-18).';
COMMENT ON COLUMN public.process_check_statuses.manual_point_check IS
  '수동 부여 override 포인트 A(check). manual_grant 일 때 accrueForCompletedRegular 가 마스터 대신 사용.';

-- PostgREST 스키마 캐시 즉시 리로드(신규 컬럼이 REST 로 바로 보이도록).
NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════
-- 검증 (참고용)
-- ═══════════════════════════════════════════════════════════════════════
/*
SELECT column_name FROM information_schema.columns
 WHERE table_name='process_check_statuses'
   AND column_name IN ('completion_type','manual_point_check','manual_point_advantage',
                       'manual_point_penalty','manual_reason','manual_duration_minutes')
 ORDER BY column_name;

SELECT organization_slug, hub, completion_type, count(*)
FROM public.process_check_statuses
WHERE completion_type IS NOT NULL
GROUP BY 1,2,3 ORDER BY 1,2,3;
*/

-- 2026-07-09_vacation_requests_request_type.sql
-- 크루 휴식 신청(vacation_requests) 에 "정상/긴급" 구분 컬럼 추가.
--
-- 배경: /admin/rest-management 요약 집계에서 정상 휴식 / 긴급 휴식 건수를 나눠 보여준다.
--   기존 스키마에는 신청 종류를 담을 컬럼이 없었다(status 는 승인 상태 전용).
--
-- 정책:
--   - request_type = 'normal' → 정상 휴식 신청 (고객앱 /vacation 일반 신청)
--   - request_type = 'urgent' → 긴급 휴식 신청 (다음 작업에서 저장)
--   - DEFAULT 'normal' — 고객앱이 request_type 을 지정하지 않고 INSERT 해도 자동으로 정상 처리.
--     (front repo 무변경 — 컬럼 default 로 충족)
--   - status 는 pending/approved/rejected 등 "승인 상태" 로만 계속 사용. 정상/긴급 구분에 쓰지 않는다.
--
-- 의존성: vacation_requests
-- Idempotent — 재실행 안전.

ALTER TABLE public.vacation_requests
  ADD COLUMN IF NOT EXISTS request_type text NOT NULL DEFAULT 'normal';

COMMENT ON COLUMN public.vacation_requests.request_type
  IS '휴식 신청 종류: normal(정상) | urgent(긴급). status(승인 상태)와 무관. 기본값 normal.';

-- CHECK 제약 (ADD CONSTRAINT 는 IF NOT EXISTS 미지원 → 존재 확인 후 추가).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.vacation_requests'::regclass
      AND conname = 'vacation_requests_request_type_check'
  ) THEN
    ALTER TABLE public.vacation_requests
      ADD CONSTRAINT vacation_requests_request_type_check
      CHECK (request_type IN ('normal', 'urgent'));
  END IF;
END $$;

-- 조회 최적화: org + season_key 로 요약 집계하므로 복합 인덱스(존재 시 skip).
CREATE INDEX IF NOT EXISTS vacation_requests_org_season_idx
  ON public.vacation_requests (org, season_key);

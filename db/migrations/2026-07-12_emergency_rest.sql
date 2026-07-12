-- 2026-07-12_emergency_rest.sql
-- 긴급 휴식 신청(Emergency Rest Request) — /admin/rest-management 의 [긴급 휴식 신청].
--
-- 정책:
--   · 긴급 휴식 = vacation_requests.request_type='urgent' (2026-07-09 마이그레이션에서 추가).
--   · 대상 크루 = 기존 user_id 컬럼 그대로. 아래 3개 컬럼은 "추적/링크"용 부가 정보다.
--       - requested_by_user_id : 대신 신청한 운영진(팀장/앰배서더/관리자)의 user_id.
--                                ⚠ 클라이언트 입력 신뢰 금지 — 서버 actor resolver 가 결정한다.
--       - week_id              : 대상 주차의 canonical weeks.id(포인트 적립 주차 산식 재사용).
--       - po_c_act_id          : 긴급 휴식 Po.C(×2) 지급용 내부 변동 액트(process_irregular_acts.id).
--   · Po.C 지급은 기존 irregular-act 파이프라인 재사용. 단, 그 액트는 origin='emergency_rest'
--     로 표식해 /admin/processes/check/irregular 보드에서만 숨긴다(크루 Detail Log·주간 포인트엔
--     정상 반영 — 그 경로는 process_point_awards 원장을 읽으므로 무영향).
--
-- 모두 NULLABLE — 기존 일반 휴식 신청 데이터/DTO 와 고객 front /vacation(별도 repo)의 SELECT * 를
--   깨뜨리지 않는다. 코드는 42703(컬럼 미존재) graceful 폴백을 유지하므로 미적용 상태에서도
--   페이지가 동작한다(긴급 신청만 불가).
--
-- Idempotent. Supabase SQL Editor 에서 수동 실행([[project_manual-migrations]]).

ALTER TABLE public.vacation_requests
  ADD COLUMN IF NOT EXISTS requested_by_user_id uuid NULL;
ALTER TABLE public.vacation_requests
  ADD COLUMN IF NOT EXISTS week_id uuid NULL;
ALTER TABLE public.vacation_requests
  ADD COLUMN IF NOT EXISTS po_c_act_id uuid NULL;

-- 변동 액트 표식 — 긴급 휴식으로 자동 생성된 Po.C 지급 액트를 보드에서 숨기기 위한 origin.
--   NULL = 일반 변동 액트(기존). 'emergency_rest' = 긴급 휴식 자동 생성.
ALTER TABLE public.process_irregular_acts
  ADD COLUMN IF NOT EXISTS origin text NULL;

-- 동일 크루·동일 주차 휴식 중복 방지(앱에서도 409 로 선검증 — DB 는 belt-and-suspenders).
--   기존 데이터에 (user_id, week_start_date) 중복이 있으면 인덱스 생성이 실패할 수 있다.
--   그 경우 중복 정리 후 재실행하거나, 아래 인덱스만 건너뛰어도 앱 레벨 dedup 으로 동작한다.
CREATE UNIQUE INDEX IF NOT EXISTS uq_vacation_crew_weekstart
  ON public.vacation_requests (user_id, week_start_date);

COMMENT ON COLUMN public.vacation_requests.requested_by_user_id IS
  '긴급 휴식을 대신 신청한 운영진(user_profiles.user_id). 서버 actor resolver 가 결정(클라 입력 신뢰 금지). 일반 신청은 NULL.';
COMMENT ON COLUMN public.vacation_requests.week_id IS
  '대상 주차 canonical weeks.id. 긴급 휴식 Po.C 적립 주차(iso_year/iso_week) 산식에 사용. 일반 신청은 NULL 가능.';
COMMENT ON COLUMN public.vacation_requests.po_c_act_id IS
  '긴급 휴식 Po.C(×2) 지급용 process_irregular_acts.id(origin=emergency_rest). 재시도 idempotency/회수 링크.';
COMMENT ON COLUMN public.process_irregular_acts.origin IS
  '자동 생성 출처. NULL=일반 변동 액트, ''emergency_rest''=긴급 휴식 Po.C 지급 액트(보드에서 숨김·Detail Log/포인트엔 정상 반영).';

-- PostgREST 스키마 캐시 즉시 리로드.
NOTIFY pgrst, 'reload schema';

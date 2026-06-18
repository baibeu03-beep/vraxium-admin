-- 2026-06-15_process_irregular_acts.sql
-- 통합 > 허브별 프로세스 > 프로세스 체크 · 변동 액트 (/admin/processes/check/irregular?org=...).
--
-- 정책 (2026-06-15 — 변동 액트 Phase):
--   - 정규 액트 기준표(process_acts)에 없는 "변동 액트"의 검수 신청 / 수동 부여 내역을 저장.
--   - 정규 액트와 분리 — process_acts 마스터는 SoT 그대로(FK·집계 오염 금지). 본 테이블은
--     주차·org·대상자 단위의 개별 인스턴스(신청자·사유·소요시간을 가진 ad-hoc 행)이다.
--   - 신청자(applicant) = 운영진(어드민 로그인 계정). 대상자(target) = 고객앱 사용자.
--       · applicant_admin_id   → public.admin_users.id (현재 로그인 어드민, 자동 기록)
--       · target_user_id       → public.user_profiles.user_id (포인트/검수 대상 고객)
--     ⚠ test/operating 모드 분리 + org 분리는 target_user_id 기준으로 강제(applicant 는 판정 제외).
--   - 종류(kind): review_request(검수 신청) → status='pending'(이후 완료 처리 가능)
--                 manual_grant(수동 부여)   → 생성 즉시 status='completed'(completed_at=now)
--   - ⚠ user_weekly_points.points 자동 합산 · 주차 성장 계산 · snapshot 생성/조회 · checkGate ·
--     demoUserId 경로 무접촉. point_a/b/c 는 현재 "표시/관리용 정의값"일 뿐 고객앱 점수 미연동.
--   - write 는 service_role(admin API) 경유만.
--
-- Idempotent. Supabase SQL Editor 에서 수동 실행.

CREATE TABLE IF NOT EXISTS public.process_irregular_acts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- org · 주차 스코프(보드 조회 주차와 일치하도록 write 도 동일 주차로 저장).
  organization_slug    text NOT NULL,
  week_id              uuid NOT NULL,

  -- 종류 — 검수 신청 / 수동 부여.
  kind                 text NOT NULL CHECK (kind IN ('review_request', 'manual_grant')),

  -- 변동 액트명(정규 기준표 외 자유 입력).
  act_name             text NOT NULL CHECK (char_length(act_name) BETWEEN 1 AND 60),

  -- 신청자 = 운영진(어드민 계정). 표시명 denorm(이력 보존). 스코프 판정 제외.
  applicant_admin_id   uuid NULL REFERENCES public.admin_users(id) ON DELETE SET NULL,
  applicant_admin_name text NOT NULL,

  -- 대상자 = 고객앱 사용자(user_profiles.user_id). 표시명 denorm. org+mode 분리 기준.
  --   FK 는 걸지 않는다(user_profiles 키 정책 보호 — 존재/소속/스코프 검증은 앱 레이어).
  target_user_id       uuid NOT NULL,
  target_user_name     text NOT NULL,

  -- 소요 시간(분) — 자유, nullable. 입력 시 1~600 범위만 강제.
  duration_minutes     integer NULL CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 1 AND 600),
  reason               text NULL,  -- 액트 신청 사유

  -- 포인트 A/B/C — "표시/관리용 정의값"(고객앱 점수 미연동). 각 0~20.
  point_a              smallint NOT NULL DEFAULT 0 CHECK (point_a BETWEEN 0 AND 20),
  point_b              smallint NOT NULL DEFAULT 0 CHECK (point_b BETWEEN 0 AND 20),
  point_c              smallint NOT NULL DEFAULT 0 CHECK (point_c BETWEEN 0 AND 20),

  -- 액트 종류 — 전원/부분 (2026-06-18 전환: 구 required/optional/selection/none → all/partial).
  --   전원(all)=전체 대상 적용 · 부분(partial)=일부 대상 적용. 적용 범위 구분(포인트 C 와 무관).
  crew_reaction        text NOT NULL DEFAULT 'all'
    CHECK (crew_reaction IN ('all', 'partial')),

  -- 검수 링크 / 검수 시점.
  review_link          text NULL,
  scheduled_check_at   timestamptz NULL,

  -- 체크 상태 — pending(검수 대기) / completed(체크 완료).
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
  completed_at         timestamptz NULL,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_process_irregular_acts_scope
  ON public.process_irregular_acts (organization_slug, week_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_process_irregular_acts_target
  ON public.process_irregular_acts (target_user_id);

-- ── updated_at touch (마스터 마이그레이션 함수 재사용, idempotent) ────────────────
CREATE OR REPLACE FUNCTION public.touch_process_master_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_process_irregular_acts_touch ON public.process_irregular_acts;
CREATE TRIGGER trg_process_irregular_acts_touch
  BEFORE UPDATE ON public.process_irregular_acts
  FOR EACH ROW EXECUTE FUNCTION public.touch_process_master_updated_at();

COMMENT ON TABLE public.process_irregular_acts IS
  '변동 액트(/admin/processes/check/irregular) — 정규 기준표(process_acts) 외 검수신청/수동부여 인스턴스. 신청자=admin_users(운영진)·대상자=user_profiles(고객). org+mode 분리는 target_user_id 기준. user_weekly_points/snapshot/checkGate/demoUserId 무접촉(2026-06-15 변동 Phase). point_a/b/c=표시/관리용 정의값.';
COMMENT ON COLUMN public.process_irregular_acts.target_user_id IS
  '대상 고객앱 사용자(user_profiles.user_id). org/mode(test_user_markers) 스코프 판정 기준. FK 미설정 — 존재/소속/스코프 검증은 앱 레이어(422).';
COMMENT ON COLUMN public.process_irregular_acts.applicant_admin_id IS
  '신청 실행 운영진(admin_users.id). 표시/이력용 — 스코프 판정 제외.';

GRANT SELECT ON public.process_irregular_acts TO anon, authenticated;

-- PostgREST 스키마 캐시 즉시 리로드(신규 테이블이 REST 로 바로 보이도록).
NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════
-- 검증 (참고용)
-- ═══════════════════════════════════════════════════════════════════════
/*
SELECT organization_slug, kind, status, count(*)
FROM public.process_irregular_acts GROUP BY 1,2,3 ORDER BY 1,2,3;
*/

-- 2026-06-07_line_registrations.sql
-- /admin/lines/register 라인 등록 레지스트리 (additive Phase).
--
-- 정책 (2026-06-07 확정):
--   - 기존 4허브 SoT(cluster4_lines · experience/competency 마스터 · career_projects)는
--     그대로 유지하며 어떤 코드 경로도 수정하지 않는다. 본 테이블은 "신규 등록 라인"만
--     저장하는 통합 SoT **후보**이다 — 기존 SoT 전환/이관은 별도 Phase.
--   - 기존 개설 기능 · 고객 화면 · snapshot 생성/조회 · demoUserId/일반 사용자 경로는
--     본 테이블을 참조하지 않는다 (참조 0건 — 2026-06-07 전수 grep 확인).
--   - 조회: GET /api/admin/lines/registrations (라인 정보 화면 연동은 추후).
--
-- 컬럼 계약:
--   - hub: 소속 허브. cluster4_lines.part_type 과 동일 enum (info|experience|competency|career).
--   - line_type: 허브별 라인 종류 한글 라벨.
--       info/career → '일반' · experience → 도출/분석/평가/관리/확장 · competency → 원리/기술/관점/자원
--       (허브×종류 조합 검증은 API 레이어 — adminLineRegistrationsTypes.ts)
--   - main_title_mode: 'fixed'(고정) | 'variable'(변동). 변동이면 main_title='-' 저장.
--   - output_links: [{url, label}] — 링크:설명 1:1 (cluster4_lines.output_links 와 동일 구조).
--   - output_images: [{url, caption}] — 이미지:캡션 1:1 (cluster4_lines.output_images 신형과 동일 구조).
--   - partner_company ~ manager_profile_key: 실무 경력(career) 전용 — 비career 허브는 전부 NULL
--     (API 레이어에서 강제). manager_profile_key 는 placeholder 프로필 토큰(잔다르크 등, 이미지 미보유).
--
-- Idempotent. Supabase SQL Editor 에서 수동 실행.

CREATE TABLE IF NOT EXISTS public.line_registrations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  line_name        text NOT NULL,
  hub              text NOT NULL
    CHECK (hub IN ('info', 'experience', 'competency', 'career')),
  line_type        text NOT NULL
    CHECK (line_type IN ('일반', '도출', '분석', '평가', '관리', '확장', '원리', '기술', '관점', '자원')),
  line_code        text NOT NULL,

  main_title_mode  text NOT NULL
    CHECK (main_title_mode IN ('fixed', 'variable')),
  main_title       text NOT NULL,  -- 변동(variable)이면 '-'

  output_links     jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{url, label}]
  output_images    jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{url, caption}]

  -- 실무 경력(career) 전용 — 비career 는 전부 NULL
  partner_company      text NULL,  -- 제휴/연계사
  company_logo_url     text NULL,  -- 기업 로고 (upload-image 반환 URL)
  manager_name         text NULL,  -- 담당자명
  manager_position     text NULL,  -- 직급
  manager_job          text NULL,  -- 직무
  manager_profile_key  text NULL   -- 프로필 사진 placeholder 토큰
    CHECK (manager_profile_key IS NULL OR manager_profile_key IN
      ('잔다르크', '툼 레이더', '미즈 마블', '토르', '아이언맨', '캡틴 아메리카')),

  is_active        boolean NOT NULL DEFAULT true,
  created_by       uuid NULL REFERENCES public.admin_users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_line_registrations_hub
  ON public.line_registrations (hub);
CREATE INDEX IF NOT EXISTS idx_line_registrations_created_at
  ON public.line_registrations (created_at DESC);

-- updated_at touch trigger (프로젝트 표준 패턴, idempotent)
CREATE OR REPLACE FUNCTION public.touch_line_registrations_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_line_registrations_touch ON public.line_registrations;
CREATE TRIGGER trg_line_registrations_touch
  BEFORE UPDATE ON public.line_registrations
  FOR EACH ROW EXECUTE FUNCTION public.touch_line_registrations_updated_at();

COMMENT ON TABLE public.line_registrations IS
  '/admin/lines/register 라인 등록 레지스트리(additive). 기존 4허브 SoT(cluster4_lines·마스터·career_projects)와 분리 — 전환/이관은 별도 Phase. write 는 service_role(admin API) 경유만.';
COMMENT ON COLUMN public.line_registrations.main_title IS
  'main_title_mode=variable(변동)이면 ''-'' 저장 — 개설 때마다 입력하는 1차 정보가 됨.';
COMMENT ON COLUMN public.line_registrations.line_type IS
  '허브별 라인 종류 한글 라벨. 허브×종류 조합 검증은 API 레이어(adminLineRegistrationsTypes.ts).';

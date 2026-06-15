-- 2026-06-12_process_acts.sql
-- 통합 > 허브별 프로세스 > 프로세스 등록 (/admin/processes/register).
--
-- 정책 (2026-06-12 확정 — 마스터 카탈로그 Phase):
--   - 본 Phase 는 액트/라인급 "마스터 카탈로그" CRUD 만 추가한다(additive).
--   - 사용자별 액트 수행 기록 · user_weekly_points.points 자동 합산 · 주차 성장 계산 ·
--     snapshot 생성/조회 · 기존 checkGate 판정 로직은 일절 건드리지 않는다.
--     (point.check 를 "정의"하는 마스터이며, 실제 계산 반영은 별도 Phase 의 수행기록/집계 파이프라인 필요.)
--   - 조직(organization) 구분 없음 — 허브×라인급×액트 전역 1세트.
--   - write 는 service_role(admin API) 경유만.
--
-- 3단 구조: 허브급(hub enum) → 라인급(process_line_groups) → 액트(process_acts)
--   허브급은 탭 자체가 값 → 별도 테이블 없이 hub enum 컬럼으로 표현.
--   hub ∈ ('club','info','experience','competency','career')  -- 클럽 총괄/실무 정보/경험/역량/경력
--
-- Idempotent. Supabase SQL Editor 에서 수동 실행.

-- ── 라인급 마스터 ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.process_line_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hub         text NOT NULL
    CHECK (hub IN ('club', 'info', 'experience', 'competency', 'career')),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 30),
  sort_order  integer NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid NULL REFERENCES public.admin_users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- 허브당 라인급명 중복 금지(최대 12개는 앱 레이어 enforce).
  UNIQUE (hub, name)
);

CREATE INDEX IF NOT EXISTS idx_process_line_groups_hub
  ON public.process_line_groups (hub, sort_order, created_at);

-- ── 액트 마스터 ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.process_acts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 소속 라인급(FK). 라인급 삭제 차단은 앱 레이어(409)에서 산하 액트 존재 검사로 수행 —
  -- RESTRICT 로 DB 레벨에서도 이중 안전망.
  line_group_id    uuid NOT NULL REFERENCES public.process_line_groups(id) ON DELETE RESTRICT,
  -- 소속 허브(denormalized) — line_group 의 hub 와 일치(앱 레이어 강제). 탭 필터/검증용.
  hub              text NOT NULL
    CHECK (hub IN ('club', 'info', 'experience', 'competency', 'career')),

  act_name         text NOT NULL CHECK (char_length(act_name) BETWEEN 1 AND 30),

  -- 소요 시간(분) — 5~90, 5분 단위.
  duration_minutes integer NOT NULL
    CHECK (duration_minutes BETWEEN 5 AND 90 AND duration_minutes % 5 = 0),

  -- 신청 시점 — 주(N|N1=N+1) · 요일(0=일 ~ 6=토) · 시간('HH:MM', 30분 단위 06:00~24:00).
  occur_week       text NOT NULL CHECK (occur_week IN ('N', 'N1')),
  occur_dow        smallint NOT NULL CHECK (occur_dow BETWEEN 0 AND 6),
  occur_time       text NOT NULL,

  -- 검수 시점 — 신청 시점과 동일 구조.
  check_week       text NOT NULL CHECK (check_week IN ('N', 'N1')),
  check_dow        smallint NOT NULL CHECK (check_dow BETWEEN 0 AND 6),
  check_time       text NOT NULL,

  -- 포인트 — A=check / B=advantage / C=penalty, 각 0~20.
  point_check      smallint NOT NULL DEFAULT 0 CHECK (point_check BETWEEN 0 AND 20),
  point_advantage  smallint NOT NULL DEFAULT 0 CHECK (point_advantage BETWEEN 0 AND 20),
  point_penalty    smallint NOT NULL DEFAULT 0 CHECK (point_penalty BETWEEN 0 AND 20),

  -- 카페(발생/미발생) · 체크 대상(체크/미체크) · 액트 종류(필수/자율/선발/기본).
  cafe             text NOT NULL CHECK (cafe IN ('occur', 'none')),
  check_target     text NOT NULL CHECK (check_target IN ('check', 'none')),
  act_type         text NOT NULL
    CHECK (act_type IN ('required', 'optional', 'selection', 'basic')),

  overview         text NULL,  -- 개요(글자수 제한 비강제)
  remarks          text NULL,  -- 비고(동일)

  is_active        boolean NOT NULL DEFAULT true,
  created_by       uuid NULL REFERENCES public.admin_users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_process_acts_line_group
  ON public.process_acts (line_group_id);
CREATE INDEX IF NOT EXISTS idx_process_acts_hub
  ON public.process_acts (hub, created_at DESC);

-- ── updated_at touch 트리거 (프로젝트 표준 패턴, idempotent) ──────────────────
CREATE OR REPLACE FUNCTION public.touch_process_master_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_process_line_groups_touch ON public.process_line_groups;
CREATE TRIGGER trg_process_line_groups_touch
  BEFORE UPDATE ON public.process_line_groups
  FOR EACH ROW EXECUTE FUNCTION public.touch_process_master_updated_at();

DROP TRIGGER IF EXISTS trg_process_acts_touch ON public.process_acts;
CREATE TRIGGER trg_process_acts_touch
  BEFORE UPDATE ON public.process_acts
  FOR EACH ROW EXECUTE FUNCTION public.touch_process_master_updated_at();

COMMENT ON TABLE public.process_line_groups IS
  '프로세스 라인급 마스터(/admin/processes/register). 허브급(hub enum) 산하 라인급. 액트 카탈로그 전용 — 주차 성장 계산/snapshot 무관(2026-06-12 마스터 Phase).';
COMMENT ON TABLE public.process_acts IS
  '프로세스 액트 마스터(/admin/processes/register). point.check(A)/advantage(B)/penalty(C)를 "정의"하는 카탈로그 — 사용자 수행기록/집계는 별도 Phase. snapshot/계산 무접촉.';
COMMENT ON COLUMN public.process_acts.point_check IS
  'point.check(A) 정의값(0~20). 현재 주차 성장 계산 입력은 user_weekly_points.points(마이그레이션 집계값)이며 본 컬럼과 미연동 — 연동은 별도 Phase.';

-- 2026-07-24_process_check_logs_scope_type.sql
-- 프로세스 체크 로그(process_check_logs)에 "범위(scope_type)" 컬럼을 denorm 으로 각인.
--
-- 배경/정책:
--   체크 로그창에서 팀명 뒤의 범위(팀 총괄 vs 실제 파트)를 "저장된 값" 으로 명확히 구분하기 위함.
--   지금까지 로그 DTO 는 part_name 유무(NULL=팀 총괄 · 값=파트)로만 범위를 유추했다. 이 유추로는
--   "PART 인데 part_name 이 누락된 데이터 오류"를 팀 총괄과 구분할 수 없다. 이를 위해 로그 행에도
--   라인급 scope_type(process_line_groups.scope_type SoT)을 "액션 발생 시점 값 그대로" 얼려 저장한다.
--     · scope_type = 'TEAM' → 팀 총괄(파트 전용 아님) 액트 체크 로그.
--     · scope_type = 'PART' → 파트 전용 액트 체크 로그(part_name 이 실제 대상 파트명).
--     · NULL              → 팀 구분 없는 허브(info/competency/club 등) — 범위 세그먼트 미표시.
--
--   ⚠ 얼려 저장(frozen denorm) — 과거 주차 로그를 이후 소속/마스터 변경으로 재계산하지 않는다(명세 §8).
--   컬럼 미적용(스키마 캐시 미갱신) 기간에는 앱이 part_name 유무로 폴백해 표시 범위를 유지한다.
--
-- 조직(organization) 무관 — 로그 테이블 전역. write 는 service_role(admin API) 경유만. Idempotent.
-- Supabase SQL Editor 에서 수동 실행.

-- ── 1) 컬럼 추가 ─────────────────────────────────────────────────────────────
--   NULL 허용 — 비팀 허브 로그는 NULL(범위 개념 없음). CHECK 로 TEAM/PART/NULL 만 허용.
ALTER TABLE public.process_check_logs
  ADD COLUMN IF NOT EXISTS scope_type text
    CHECK (scope_type IS NULL OR scope_type IN ('TEAM', 'PART'));

-- ── 2) 1회성 백필 ────────────────────────────────────────────────────────────
--   팀 구분 허브(experience) 기존 로그만 대상. part_name 이 있으면 'PART', 없으면 'TEAM'.
--   (파트 전용 액트는 항상 실제 파트명이 기록되어 있으므로 part_name 유무가 당시 범위와 일치한다.)
--   비팀 허브(hub<>'experience')·이미 채워진 행은 건드리지 않는다(멱등).
UPDATE public.process_check_logs
   SET scope_type = CASE WHEN part_name IS NOT NULL THEN 'PART' ELSE 'TEAM' END
 WHERE hub = 'experience'
   AND team_name IS NOT NULL
   AND scope_type IS NULL;

COMMENT ON COLUMN public.process_check_logs.scope_type IS
  '체크 로그 범위 SoT(denorm·frozen). TEAM=팀 총괄 · PART=파트 전용(part_name=대상 파트) · NULL=비팀 허브. 라인급 scope_type 을 액션 발생 시점 값으로 각인 — part_name 유무 유추를 대체(2026-07-24).';

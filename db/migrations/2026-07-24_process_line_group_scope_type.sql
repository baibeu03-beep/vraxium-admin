-- 2026-07-24_process_line_group_scope_type.sql
-- 프로세스 라인급(process_line_groups)에 명시적 "파트 전용" 속성(scope_type) 추가.
--
-- 배경/정책:
--   지금까지 "파트 액트" 여부는 라인급명(process_line_groups.name)에 "파트" 문자가 포함되는지로
--   런타임에서 추론했다(isPartLineGroupName). 이 추론을 제거하고, 라인급 등록 단계에서 명시적으로
--   저장하는 단일 SoT 컬럼(scope_type)으로 대체한다.
--     · scope_type = 'TEAM' → 팀 공통(팀 총괄) 라인급 — 액트가 팀 단위로 1개 존재.
--     · scope_type = 'PART' → 파트 전용 라인급 — 산하 액트가 각 파트별로 독립 체크/집계/포인트 대상.
--
--   런타임은 마이그레이션 적용 후 오직 scope_type 만 참조한다(라인급명 문자열 추론 금지).
--   컬럼 미적용(스키마 캐시 미갱신) 기간에는 앱이 기존 이름 매칭으로 폴백해 동작을 보존한다.
--
-- 조직(organization) 구분 없음 — 허브×라인급 전역 1세트(기존 마스터 정책 유지).
-- write 는 service_role(admin API) 경유만. Idempotent. Supabase SQL Editor 에서 수동 실행.

-- ── 1) 컬럼 추가 ─────────────────────────────────────────────────────────────
--   기본값 'TEAM' — 신규/기존 행 모두 우선 팀 공통으로 둔다(파트 전용은 아래 백필/등록에서만 지정).
ALTER TABLE public.process_line_groups
  ADD COLUMN IF NOT EXISTS scope_type text NOT NULL DEFAULT 'TEAM'
    CHECK (scope_type IN ('TEAM', 'PART'));

-- ── 2) 1회성 백필 ────────────────────────────────────────────────────────────
--   기존 실무 경험(experience) 라인급 중 "현재 이름에 '파트'가 포함되어 파트별로 동작하던" 항목만
--   scope_type='PART' 로 승격한다(기존 체크 상태·집계·포인트 대상 동작 보존 = 명세 §10).
--   나머지(이름에 '파트' 미포함, 또는 비-experience 허브)는 기본값 'TEAM' 을 그대로 둔다.
--   ⚠ 이 이름 매칭은 "마이그레이션 시 1회" 시드일 뿐이다 — 런타임에서는 다시 이름으로 추론하지 않는다.
--   멱등: 이미 'PART' 인 행은 그대로. (재실행해도 동일 결과.)
UPDATE public.process_line_groups
   SET scope_type = 'PART'
 WHERE hub = 'experience'
   AND name LIKE '%파트%'
   AND scope_type <> 'PART';

-- 참고: 비-experience 허브는 팀 파트 스코프 개념이 없어 scope_type 이 동작에 영향을 주지 않는다
--   (팀 구분 허브 = experience 만). 그럼에도 컬럼은 전 허브에 존재하며 기본 'TEAM' 으로 안전하다.

COMMENT ON COLUMN public.process_line_groups.scope_type IS
  '라인급 범위 SoT. TEAM=팀 공통(팀 총괄) · PART=파트 전용(산하 액트가 각 파트별 독립 체크/집계/포인트 대상). 라인급명 문자열 추론(구 isPartLineGroupName)을 대체하는 명시적 저장 속성 — 런타임은 이 값만 사용(2026-07-24).';

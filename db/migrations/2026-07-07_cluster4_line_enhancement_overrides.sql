-- 2026-07-07_cluster4_line_enhancement_overrides.sql
-- 크루별 라인 강화 상태(enhancementStatus) 수동 override — read-time overlay SoT.
--
-- 배경: enhancementStatus 는 computeCluster4Enhancement 로 계산되어 카드 DTO 에 append 되고
--   cluster4_weekly_card_snapshots 에 baked 되는 파생값이다. 운영진이 특정 사용자의 특정 라인
--   강화 상태를 수동으로 강제해야 하는 예외(소급 인정/데이터 지연 등)가 있어, 계산·snapshot 을
--   건드리지 않고 "조회 시점(read-time)"에만 덧씌우는 격리 override 테이블을 신설한다.
--   (선례: weekly_league_success_overrides, official_rest_weeks.is_official_rest_override —
--    SoT 무수정 + 읽기 시점 보정 + provenance.)
--
-- 원칙:
--   - snapshot writer 에는 절대 반영하지 않는다(굽지 않음). lib/cluster4EnhancementOverride.ts 가
--     loadWeeklyCards 반환 직전에만 적용한다 — override 행이 없으면 응답은 기존과 100% 동일.
--   - computeCluster4Enhancement 는 무수정. override 는 계산 결과 "위에서만" 적용.
--   - 키는 (user_id, week_id, 라인 식별). 라인 식별 우선순위: line_target_id > line_id > line_code > line_ordinal.
--     · 본인 배정 라인 = line_target_id 존재(최정밀).
--     · 개설·미배정 synthetic 라인 = line_target_id 없음 → line_id 로 식별.
--     · placeholder 라인(배정/개설 전 스켈레톤 슬롯 — 식별키 전무, 예: 신규 참여 주차의 실무 슬롯) =
--       line_ordinal(카드 lines 배열 내 인덱스)로 식별. 카드 라인 구성은 결정론적이라 재계산해도
--       동일 순서 → 안정 키. (실제 라인이 생기면 그 라인은 identity 로 매칭되고 placeholder 키는 자연 소멸.)
--   - override_status 는 카드 DTO 의 enhancementStatus 어휘와 동일(success/fail/pending/not_applicable).
--   - 해제(자동 복귀)는 행 삭제로 처리한다(행 부재 = 자동 계산값).

CREATE TABLE IF NOT EXISTS public.cluster4_line_enhancement_overrides (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL,                 -- 카드 주인(그 사람 카드에 뜨는 라인) = user_profiles.user_id
  week_id         uuid NOT NULL,                 -- 카드 주차 = weeks.id (= card.weekId)
  part_type       text NOT NULL
                  CHECK (part_type IN ('information','experience','competency','career')),
  line_target_id  uuid,                          -- 1차 식별키(본인 배정 라인). synthetic 라인은 NULL.
  line_id         uuid,                          -- 폴백 식별키(개설·미배정 라인 등).
  line_code       text,                          -- 폴백 식별키.
  line_ordinal    integer,                       -- 최후 폴백: 카드 lines 배열 인덱스(placeholder 라인용).
  override_status text NOT NULL
                  CHECK (override_status IN ('success','fail','pending','not_applicable')),
  source          text NOT NULL DEFAULT 'admin_manual', -- provenance(누가/어디서 지정했는지)
  note            text,                          -- 변경 사유 메모(감사용)
  created_by      uuid,                          -- 지정한 관리자 user_id
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- 라인 식별키(또는 ordinal)가 최소 하나는 있어야 매칭 가능.
  CONSTRAINT cluster4_line_enh_override_identity_present
    CHECK (
      line_target_id IS NOT NULL OR line_id IS NOT NULL
      OR line_code IS NOT NULL OR line_ordinal IS NOT NULL
    )
);

-- ── 기존(1차 버전) 테이블 업그레이드 — 재실행 안전(idempotent) ──
--   line_ordinal 없이 먼저 적용된 DB 에도 이 마이그레이션을 다시 실행하면 컬럼/CHECK/유니크 인덱스를
--   최신 정의로 맞춘다. (CREATE TABLE IF NOT EXISTS 는 기존 테이블을 건드리지 않으므로 아래가 필요.)
ALTER TABLE public.cluster4_line_enhancement_overrides
  ADD COLUMN IF NOT EXISTS line_ordinal integer;

ALTER TABLE public.cluster4_line_enhancement_overrides
  DROP CONSTRAINT IF EXISTS cluster4_line_enh_override_identity_present;
ALTER TABLE public.cluster4_line_enhancement_overrides
  ADD CONSTRAINT cluster4_line_enh_override_identity_present
  CHECK (
    line_target_id IS NOT NULL OR line_id IS NOT NULL
    OR line_code IS NOT NULL OR line_ordinal IS NOT NULL
  );

-- (사용자, 주차, 라인) 1행. identity 부재 placeholder 는 line_ordinal 로 유일성 보장.
-- COALESCE 로 NULL 을 안정 sentinel 로 치환해 부분 NULL 조합도 유일 인덱스가 성립하게 한다.
-- 구(ordinal 미포함) 유니크 인덱스가 있으면 최신 정의로 재생성한다.
DROP INDEX IF EXISTS cluster4_line_enh_override_uq;
CREATE UNIQUE INDEX IF NOT EXISTS cluster4_line_enh_override_uq
  ON public.cluster4_line_enhancement_overrides (
    user_id,
    week_id,
    part_type,
    COALESCE(line_target_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(line_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(line_code, ''),
    COALESCE(line_ordinal, -1)
  );

-- 읽기 경로(사용자 카드 조회)는 user_id 로 전체 override 를 한 번에 로드한다.
CREATE INDEX IF NOT EXISTS cluster4_line_enh_override_user_idx
  ON public.cluster4_line_enhancement_overrides (user_id);

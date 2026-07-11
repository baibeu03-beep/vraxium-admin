-- ============================================================================
-- DRAFT · Phase 3 · 미적용(NOT APPLIED) · 조인 설계 확정 후 채택안(안 C)
--
--   라인 강화 Point.A / Point.B 설정을 "오픈확인 config 가 쓰는 바로 그 식별자"에 키잉한다.
--   → line_registrations.line_code 조인(안 A)은 info 에서 성립 불가(마스터·브리지 없음·인덱스
--     매칭뿐)하고, bridged_master_id(안 B)는 미브리지·info 미지원으로 커버리지 불완전.
--     안 C 는 세 허브를 공통 스키마로 커버하며 금지된 조인(라벨/이름/인덱스/순서/first-row)을 쓰지 않는다.
--
--   config_key 규약(허브별 안정 식별자 — 오픈확인 config 키와 1:1):
--    - hub='info'       → config_key = activity_types.id  (예: 'wisdom','essay')  ← config.practicalInfo 키
--    - hub='experience' → config_key = 카테고리 enum  ('derive'|'analysis'|'research'|'management'|'expansion')
--                          (팀 독립 — 같은 org+카테고리는 팀 간 point 공유. config.practicalExperience[team][type] 의 type)
--    - hub='competency' → config_key = cluster4_competency_line_masters.line_code  (예: 'CPBS-NN0002')
--   career/club 은 이 흐름에서 라인 개설 대상이 아니므로 제외.
--
--   설정값일 뿐 ledger 아님 — 이 테이블 write 만으로 사용자 누적 포인트는 변하지 않는다.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.cluster4_line_point_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_slug text NOT NULL CHECK (organization_slug IN ('encre','oranke','phalanx','common')),
  hub text NOT NULL CHECK (hub IN ('info','experience','competency')),
  config_key text NOT NULL,                       -- 허브별 안정 식별자(위 규약)
  point_a smallint CHECK (point_a IS NULL OR (point_a BETWEEN 0 AND 20)),
  point_b smallint CHECK (point_b IS NULL OR (point_b BETWEEN 0 AND 20)),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_line_point_config UNIQUE (organization_slug, hub, config_key)
);

COMMENT ON TABLE public.cluster4_line_point_configs IS
  '라인 강화 Point.A/B 설정(설정값 SoT). 오픈확인 config 식별자에 키잉. ledger 아님.';
COMMENT ON COLUMN public.cluster4_line_point_configs.config_key IS
  'info=activity_types.id · experience=카테고리enum(derive/analysis/research/management/expansion) · competency=master line_code';

ALTER TABLE public.cluster4_line_point_configs ENABLE ROW LEVEL SECURITY;  -- service-role only(기존 cluster4 idiom)

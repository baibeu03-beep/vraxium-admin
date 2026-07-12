-- ============================================================================
-- info 라인 → 라인 강화 Point.A/B config 안정 연결 키.  [Phase 3 · 후속]
--
--   문제: cluster4_line_point_configs(info) 는 config_key = activity_types.id 로 키잉되는데,
--         line_registrations 의 info 행에는 그 activity_type 을 가리키는 안정적 연결 키가 없었다
--         (이름/코드/인덱스 매칭은 금지 — 2026-07-11_DRAFT_line_registrations_point_ab.sql 참조).
--   해결: info 행에 한해 point_activity_type_id(=activity_types.id, cluster_id='practical_info')를 저장한다.
--         · 라인 등록 폼이 이미 수집하던 값(point_activity_type_id)을 그대로 컬럼에 영속화.
--         · 오픈확인 A/B/N 계산(weekRecognitionResolve)이 쓰는 바로 그 config_key 와 동일 →
--           목록 표시값과 오픈확인 계산값이 동일 SoT(cluster4_line_point_configs)를 본다.
--   범위: info 전용. experience/competency 는 line_type/line_code 로 config_key 도출하므로 NULL.
--         career 무관. NULL 허용(미연결 행은 목록에서 Point.A/B = '-').
--
--   설정값 링크일 뿐 ledger/개설/snapshot 무접촉. 기존 행/컬럼 무수정(additive).
-- ============================================================================

ALTER TABLE public.line_registrations
  ADD COLUMN IF NOT EXISTS point_activity_type_id text;

COMMENT ON COLUMN public.line_registrations.point_activity_type_id IS
  'info 허브 전용 — 라인 강화 Point.A/B config_key(=activity_types.id, cluster_id=practical_info). experience/competency=NULL(line_type/line_code 로 도출), career=무관.';

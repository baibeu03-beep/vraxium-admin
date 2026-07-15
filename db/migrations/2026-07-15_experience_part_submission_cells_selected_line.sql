-- 2026-07-15_experience_part_submission_cells_selected_line.sql
-- 실무 경험 파트장 입력/검수 셀에 "선택 라인" 저장 컬럼 추가.
--
-- 배경:
--   /admin/line-opening/practical-experience [개설 신청](파트장 입력) 및 [검수](팀 총괄)
--   그리드의 도출/분석/견문 셀마다 라인명 드롭다운을 추가한다. 선택한 라인의 안정적 ID
--   (line_registrations.bridged_master_id = cluster4_experience_line_masters.id) 를 셀에 저장하고,
--   조회 시 이름을 조립한다. 라인명 문자열 자체는 저장하지 않는다(단일 SoT=등록 원장).
--
--   selected_line_id 는 (submission, crew, line_type) 셀 하나에 대한 단일 SoT 로,
--   개설 신청 화면과 검수 화면이 같은 셀을 읽고/쓴다(값 이원화 금지).
--
-- 불변식(앱 레이어 정규화 + 이 컬럼 nullable 로 표현):
--   · score = 0 또는 checked = false  → selected_line_id = NULL (라인 미선택 = 보이드 '-')
--   · selected_line_id 가 가리키는 라인의 유형(experienceCategory)은 반드시 그 셀의 line_type 과 일치
--     (도출↔derivation · 분석↔analysis · 견문↔evaluation) — 서버 저장 시 검증.
--
-- FK 는 두지 않는다: 라인 ID 는 등록 원장(bridge)에서 파생된 master id 이며, 공통(org NULL)
--   라인·비활성 라인 등 조합이 있어 강한 FK 는 부적합하다(기존 cluster4_lines 의 free-uuid 라인
--   참조 패턴과 동일). 유형 정합성은 앱 레이어에서 강제한다.
--
-- Idempotent — 재실행 안전. ⚠ 수동 적용 필요(미적용 시 관련 API 가 "column does not exist" 로 500).

ALTER TABLE public.cluster4_experience_part_submission_cells
  ADD COLUMN IF NOT EXISTS selected_line_id uuid NULL;

COMMENT ON COLUMN public.cluster4_experience_part_submission_cells.selected_line_id
  IS '선택 라인 ID(line_registrations.bridged_master_id). 미선택/강화실패(score 0·미체크)=NULL. 라인 유형은 셀 line_type 과 일치해야 함(앱 검증). 개설신청/검수 공용 SoT.';

-- ═══════════════════════════════════════════════════════════════════════
-- 검증 (DML 아님 — 참고용)
-- ═══════════════════════════════════════════════════════════════════════
/*
SELECT line_type, count(*) AS cells, count(selected_line_id) AS with_line
FROM public.cluster4_experience_part_submission_cells
GROUP BY line_type
ORDER BY line_type;
*/

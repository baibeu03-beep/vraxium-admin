-- 2026-07-15_experience_team_overall_cells_selected_line.sql
-- 실무 경험 팀 총괄(검수/완료) 팀장 입력 셀(관리·확장)에 "선택 라인" 저장 컬럼 추가.
--
-- 배경:
--   [개설 검수/완료] 테이블의 전체 라인 유형에 라인명 드롭다운을 붙인다. 도출/분석/견문은
--   파트 신청 셀(cluster4_experience_part_submission_cells.selected_line_id)에 저장하지만,
--   관리(management)·확장(extension)은 팀장 직접 입력 SoT 인 이 테이블에 별도 저장한다.
--   → 각 카테고리의 기존 저장 SoT 를 유지하고 라인명만 공통 구조로 연결(값 이원화 없음).
--
-- 값 = line_registrations.bridged_master_id(= cluster4_experience_line_masters.id). FK 없음.
-- 불변식(앱 정규화): score 0 또는 미체크 → NULL. 라인 유형은 셀 category(관리/확장)와 일치(서버 검증).
--
-- Idempotent — 재실행 안전. ⚠ 수동 적용 필요.

ALTER TABLE public.cluster4_experience_team_overall_cells
  ADD COLUMN IF NOT EXISTS selected_line_id uuid NULL;

COMMENT ON COLUMN public.cluster4_experience_team_overall_cells.selected_line_id
  IS '선택 라인 ID(line_registrations.bridged_master_id). 미선택/강화실패(score 0·미체크)=NULL. 라인 유형은 셀 category(관리/확장)와 일치해야 함(앱 검증).';

-- ═══════════════════════════════════════════════════════════════════════
-- 검증 (DML 아님 — 참고용)
-- ═══════════════════════════════════════════════════════════════════════
/*
SELECT category, count(*) AS cells, count(selected_line_id) AS with_line
FROM public.cluster4_experience_team_overall_cells
GROUP BY category
ORDER BY category;
*/

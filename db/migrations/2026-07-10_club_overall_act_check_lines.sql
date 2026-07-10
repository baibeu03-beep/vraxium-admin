-- 2026-07-10_club_overall_act_check_lines.sql
-- 클럽 정보 > 주차 내역 > 활동 관리 > [액트 체크 관리] 탭에 "허브 급 0 : [클럽 총괄]" 추가.
--
-- [클럽 총괄] 허브의 정식 라인급 2종을 process_line_groups(hub='club') 에 시드한다.
--   · 클럽 전체 가이드
--   · 행정 보안 검수
-- 액트 체크 관리 화면은 이 두 라인만 "클럽 총괄" 허브로 스코프한다(고정 UUID 기준 —
--   lib/adminTeamPartsInfoActCheckData.ts::CLUB_ACT_CHECK_LINE_GROUP_IDS). 기존 hub='club'
--   테스트 라인그룹들은 액트 체크 관리에 노출하지 않는다(정규 카탈로그 아님).
--
-- 라인 개설 관리(adminTeamPartsInfoLineOpeningData.ts)는 hub='club' 를 전혀 사용하지 않으므로
--   본 시드가 라인 개설 대상/통계에 영향을 주지 않는다(액트 체크 관리 전용).
--
-- 고정 UUID — 이름 변경에도 스코프가 깨지지 않도록 결정적 id 사용.
-- Idempotent. Supabase SQL Editor 에서 수동 실행(또는 scripts/seed-club-overall-act-check-lines.ts).

INSERT INTO public.process_line_groups (id, hub, name, sort_order, is_active)
VALUES
  ('0c1b0000-0000-4000-8000-000000000001', 'club', '클럽 전체 가이드', 0, true),
  ('0c1b0000-0000-4000-8000-000000000002', 'club', '행정 보안 검수', 1, true)
ON CONFLICT (id) DO UPDATE
  SET hub = EXCLUDED.hub,
      name = EXCLUDED.name,
      is_active = true;

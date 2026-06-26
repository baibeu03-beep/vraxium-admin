-- 2026-06-26_cluster4_team_halves_leader_name.sql
-- 반기별 팀(cluster4_team_halves)에 팀장 "이름 SoT" 컬럼 추가.
--
-- 배경/정책(요구사항):
--   · 팀장 이름의 단일 출처(SoT)는 운영진이 전달한 명단(팀장.xlsx)이다.
--   · DB에 동일 이름 크루가 1명 존재하면 자동연결(leader_user_id)해 성별·생년월일·거주·
--     학교·전공·클래스·품계를 채운다. 무매칭이면 leader_name(이름)만 남고 나머지는 "-".
--   · 따라서 "이름"은 크루 연결 여부와 무관히 보존돼야 하므로 별도 텍스트 컬럼이 필요하다
--     (leader_user_id 만으로는 무매칭 팀장의 이름을 표현할 수 없음).
--
--   leader_name : 팀장 이름 SoT(명단 원문). NULL = 이름조차 없음 → 표시 "-"(팔랑크스 일부).
--
-- 조회 우선순위(DTO): leaderName = COALESCE(leader_name, 연결크루.display_name).
--   인물 부가정보(성별/생년월일/학교/전공/거주/클래스/품계)는 leader_user_id 연결시에만 채움.
-- 무영향: snapshot / weekly-cards / demoUserId 경로 미접촉.
-- Idempotent. Supabase SQL Editor 에서 수동 실행.

ALTER TABLE public.cluster4_team_halves
  ADD COLUMN IF NOT EXISTS leader_name text NULL;

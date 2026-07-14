-- Cluster4 반기별 팀 QA 테스트 표식(is_qa_test) 컬럼.
--
-- 배경:
--   종전 "이 팀이 테스트(QA) 팀인가"는 팀명이 하드코딩 레지스트리(lib/cluster4ExperienceTestScope
--   .TEST_TEAM_SCOPE, "(T)" 접미 9개)에 있는지로만 판정했다. 그 결과 team-parts/info 신규 등록에서
--   레지스트리에 없는 새 팀명은 "스코프 밖"으로 거부(422)되어, 신규 테스트 팀을 만들 수 없었다.
--   → 스코프 SoT 를 팀명이 아니라 "생성 시점의 effective mode"로 각인하는 영속 컬럼으로 옮긴다.
--
-- 정책:
--   · 신규 등록 = 요청 effective mode(QA=test 고정, 아니면 URL mode)로 is_qa_test 각인. 팀명 무관.
--   · 목록 GET = 저장된 is_qa_test 로 필터(이름 매칭 아님). DB 직삽입 팀도 조건 맞으면 노출.
--   · 기존 팀 수정/삭제 = 저장된 스코프가 현재 mode 와 일치해야(운영↔테스트 교차 차단).
--   · "(T)" 는 표시용 이름 규칙일 뿐 스코프 SoT 가 아니다.
--
-- 기본값 false → 이 마이그레이션 이전 전 팀은 운영 팀. 아래 backfill 로 기존 (T) 9개만 test 로 표식
--   (레지스트리와 동일 결과 → 무회귀). 코드는 컬럼 부재 시 이름 레지스트리로 폴백하므로 적용 전에도
--   안전하나, 신규 테스트 팀 생성(비-(T) 이름)은 컬럼 적용 후에만 가능하다.
--
-- 적용: 운영 DB(Supabase SQL Editor)에서 수동 실행. 멱등(IF NOT EXISTS / 조건부 UPDATE).

BEGIN;

ALTER TABLE public.cluster4_team_halves
  ADD COLUMN IF NOT EXISTS is_qa_test boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.cluster4_team_halves.is_qa_test IS
  'QA 테스트 팀 표식(생성 시 effective mode 각인). true=테스트(QA) 스코프 — QA 모드 목록에만 노출. false=운영 팀. 스코프 SoT(팀명/(T) 규칙 아님).';

-- 기존 (T) 팀 backfill — 이름 레지스트리(TEST_TEAM_SCOPE)와 동일 집합만 test 로 표식(무회귀).
--   반기 무관(org, team_name) 매칭. 이미 true 인 행은 건너뜀(멱등).
UPDATE public.cluster4_team_halves
SET is_qa_test = true
WHERE is_qa_test = false
  AND (organization_slug, team_name) IN (
    ('oranke', '과일(T)'), ('oranke', '음료(T)'), ('oranke', '콘텐츠실험(T)'),
    ('encre', '사운드(T)'), ('encre', '비주얼랩(T)'), ('encre', '팬덤실험(T)'),
    ('phalanx', '전략(T)'), ('phalanx', '제품실험(T)'), ('phalanx', '운영(T)')
  );

-- QA 팀만 좁게 스캔(정리/QA-only 조회)용 부분 인덱스. 운영(false)은 다수라 인덱싱하지 않는다.
CREATE INDEX IF NOT EXISTS cluster4_team_halves_is_qa_test_true_idx
  ON public.cluster4_team_halves (is_qa_test)
  WHERE is_qa_test = true;

COMMIT;

-- rollback:
-- BEGIN;
-- DROP INDEX IF EXISTS public.cluster4_team_halves_is_qa_test_true_idx;
-- ALTER TABLE public.cluster4_team_halves DROP COLUMN IF EXISTS is_qa_test;
-- COMMIT;

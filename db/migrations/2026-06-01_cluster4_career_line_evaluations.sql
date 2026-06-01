-- 2026-06-01_cluster4_career_line_evaluations.sql
-- 실무 경력(career) 라인 평점 저장 테이블(P0).
--
-- 배경:
--   career 라인은 개설/대상자 배정/사용자 제출까지는 동작하나, 평점 등급(S~D)·점수 환산·
--   D등급 강화실패가 신 라인 flow 에 전혀 연결돼 있지 않았다(구 career_records 는 card 시스템
--   소속이며 (user_id, week_id, project_id) 키로 라인 target 과 미연결 — 본 테이블과 무관).
--   본 migration 은 experience 의 cluster4_experience_line_evaluations 패턴을 평행 이식하여
--   (line_target_id + user_id) 단위 평점을 신 라인 flow 의 SoT 로 도입한다.
--
-- 정책:
--   - grade ∈ {S,A,B,C,D}, grade_points ∈ {10,8,6,4,2}
--   - grade↔grade_points 짝을 DB CHECK 로 강제 (코드측 lib/careerGrade.ts 와 1:1).
--   - D(2점)는 강화 실패. 미평가(row 부재)는 fail 로 단정하지 않는다(런타임에서 pending/unevaluated).
--
-- 비범위(P0 제외):
--   - career category/slot_order, user_week_statuses fail sync 는 P1/P2 별도 단계.
--   - 기존 career line 평가값 backfill — 신규 테이블이므로 해당 없음(미평가=unevaluated 로 안전 표시).
--   - career_records 변경 — 절대 건드리지 않는다(legacy 동결).
--
-- 정합성:
--   - lib/careerGrade.ts : CAREER_GRADE_POINTS(S=10/A=8/B=6/C=4/D=2), 3점 이하 fail.
--   - lib/adminCareerEvaluationsData.ts : (line_target_id, user_id) upsert.
--   - 읽기: lib/cluster4WeeklyCardsData.ts / lib/cluster4LinesData.ts 가
--           careerGrade / careerGradePoints / careerRatingStatus DTO 로 노출.
--
-- FK 정책:
--   - line_target_id → cluster4_line_targets(id) ON DELETE CASCADE — target 제거 시 평가 정리.
--   - user_id        → user_profiles(user_id)     ON DELETE CASCADE — 사용자 탈퇴 시 정리.
--   - evaluated_by   → admin_users(id)            ON DELETE SET NULL — 운영자 평가 행위 식별.
--     (experience 평가 패턴과 동일하게 admin_users.id 를 사용한다.)
--
-- 재실행 안전: CREATE TABLE/INDEX IF NOT EXISTS, DROP TRIGGER IF EXISTS.

BEGIN;

CREATE TABLE IF NOT EXISTS public.cluster4_career_line_evaluations (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  line_target_id  uuid         NOT NULL
                  REFERENCES public.cluster4_line_targets(id) ON DELETE CASCADE,
  user_id         uuid         NOT NULL
                  REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  grade           text         NOT NULL,
  grade_points    smallint     NOT NULL,
  evaluated_by    uuid         NULL
                  REFERENCES public.admin_users(id) ON DELETE SET NULL,
  evaluated_at    timestamptz  NULL,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT cluster4_career_line_evaluations_grade_chk
    CHECK (grade IN ('S','A','B','C','D')),
  -- grade↔grade_points 짝 무결성 (S=10/A=8/B=6/C=4/D=2). 잘못된 조합 저장 차단.
  CONSTRAINT cluster4_career_line_evaluations_grade_points_pair_chk
    CHECK ((grade, grade_points) IN
      (('S',10),('A',8),('B',6),('C',4),('D',2))),
  CONSTRAINT cluster4_career_line_evaluations_target_user_unique
    UNIQUE (line_target_id, user_id)
);

CREATE INDEX IF NOT EXISTS cluster4_career_line_evaluations_user_id_idx
  ON public.cluster4_career_line_evaluations (user_id);

CREATE INDEX IF NOT EXISTS cluster4_career_line_evaluations_line_target_id_idx
  ON public.cluster4_career_line_evaluations (line_target_id);

DROP TRIGGER IF EXISTS cluster4_career_line_evaluations_set_updated_at
  ON public.cluster4_career_line_evaluations;

CREATE TRIGGER cluster4_career_line_evaluations_set_updated_at
BEFORE UPDATE ON public.cluster4_career_line_evaluations
FOR EACH ROW
EXECUTE FUNCTION public.touch_cluster4_updated_at();

-- 읽기는 experience 평가와 동일하게 anon/authenticated 에 SELECT 만 허용. write 는 service_role 전용.
GRANT SELECT ON public.cluster4_career_line_evaluations TO anon, authenticated;

COMMENT ON TABLE public.cluster4_career_line_evaluations
  IS '실무 경력(career) 라인 평점. (line_target_id+user_id) 단위. grade S~D, grade_points=10/8/6/4/2. D(2점)=강화실패. 구 career_records(card 시스템)와 무관.';
COMMENT ON COLUMN public.cluster4_career_line_evaluations.grade
  IS '평점 등급 S/A/B/C/D. points 와 짝 CHECK.';
COMMENT ON COLUMN public.cluster4_career_line_evaluations.grade_points
  IS '점수 환산 10/8/6/4/2 (S/A/B/C/D). 3점 이하(D=2)는 강화 실패.';

COMMIT;

-- ============================================================
-- ROLLBACK (필요 시)
-- ============================================================
/*
BEGIN;
DROP TABLE IF EXISTS public.cluster4_career_line_evaluations;
COMMIT;
*/

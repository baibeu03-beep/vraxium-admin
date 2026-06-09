-- 운영용 크루 번호(crew_no) 도입 — UUID 대신 운영 화면에서 식별·검색에 쓰는 사람-읽기용 번호.
--
-- 정책(2026-06-09):
--   - user_profiles.crew_no bigint UNIQUE.
--   - 기존 전체 사용자: 1001 부터 created_at ASC 순으로 순차 부여(동시각은 user_id tiebreak).
--   - 신규 사용자: BEFORE INSERT 트리거가 (현재 최대 + 1) 자동 발급(앱 코드 무관 — 모든 insert 경로 커버).
--   - 내부 저장/조회 SoT 는 그대로 user_id(UUID). crew_no 는 표시·검색 보조 키일 뿐.
--
-- ⚠ 고객 weekly-cards 스냅샷 DTO 와 무관(스냅샷 계산은 crew_no 를 참조하지 않는다 → 재계산 불필요).
-- 적용: 운영 DB(Supabase SQL Editor)에서 수동 1회 실행. 코드는 컬럼 미존재 시 crewNo=null 로
--   graceful fallback 하므로 배포 전/후 어느 시점에 적용해도 안전하다.

-- 1) 컬럼 추가 (idempotent)
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS crew_no bigint;

-- 2) 기존 사용자 백필 — 1001 부터 created_at ASC. crew_no 가 비어있는 행만 부여(재실행 안전).
WITH ordered AS (
  SELECT user_id,
         row_number() OVER (ORDER BY created_at ASC NULLS LAST, user_id ASC) AS rn
  FROM public.user_profiles
  WHERE crew_no IS NULL
)
UPDATE public.user_profiles p
SET crew_no = 1000 + o.rn
FROM ordered o
WHERE p.user_id = o.user_id;

-- 3) 유니크 인덱스
CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_crew_no_key
  ON public.user_profiles (crew_no);

-- 4) 신규 행 자동 발급 트리거 — crew_no 가 null 로 들어오면 (현재 최대 + 1).
--    저빈도(승인 시 생성)라 MAX+1 경합은 사실상 없으며, 만약 충돌하면 유니크 인덱스가 막아
--    insert 가 실패(재시도)한다. 백필 시작값 1001 과 정합되게 COALESCE 기준값은 1000.
CREATE OR REPLACE FUNCTION public.assign_crew_no()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.crew_no IS NULL THEN
    SELECT COALESCE(MAX(crew_no), 1000) + 1
      INTO NEW.crew_no
      FROM public.user_profiles;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assign_crew_no ON public.user_profiles;
CREATE TRIGGER trg_assign_crew_no
  BEFORE INSERT ON public.user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.assign_crew_no();

COMMENT ON COLUMN public.user_profiles.crew_no IS
  '운영용 크루 번호(1001+, created_at ASC 백필). 표시/검색 보조 키 — SoT 는 user_id(UUID). 스냅샷 무관.';

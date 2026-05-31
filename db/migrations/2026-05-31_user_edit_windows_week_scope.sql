-- 2026-05-31_user_edit_windows_week_scope.sql
-- 주간 활동(주간 회고/주간 동료/주간 평판) 편집 권한을 week_id 단위로 분리.
--
-- 배경:
--   기존 user_edit_windows 는 (user_id, resource_key) 단위로만 unique 했다.
--   주간 자원은 본질적으로 주차별 데이터이므로, 24h/7d 같은 "기간"만으로 권한을
--   열면 전 주차가 동시에 열려버리는 문제가 있었다.
--
-- 변경:
--   1) week_id    uuid NULL  → weeks(id) FK. 주간 자원은 항상 특정 주차를 가리킨다.
--   2) season_key text NULL  → season_definitions(season_key) FK. week_id 로부터
--      파생되는 시즌 식별자(예: '2026-spring'). 조회/감사를 쉽게 하려고 비정규화 저장.
--   3) UNIQUE (user_id, resource_key) 제거 → 다음 두 부분 unique index 로 대체:
--        - week_id IS NOT NULL : (user_id, resource_key, week_id) 유일
--        - week_id IS NULL     : (user_id, resource_key) 유일 (비주간/legacy 전역 권한)
--      → 한 사용자 X 한 자원에 대해 "주차별 1행 + 전역 1행" 까지 허용.
--
-- 호환성:
--   - 기존 row 는 week_id/season_key = NULL 로 남는다 (전역 권한).
--   - 비주간 자원(review_links, output_cards, work_* 등) 은 계속 week_id = NULL 로
--     동작하므로 기존 흐름이 깨지지 않는다.
--   - 주간 자원의 legacy NULL-week row 는 애플리케이션 레이어에서 "주간 게이팅에
--     무효" 로 취급된다 (정책: 주차 필수). 데이터는 보존되며 admin 이 정리 가능.
--
-- Idempotent — 재실행 안전.


-- ═══════════════════════════════════════════════════════════════════════
-- PART 1: 컬럼 추가
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.user_edit_windows
  ADD COLUMN IF NOT EXISTS week_id uuid NULL
    REFERENCES public.weeks(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS season_key text NULL
    REFERENCES public.season_definitions(season_key) ON DELETE SET NULL;

COMMENT ON COLUMN public.user_edit_windows.week_id
  IS '주간 자원 권한이 가리키는 주차(weeks.id). 비주간/전역 권한이면 NULL.';
COMMENT ON COLUMN public.user_edit_windows.season_key
  IS 'week_id 로부터 파생된 시즌 식별자. 조회/감사 편의를 위한 비정규화 컬럼.';


-- ═══════════════════════════════════════════════════════════════════════
-- PART 2: 기존 (user_id, resource_key) UNIQUE 제거
-- 인라인 선언이라 기본 제약명은 user_edit_windows_user_id_resource_key_key.
-- 환경에 따라 이름이 다를 수 있어 DO 블록으로 generic 하게 찾아 제거한다.
-- ═══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_conname text;
BEGIN
  SELECT con.conname
    INTO v_conname
  FROM pg_constraint con
  WHERE con.conrelid = 'public.user_edit_windows'::regclass
    AND con.contype = 'u'
    AND (
      SELECT array_agg(att.attname ORDER BY att.attname)
      FROM unnest(con.conkey) AS k(attnum)
      JOIN pg_attribute att
        ON att.attrelid = con.conrelid AND att.attnum = k.attnum
    ) = ARRAY['resource_key', 'user_id']
  LIMIT 1;

  IF v_conname IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE public.user_edit_windows DROP CONSTRAINT %I',
      v_conname
    );
  END IF;
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 3: 부분 unique index 2종
-- ═══════════════════════════════════════════════════════════════════════

-- 3-1. 주차별 권한: (user_id, resource_key, week_id) 유일.
CREATE UNIQUE INDEX IF NOT EXISTS user_edit_windows_user_resource_week_uniq
  ON public.user_edit_windows (user_id, resource_key, week_id)
  WHERE week_id IS NOT NULL;

-- 3-2. 전역/legacy 권한: week_id 가 NULL 인 행은 (user_id, resource_key) 유일.
--      Postgres 의 기본 NULL-distinct 동작 때문에 전역 행이 중복 생성되는 것을 막는다.
CREATE UNIQUE INDEX IF NOT EXISTS user_edit_windows_user_resource_global_uniq
  ON public.user_edit_windows (user_id, resource_key)
  WHERE week_id IS NULL;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 4: 조회용 인덱스
-- ═══════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS user_edit_windows_week_id_idx
  ON public.user_edit_windows (week_id);

-- "이 사용자가 이 주차의 이 자원을 수정할 수 있는가?" 판정 경로 최적화.
CREATE INDEX IF NOT EXISTS user_edit_windows_user_resource_week_active_idx
  ON public.user_edit_windows (user_id, resource_key, week_id, opened_at, expires_at);


-- ═══════════════════════════════════════════════════════════════════════
-- PART 5: season_key 백필 (week_id 가 있는 기존 행 — 일반적으로 없음)
-- ═══════════════════════════════════════════════════════════════════════

UPDATE public.user_edit_windows uew
SET season_key = w.season_key
FROM public.weeks w
WHERE uew.week_id = w.id
  AND uew.week_id IS NOT NULL
  AND uew.season_key IS DISTINCT FROM w.season_key;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 6: 검증 (DML 아님)
-- ═══════════════════════════════════════════════════════════════════════

/*
-- 6-1. 컬럼/인덱스 확인
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'user_edit_windows'
ORDER BY ordinal_position;

SELECT indexname FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'user_edit_windows';

-- 6-2. 주간 자원의 주차별 권한 분포
SELECT resource_key, week_id, count(*)
FROM public.user_edit_windows
WHERE resource_key LIKE 'cluster4.weekly_%'
GROUP BY resource_key, week_id
ORDER BY resource_key, week_id;
*/

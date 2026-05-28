-- 2026-05-28_cumulative_points_auto_sync.sql
-- user_weekly_points → user_cumulative_points 자동 동기화.
--   1) 백업 테이블 생성
--   2) 보조 함수: sync_cumulative_points_for_user(uuid)
--   3) 트리거 함수 + 트리거 등록
--   4) backfill (weekly 합계로 cumulative 덮어쓰기)
--
-- SSOT: user_weekly_points (주차별 원천)
-- 캐시: user_cumulative_points (누적 표시용)
--
-- 소비자 영향: 없음 (컬럼/타입 불변)
--   - cluster3GrowthData.ts:290 (Growth Indicators)
--   - adminResumeCardData.ts:239 (Resume Card)
--
-- 부호 정책:
--   user_weekly_points.penalty — DDL 주석상 양수 저장, CHECK 미설정
--   기존 소비자 전부 ABS() 방어적 읽기 (SQL 11건, TS Math.abs)
--   → 트리거도 ABS() 사용하여 정합성 보장
--
-- 의존성: 2026-05-25_club_rank_weekly_points.sql 적용 후.
-- Idempotent — 재실행 안전.


-- ═══════════════════════════════════════════════════════════════════════
-- PART 0: 적용 전 검증 (주석 해제 후 수동 실행)
-- ═══════════════════════════════════════════════════════════════════════

-- weekly 합계 vs cumulative 현재값 비교.
-- 불일치 행이 있으면 backfill 대상.
/*
SELECT
  up.display_name,
  up.organization_slug,
  COALESCE(w.sum_points, 0)      AS weekly_stars,
  COALESCE(w.sum_advantages, 0)  AS weekly_raw_adv,
  COALESCE(w.sum_penalty, 0)     AS weekly_lightnings,
  COALESCE(c.total_stars, 0)           AS stored_stars,
  COALESCE(c.total_raw_advantages, 0)  AS stored_raw_adv,
  COALESCE(c.total_lightnings, 0)      AS stored_lightnings,
  COALESCE(c.total_shields, 0)         AS stored_shields,
  CASE WHEN COALESCE(w.sum_points, 0) != COALESCE(c.total_stars, 0)
         OR COALESCE(w.sum_advantages, 0) != COALESCE(c.total_raw_advantages, 0)
         OR COALESCE(w.sum_penalty, 0) != COALESCE(c.total_lightnings, 0)
       THEN 'MISMATCH'
       ELSE 'OK'
  END AS sync_status
FROM public.user_profiles up
LEFT JOIN (
  SELECT user_id,
         SUM(points)     AS sum_points,
         SUM(advantages) AS sum_advantages,
         SUM(penalty)    AS sum_penalty
  FROM public.user_weekly_points
  GROUP BY user_id
) w ON w.user_id = up.user_id
LEFT JOIN public.user_cumulative_points c ON c.user_id = up.user_id
WHERE up.organization_slug IS NOT NULL
ORDER BY sync_status DESC, up.organization_slug, up.display_name;
*/


-- ═══════════════════════════════════════════════════════════════════════
-- PART 1: 백업 테이블
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public._backup_cumulative_points_20260528 AS
  SELECT * FROM public.user_cumulative_points;

COMMENT ON TABLE public._backup_cumulative_points_20260528
  IS '자동 동기화 전환 전 user_cumulative_points 백업. 검증 완료 후 삭제.';


-- ═══════════════════════════════════════════════════════════════════════
-- PART 2: 보조 함수 — sync_cumulative_points_for_user(uuid)
-- ═══════════════════════════════════════════════════════════════════════
-- 단일 user_id 의 weekly 합계를 재계산하여 cumulative 에 UPSERT.
-- 트리거 함수 내부에서 호출하고, 수동 보정 시에도 직접 호출 가능.

CREATE OR REPLACE FUNCTION public.sync_cumulative_points_for_user(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_total_stars       integer;
  v_total_raw_adv     integer;
  v_total_lightnings  integer;
  v_total_shields     integer;
BEGIN
  SELECT
    COALESCE(SUM(points), 0),
    COALESCE(SUM(advantages), 0),
    COALESCE(SUM(penalty), 0)
  INTO
    v_total_stars,
    v_total_raw_adv,
    v_total_lightnings
  FROM public.user_weekly_points
  WHERE user_id = p_user_id;

  -- ABS(): 기존 소비자(SQL 11건, TS Math.abs)와 동일한 방어적 부호 처리
  v_total_shields := v_total_raw_adv - ABS(v_total_lightnings);

  INSERT INTO public.user_cumulative_points
    (user_id, total_stars, total_raw_advantages, total_lightnings, total_shields)
  VALUES
    (p_user_id, v_total_stars, v_total_raw_adv, v_total_lightnings, v_total_shields)
  ON CONFLICT (user_id) DO UPDATE
    SET total_stars           = EXCLUDED.total_stars,
        total_raw_advantages  = EXCLUDED.total_raw_advantages,
        total_lightnings      = EXCLUDED.total_lightnings,
        total_shields         = EXCLUDED.total_shields;
END;
$$;

COMMENT ON FUNCTION public.sync_cumulative_points_for_user(uuid)
  IS 'user_weekly_points SUM → user_cumulative_points UPSERT. 트리거 내부 및 수동 보정용.';


-- ═══════════════════════════════════════════════════════════════════════
-- PART 3: 트리거 함수
-- ═══════════════════════════════════════════════════════════════════════
-- user_weekly_points INSERT/UPDATE/DELETE 시 자동 호출.
-- UPDATE 에서 user_id 가 변경되면 OLD/NEW 양쪽을 재집계.

CREATE OR REPLACE FUNCTION public.sync_cumulative_points()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- DELETE: OLD 쪽 재집계
    PERFORM public.sync_cumulative_points_for_user(OLD.user_id);
    RETURN OLD;

  ELSIF TG_OP = 'UPDATE' AND OLD.user_id != NEW.user_id THEN
    -- user_id 변경: 양쪽 재집계
    PERFORM public.sync_cumulative_points_for_user(NEW.user_id);
    PERFORM public.sync_cumulative_points_for_user(OLD.user_id);
    RETURN NEW;

  ELSE
    -- INSERT 또는 동일 user_id UPDATE
    PERFORM public.sync_cumulative_points_for_user(NEW.user_id);
    RETURN NEW;
  END IF;
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 4: 트리거 등록
-- ═══════════════════════════════════════════════════════════════════════

DROP TRIGGER IF EXISTS sync_cumulative_on_weekly_change
  ON public.user_weekly_points;

CREATE TRIGGER sync_cumulative_on_weekly_change
AFTER INSERT OR UPDATE OR DELETE ON public.user_weekly_points
FOR EACH ROW
EXECUTE FUNCTION public.sync_cumulative_points();


-- ═══════════════════════════════════════════════════════════════════════
-- PART 5: Backfill — weekly 합계로 cumulative 덮어쓰기
-- ═══════════════════════════════════════════════════════════════════════
-- 트리거 등록 후 실행하므로 이후 신규 INSERT 도 자동 동기화됨.
-- backfill 은 직접 UPSERT (트리거 경유 아님 — cumulative 직접 쓰기).

-- 5a. weekly 데이터가 있는 유저 → UPSERT
INSERT INTO public.user_cumulative_points
  (user_id, total_stars, total_raw_advantages, total_lightnings, total_shields)
SELECT
  user_id,
  COALESCE(SUM(points), 0)                                AS total_stars,
  COALESCE(SUM(advantages), 0)                             AS total_raw_advantages,
  COALESCE(SUM(penalty), 0)                                AS total_lightnings,
  COALESCE(SUM(advantages), 0) - ABS(COALESCE(SUM(penalty), 0))  AS total_shields
FROM public.user_weekly_points
GROUP BY user_id
ON CONFLICT (user_id) DO UPDATE
  SET total_stars          = EXCLUDED.total_stars,
      total_raw_advantages = EXCLUDED.total_raw_advantages,
      total_lightnings     = EXCLUDED.total_lightnings,
      total_shields        = EXCLUDED.total_shields;

-- 5b. weekly 데이터가 없지만 cumulative 에 행이 있는 유저 → 0 으로 리셋
UPDATE public.user_cumulative_points ucp
SET total_stars          = 0,
    total_raw_advantages = 0,
    total_lightnings     = 0,
    total_shields        = 0
WHERE NOT EXISTS (
  SELECT 1 FROM public.user_weekly_points uwp
  WHERE uwp.user_id = ucp.user_id
);


-- ═══════════════════════════════════════════════════════════════════════
-- PART 6: 적용 후 검증 (주석 해제 후 수동 실행)
-- ═══════════════════════════════════════════════════════════════════════

-- 6-1. 전체 일치 확인 — 0건이어야 정상
/*
SELECT
  CASE WHEN COUNT(*) = 0 THEN 'ALL SYNCED'
       ELSE COUNT(*) || ' MISMATCHES FOUND'
  END AS result
FROM (
  SELECT ucp.user_id
  FROM public.user_cumulative_points ucp
  LEFT JOIN (
    SELECT user_id,
           COALESCE(SUM(points), 0) AS s,
           COALESCE(SUM(advantages), 0) AS a,
           COALESCE(SUM(penalty), 0) AS l
    FROM public.user_weekly_points
    GROUP BY user_id
  ) w ON w.user_id = ucp.user_id
  WHERE ucp.total_stars          != COALESCE(w.s, 0)
     OR ucp.total_raw_advantages != COALESCE(w.a, 0)
     OR ucp.total_lightnings     != COALESCE(w.l, 0)
     OR ucp.total_shields        != (COALESCE(w.a, 0) - ABS(COALESCE(w.l, 0)))
) mismatches;
*/

-- 6-2. 백업 대비 변경 추적
/*
SELECT
  up.display_name,
  up.organization_slug,
  b.total_stars           AS before_stars,
  b.total_raw_advantages  AS before_raw_adv,
  b.total_lightnings      AS before_lightnings,
  b.total_shields         AS before_shields,
  c.total_stars           AS after_stars,
  c.total_raw_advantages  AS after_raw_adv,
  c.total_lightnings      AS after_lightnings,
  c.total_shields         AS after_shields,
  CASE WHEN b.total_stars          IS DISTINCT FROM c.total_stars
         OR b.total_raw_advantages IS DISTINCT FROM c.total_raw_advantages
         OR b.total_lightnings     IS DISTINCT FROM c.total_lightnings
         OR b.total_shields        IS DISTINCT FROM c.total_shields
       THEN 'CHANGED'
       ELSE 'same'
  END AS change_status
FROM public.user_cumulative_points c
JOIN public._backup_cumulative_points_20260528 b ON b.user_id = c.user_id
LEFT JOIN public.user_profiles up ON up.user_id = c.user_id
ORDER BY change_status DESC, up.organization_slug, up.display_name;
*/

-- 6-3. 트리거 동작 검증 (테스트용 유저 1명)
-- '<TEST_USER_ID>' 를 실제 UUID 로 교체 후 실행.
/*
-- INSERT 테스트
INSERT INTO public.user_weekly_points
  (user_id, year, week_number, week_start_date, points, advantages, penalty)
VALUES
  ('<TEST_USER_ID>', 2099, 1, '2099-01-06', 5, 2, 1);

SELECT total_stars, total_raw_advantages, total_lightnings, total_shields
FROM public.user_cumulative_points
WHERE user_id = '<TEST_USER_ID>';

-- UPDATE 테스트
UPDATE public.user_weekly_points
SET points = 10
WHERE user_id = '<TEST_USER_ID>' AND year = 2099 AND week_number = 1;

SELECT total_stars, total_raw_advantages, total_lightnings, total_shields
FROM public.user_cumulative_points
WHERE user_id = '<TEST_USER_ID>';

-- DELETE 테스트 (원복)
DELETE FROM public.user_weekly_points
WHERE user_id = '<TEST_USER_ID>' AND year = 2099 AND week_number = 1;

SELECT total_stars, total_raw_advantages, total_lightnings, total_shields
FROM public.user_cumulative_points
WHERE user_id = '<TEST_USER_ID>';
*/

-- 6-4. integrityOk 전체 유저 확인
-- cluster3GrowthData.ts:212 의 검증식과 동일한 로직.
-- 모든 행이 OK 여야 정상.
/*
SELECT
  up.display_name,
  up.organization_slug,
  ucp.total_raw_advantages  AS k0,
  ucp.total_lightnings      AS l,
  ucp.total_shields         AS stored_shields,
  ucp.total_raw_advantages - ABS(ucp.total_lightnings) AS calc_shields,
  CASE WHEN ucp.total_shields
         = ucp.total_raw_advantages - ABS(ucp.total_lightnings)
       THEN 'OK'
       ELSE 'INTEGRITY FAIL'
  END AS integrity_check
FROM public.user_cumulative_points ucp
LEFT JOIN public.user_profiles up ON up.user_id = ucp.user_id
ORDER BY integrity_check DESC, up.organization_slug, up.display_name;
*/


-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK (주석 해제 후 수동 실행)
-- ═══════════════════════════════════════════════════════════════════════

-- 1단계: 트리거 제거 (즉시 — 재계산 중단)
/*
DROP TRIGGER IF EXISTS sync_cumulative_on_weekly_change
  ON public.user_weekly_points;
*/

-- 2단계: 백업에서 복원
/*
UPDATE public.user_cumulative_points c
SET total_stars          = b.total_stars,
    total_raw_advantages = b.total_raw_advantages,
    total_lightnings     = b.total_lightnings,
    total_shields        = b.total_shields
FROM public._backup_cumulative_points_20260528 b
WHERE c.user_id = b.user_id;

DELETE FROM public.user_cumulative_points
WHERE user_id NOT IN (
  SELECT user_id FROM public._backup_cumulative_points_20260528
);
*/

-- 3단계: 함수 제거 (선택 — 재적용 가능성 있으면 보존)
/*
DROP FUNCTION IF EXISTS public.sync_cumulative_points() CASCADE;
DROP FUNCTION IF EXISTS public.sync_cumulative_points_for_user(uuid);
*/

-- 4단계: 백업 테이블 정리 (검증 완료 & 안정 확인 후에만)
/*
DROP TABLE IF EXISTS public._backup_cumulative_points_20260528;
*/

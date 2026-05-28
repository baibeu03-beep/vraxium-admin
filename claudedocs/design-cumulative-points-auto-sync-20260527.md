# user_cumulative_points 자동 동기화 설계안

> **상태**: 설계 검토 (미적용)
> **작성일**: 2026-05-27
> **전제**: SSOT = `user_weekly_points`, `user_cumulative_points` = 캐시

---

## 1. 현황 요약

```
user_weekly_points (SSOT, 주차별)
    │
    ├─→ Club Rank             ✅ 직접 읽음
    ├─→ Cluster4 Weekly       ✅ 직접 읽음 + on-the-fly 누적
    │
    ╳   동기화 없음
    │
user_cumulative_points (레거시 캐시, 시드 동결)
    │
    ├─→ Growth Indicators     ⚠️ 동결 값 읽음 (cluster3GrowthData.ts:290)
    └─→ Resume Card           ⚠️ 동결 값 읽음 (adminResumeCardData.ts:239)
```

**문제**: weekly에 데이터가 추가/수정되면 cumulative가 갱신되지 않음.

---

## 2. 목표 상태

```
user_weekly_points (SSOT)
    │
    ├─→ Club Rank             (변경 없음)
    ├─→ Cluster4 Weekly       (변경 없음)
    │
    └──[TRIGGER]──→ user_cumulative_points (자동 캐시)
                        │
                        ├─→ Growth Indicators (변경 없음)
                        └─→ Resume Card       (변경 없음)
```

**원칙**: 기존 소비자 코드(Growth, Resume Card)는 수정하지 않음.

---

## 3. 컬럼 매핑 결정

### 3-1. 순수 합산 컬럼 (3개)

| cumulative 컬럼         | 계산식                          |
|-------------------------|---------------------------------|
| `total_stars`           | `SUM(points)`                   |
| `total_raw_advantages`  | `SUM(advantages)`               |
| `total_lightnings`      | `SUM(penalty)`                  |

### 3-2. `total_shields` 처리 기준

**선택지 비교:**

| 방안 | 설명 | 장점 | 단점 |
|------|------|------|------|
| A. 저장 (트리거에서 계산) | `total_shields = SUM(advantages) - SUM(penalty)` | 소비자 코드 변경 0 | 비정규화 추가 |
| B. 삭제 후 읽기 시 계산 | 소비자가 `k0 - l` 계산 | 정규화 | 소비자 2곳 수정 필요 |

**권장: A (저장)**

이유:
- `cluster3GrowthData.ts:189`에서 `storedShields`를 읽어 무결성 검증 (`integrityOk: storedShields === k`)
- `adminResumeCardData.ts:240`에서 `total_shields`를 직접 SELECT
- 소비자 코드 변경 없이 호환성 유지

계산식:
```
total_shields = total_raw_advantages - ABS(total_lightnings)
              = SUM(advantages) - ABS(SUM(penalty))
```

> **부호 정책**: `user_weekly_points.penalty`는 DDL 주석상 "양수 저장"이나
> DB에 CHECK 제약이 없고, 기존 소비자 코드가 **전부 ABS()로 방어적 읽기**:
> - SQL 쿼리 11건: `ABS(COALESCE(ucp.total_lightnings, 0))`
> - TS 코드: `Math.abs(pts?.total_lightnings ?? 0)` (cluster3GrowthData.ts:187)
> - 무결성 검증: `storedShields === k0 - ABS(l)` (cluster3GrowthData.ts:212)
>
> 트리거도 동일하게 ABS()를 사용하여 기존 소비자와 정합성 보장.

---

## 4. DB Trigger 설계

### 4-1. 재계산 함수

```sql
-- ═══════════════════════════════════════════════════════════════════════
-- user_weekly_points → user_cumulative_points 자동 동기화 함수
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.sync_cumulative_points()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_user_id uuid;
  v_old_user_id uuid := NULL;
  v_total_stars       integer;
  v_total_raw_adv     integer;
  v_total_lightnings  integer;
  v_total_shields     integer;
BEGIN
  -- ── 1. 대상 user_id 결정 ──────────────────────────────────
  IF TG_OP = 'DELETE' THEN
    v_user_id := OLD.user_id;
  ELSIF TG_OP = 'UPDATE' AND OLD.user_id != NEW.user_id THEN
    -- user_id 변경 시: OLD 쪽도 재집계 필요
    v_user_id := NEW.user_id;
    v_old_user_id := OLD.user_id;
  ELSE
    v_user_id := NEW.user_id;
  END IF;

  -- ── 2. 재집계 + UPSERT (내부 함수) ────────────────────────
  -- v_user_id 기준 전체 재집계
  SELECT
    COALESCE(SUM(points), 0),
    COALESCE(SUM(advantages), 0),
    COALESCE(SUM(penalty), 0)
  INTO
    v_total_stars,
    v_total_raw_adv,
    v_total_lightnings
  FROM public.user_weekly_points
  WHERE user_id = v_user_id;

  -- ABS(): 기존 소비자(SQL 11건, TS Math.abs)와 동일한 방어적 부호 처리
  v_total_shields := v_total_raw_adv - ABS(v_total_lightnings);

  INSERT INTO public.user_cumulative_points
    (user_id, total_stars, total_raw_advantages, total_lightnings, total_shields)
  VALUES
    (v_user_id, v_total_stars, v_total_raw_adv, v_total_lightnings, v_total_shields)
  ON CONFLICT (user_id) DO UPDATE
    SET total_stars           = EXCLUDED.total_stars,
        total_raw_advantages  = EXCLUDED.total_raw_advantages,
        total_lightnings      = EXCLUDED.total_lightnings,
        total_shields         = EXCLUDED.total_shields;

  -- ── 3. user_id 변경 시: OLD 쪽도 재집계 ───────────────────
  IF v_old_user_id IS NOT NULL THEN
    SELECT
      COALESCE(SUM(points), 0),
      COALESCE(SUM(advantages), 0),
      COALESCE(SUM(penalty), 0)
    INTO
      v_total_stars,
      v_total_raw_adv,
      v_total_lightnings
    FROM public.user_weekly_points
    WHERE user_id = v_old_user_id;

    v_total_shields := v_total_raw_adv - ABS(v_total_lightnings);

    INSERT INTO public.user_cumulative_points
      (user_id, total_stars, total_raw_advantages, total_lightnings, total_shields)
    VALUES
      (v_old_user_id, v_total_stars, v_total_raw_adv, v_total_lightnings, v_total_shields)
    ON CONFLICT (user_id) DO UPDATE
      SET total_stars           = EXCLUDED.total_stars,
          total_raw_advantages  = EXCLUDED.total_raw_advantages,
          total_lightnings      = EXCLUDED.total_lightnings,
          total_shields         = EXCLUDED.total_shields;
  END IF;

  -- DELETE 후 weekly가 0행이면 cumulative도 0으로 유지 (행 삭제 안 함)
  -- → 소비자가 NULL 대신 0을 읽도록 보장

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$;
```

### 4-2. 트리거 등록

```sql
-- 기존 트리거 제거 (idempotent)
DROP TRIGGER IF EXISTS sync_cumulative_on_weekly_change
  ON public.user_weekly_points;

-- INSERT / UPDATE / DELETE 모두 감지
CREATE TRIGGER sync_cumulative_on_weekly_change
AFTER INSERT OR UPDATE OR DELETE ON public.user_weekly_points
FOR EACH ROW
EXECUTE FUNCTION public.sync_cumulative_points();
```

### 4-3. 트리거 동작 범위

| 이벤트 | 대상 user_id | 동작 |
|--------|-------------|------|
| INSERT | NEW.user_id | SUM 재계산 → UPSERT |
| UPDATE (points/advantages/penalty 변경) | NEW.user_id | SUM 재계산 → UPSERT |
| UPDATE (user_id 변경) | NEW + OLD 양쪽 | NEW 재집계 + OLD 재집계 (양쪽 UPSERT) |
| DELETE | OLD.user_id | SUM 재계산 → UPSERT (0행이면 모두 0) |

> **user_id 변경 방어**: DDL에 `ON UPDATE RESTRICT`나 방지 트리거가 없으므로
> 유효한 user_id로의 UPDATE가 가능. 앱 코드에서 변경하는 경로는 0건이지만,
> 직접 SQL 실행 시 OLD 쪽 cumulative가 stale해지는 것을 방지.

---

## 5. Backfill SQL

### 5-1. 기존 데이터 백업

```sql
-- ═══════════════════════════════════════════════════════════════════════
-- STEP 0: 백업 테이블 생성 (적용 전 반드시 실행)
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public._backup_cumulative_points_20260527 AS
  SELECT * FROM public.user_cumulative_points;

COMMENT ON TABLE public._backup_cumulative_points_20260527
  IS '자동 동기화 전환 전 user_cumulative_points 백업. 검증 완료 후 삭제.';
```

### 5-2. weekly 기준으로 backfill

```sql
-- ═══════════════════════════════════════════════════════════════════════
-- STEP 1: user_weekly_points 합계로 user_cumulative_points 덮어쓰기
-- ═══════════════════════════════════════════════════════════════════════

-- 1a. weekly 데이터가 있는 유저 → UPSERT
INSERT INTO public.user_cumulative_points
  (user_id, total_stars, total_raw_advantages, total_lightnings, total_shields)
SELECT
  user_id,
  COALESCE(SUM(points), 0)       AS total_stars,
  COALESCE(SUM(advantages), 0)   AS total_raw_advantages,
  COALESCE(SUM(penalty), 0)      AS total_lightnings,
  COALESCE(SUM(advantages), 0)
    - ABS(COALESCE(SUM(penalty), 0))  AS total_shields
FROM public.user_weekly_points
GROUP BY user_id
ON CONFLICT (user_id) DO UPDATE
  SET total_stars          = EXCLUDED.total_stars,
      total_raw_advantages = EXCLUDED.total_raw_advantages,
      total_lightnings     = EXCLUDED.total_lightnings,
      total_shields        = EXCLUDED.total_shields;

-- 1b. weekly 데이터가 없지만 cumulative에 행이 있는 유저 → 0으로 리셋
UPDATE public.user_cumulative_points ucp
SET total_stars          = 0,
    total_raw_advantages = 0,
    total_lightnings     = 0,
    total_shields        = 0
WHERE NOT EXISTS (
  SELECT 1 FROM public.user_weekly_points uwp
  WHERE uwp.user_id = ucp.user_id
);
```

---

## 6. 검증 SQL

### 6-1. 적용 전: 현재 불일치 확인

```sql
-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY-1: backfill 전 — weekly 합계 vs cumulative 비교
-- ═══════════════════════════════════════════════════════════════════════

SELECT
  up.display_name,
  up.organization_slug,
  -- weekly 합계
  COALESCE(w.sum_points, 0)      AS weekly_stars,
  COALESCE(w.sum_advantages, 0)  AS weekly_raw_adv,
  COALESCE(w.sum_penalty, 0)     AS weekly_lightnings,
  -- cumulative 저장값
  COALESCE(c.total_stars, 0)           AS stored_stars,
  COALESCE(c.total_raw_advantages, 0)  AS stored_raw_adv,
  COALESCE(c.total_lightnings, 0)      AS stored_lightnings,
  COALESCE(c.total_shields, 0)         AS stored_shields,
  -- 불일치 판정
  CASE WHEN COALESCE(w.sum_points, 0) != COALESCE(c.total_stars, 0)
         OR COALESCE(w.sum_advantages, 0) != COALESCE(c.total_raw_advantages, 0)
         OR COALESCE(w.sum_penalty, 0) != COALESCE(c.total_lightnings, 0)
       THEN '❌ MISMATCH'
       ELSE '✅ OK'
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
```

### 6-2. 적용 후: backfill 결과 검증

```sql
-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY-2: backfill 후 — 모든 행이 일치해야 함
-- ═══════════════════════════════════════════════════════════════════════

SELECT
  CASE WHEN COUNT(*) = 0 THEN '✅ ALL SYNCED — 불일치 0건'
       ELSE '❌ ' || COUNT(*) || '건 불일치 발견'
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
```

### 6-3. 트리거 동작 검증

```sql
-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY-3: 트리거 적용 후 — INSERT/UPDATE/DELETE 각각 테스트
-- 테스트용 유저 1명 선택 후 실행
-- ═══════════════════════════════════════════════════════════════════════

-- 0) 테스트 대상 확인
-- SELECT user_id FROM public.user_weekly_points LIMIT 1;
-- → 아래 '<TEST_USER_ID>' 를 실제 UUID 로 교체

-- 1) INSERT 테스트: 새 주차 추가
/*
INSERT INTO public.user_weekly_points
  (user_id, year, week_number, week_start_date, points, advantages, penalty)
VALUES
  ('<TEST_USER_ID>', 2099, 1, '2099-01-06', 5, 2, 1);

-- 확인: cumulative가 즉시 반영되었는지
SELECT * FROM public.user_cumulative_points WHERE user_id = '<TEST_USER_ID>';

-- 2) UPDATE 테스트: points 변경
UPDATE public.user_weekly_points
SET points = 10
WHERE user_id = '<TEST_USER_ID>' AND year = 2099 AND week_number = 1;

SELECT * FROM public.user_cumulative_points WHERE user_id = '<TEST_USER_ID>';

-- 3) DELETE 테스트: 테스트 행 제거
DELETE FROM public.user_weekly_points
WHERE user_id = '<TEST_USER_ID>' AND year = 2099 AND week_number = 1;

SELECT * FROM public.user_cumulative_points WHERE user_id = '<TEST_USER_ID>';
*/
```

### 6-4. 백업 vs 현재 비교

```sql
-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY-4: 백업 데이터와 backfill 후 데이터 비교 (변경 추적)
-- ═══════════════════════════════════════════════════════════════════════

SELECT
  up.display_name,
  up.organization_slug,
  -- 백업 (변경 전)
  b.total_stars           AS before_stars,
  b.total_raw_advantages  AS before_raw_adv,
  b.total_lightnings      AS before_lightnings,
  b.total_shields         AS before_shields,
  -- 현재 (변경 후)
  c.total_stars           AS after_stars,
  c.total_raw_advantages  AS after_raw_adv,
  c.total_lightnings      AS after_lightnings,
  c.total_shields         AS after_shields,
  -- 변경 여부
  CASE WHEN b.total_stars          IS DISTINCT FROM c.total_stars
         OR b.total_raw_advantages IS DISTINCT FROM c.total_raw_advantages
         OR b.total_lightnings     IS DISTINCT FROM c.total_lightnings
         OR b.total_shields        IS DISTINCT FROM c.total_shields
       THEN '⚡ CHANGED'
       ELSE '— same'
  END AS change_status
FROM public.user_cumulative_points c
JOIN public._backup_cumulative_points_20260527 b ON b.user_id = c.user_id
LEFT JOIN public.user_profiles up ON up.user_id = c.user_id
ORDER BY change_status DESC, up.organization_slug, up.display_name;
```

---

## 7. 기존 화면 영향 범위

### 7-1. 영향 있는 소비자 (2곳)

| 소비자 | 파일:줄 | 읽는 컬럼 | 영향 |
|--------|---------|-----------|------|
| Growth Indicators | `cluster3GrowthData.ts:290-291` | `total_stars, total_shields, total_lightnings, total_raw_advantages` | **없음** — SELECT 컬럼/타입 불변 |
| Resume Card | `adminResumeCardData.ts:239-240` | `total_stars, total_shields, total_lightnings` | **없음** — SELECT 컬럼/타입 불변 |

### 7-2. 영향 없는 소비자 (참고)

| 소비자 | 이유 |
|--------|------|
| Club Rank (`cluster3ClubRankData.ts`) | `user_weekly_points`만 읽음 — cumulative 무관 |
| Cluster4 Weekly Growth (`cluster4WeeklyGrowthData.ts`) | `user_weekly_points`만 읽음 — cumulative 무관 |
| Career Records (`careerRecordsData.ts`) | 별도 도메인 — cumulative 무관 |

### 7-3. `_debug.integrityOk` 검증 영향

`cluster3GrowthData.ts:212`:
```typescript
integrityOk: storedShields === k
// storedShields = DB의 total_shields
// k = total_raw_advantages - ABS(total_lightnings)
```

- **backfill 전**: 시드 데이터 기준이므로 일치/불일치 혼재
- **backfill 후**: 트리거가 `total_shields = SUM(advantages) - ABS(SUM(penalty))`로 계산
- **TS 검증식**: `storedShields === k0 - Math.abs(l)` (cluster3GrowthData.ts:187-189,212)
- **결과**: 트리거와 TS가 동일한 ABS() 규칙 → 항상 `true` → `integrityOk`가 항상 통과

### 7-4. 코드 변경 필요 여부

**없음.** 트리거만으로 해결. 어플리케이션 코드 수정 0줄.

---

## 8. 실패 시 Rollback 방안

### 8-1. 트리거 비활성화 (즉시)

```sql
-- 트리거만 제거 (함수는 남겨둠 — 재활성화 용이)
DROP TRIGGER IF EXISTS sync_cumulative_on_weekly_change
  ON public.user_weekly_points;
```

### 8-2. 백업에서 복원

```sql
-- backfill 이전 값으로 복원
UPDATE public.user_cumulative_points c
SET total_stars          = b.total_stars,
    total_raw_advantages = b.total_raw_advantages,
    total_lightnings     = b.total_lightnings,
    total_shields        = b.total_shields
FROM public._backup_cumulative_points_20260527 b
WHERE c.user_id = b.user_id;

-- 백업에 없지만 backfill로 생성된 행 제거
DELETE FROM public.user_cumulative_points
WHERE user_id NOT IN (
  SELECT user_id FROM public._backup_cumulative_points_20260527
);
```

### 8-3. 백업 테이블 정리 (검증 완료 후)

```sql
-- 검증 완료 & 안정 확인 후에만 실행
-- DROP TABLE IF EXISTS public._backup_cumulative_points_20260527;
```

---

## 9. 적용 순서 체크리스트

```
□ 1. VERIFY-1 실행 — 현재 불일치 현황 기록
□ 2. STEP 0 실행 — 백업 테이블 생성
□ 3. 트리거 함수 생성 (sync_cumulative_points)
□ 4. 트리거 등록 (sync_cumulative_on_weekly_change)
□ 5. STEP 1 실행 — backfill (UPSERT + 0행 리셋)
□ 6. VERIFY-2 실행 — 전체 일치 확인 (0건 불일치)
□ 7. VERIFY-3 실행 — INSERT/UPDATE/DELETE 트리거 테스트
□ 8. VERIFY-4 실행 — 백업 대비 변경 추적
□ 9. Growth Indicators UI 확인 — 값 표시 정상
□ 10. Resume Card UI 확인 — 값 표시 정상
□ 11. _debug.integrityOk 전체 유저 통과 확인
□ 12. (안정 후) 백업 테이블 DROP
```

---

## 10. 성능 고려사항

### 트리거 비용

- `user_weekly_points` INSERT/UPDATE/DELETE마다 해당 `user_id`의 SUM 쿼리 1회
- 평균 유저당 weekly 행 수: ~30-50행 (1년 기준)
- SUM 비용: `user_weekly_points_user_id_idx` 인덱스 활용 → 매우 빠름
- bulk INSERT (시드) 시: 행 수 × 트리거 = N회 실행 → 시드는 트리거 등록 전에 실행 권장

### 대안: Statement-level 트리거

현재 설계는 ROW-level (`FOR EACH ROW`). bulk 연산이 빈번하면 Statement-level + transition table 방식 검토 가능하나, 현재 운영 패턴(주 1회 소수 행 변경)에서는 ROW-level이 적합.

---

## 11. 마이그레이션 파일 초안 (참고용)

최종 적용 시 아래 내용을 하나의 마이그레이션 파일로 생성:

```
db/migrations/2026-05-28_cumulative_points_auto_sync.sql
```

적용 순서:
1. 백업 생성
2. 트리거 함수 + 트리거 등록
3. backfill 실행
4. 검증 쿼리 (주석 처리된 SELECT)

-- 2026-05-21_activity_types_canonical.sql
-- activity_types canonical 테이블 신규 도입.
--
-- 배경:
--   `Cluster4CardContent.tsx:1105–1127` 및 `/api/profile?context=card` 의
--   weekBundle 쿼리 ([10] 슬롯) 가 `public.activity_types` 의 4-grid 카드
--   분류 master 를 기대하지만, 두 repo 어디에도 DDL 이 없고 운영 DB 점검
--   결과 테이블 자체가 부재였다 (relation does not exist).
--   본 migration 으로 canonical 테이블을 도입한다.
--
-- 정합성:
--   - GET `/api/profile?context=card&weekId=…` (route.ts:418–420)
--     SELECT id, name, line_code, cluster_id, description,
--            eligible_min_approved_weeks, eligible_max_approved_weeks,
--            count_once_in_total
--     WHERE is_active = true
--   - `lib/cached-data.ts:48–56` getCachedActivityTypes() → id, cluster_id
--   - `app/(host)/api/cluster-4-ranking/route.ts:250–251` SELECT id, line_code,
--     cluster_id, eligible_min_approved_weeks, eligible_max_approved_weeks,
--     count_once_in_total
--   - Cluster4CardContent.tsx 가 cluster_id 값을 다음 3 종에 한해 분기:
--       'practical_competency' / 'practical_experience' / 'practical_career'
--
-- 비범위:
--   - 운영 row seed (taxonomy 마스터 정의) — 별도 단계 (운영 정책 결정 후)
--   - weekly_activities.activity_type_id / activity_records.activity_type_id
--     FK 추가 — 기존 데이터와의 정합성 점검 후 별도 PR
--   - RLS 정책 — 본 migration 그룹 컨벤션에 따라 미부여

BEGIN;

-- ============================================================
-- activity_types: cluster-4 카드의 활동 마스터 (4-grid 카드 분류 + eligibility)
--   - id: text PK (코드가 'comp-1' 같은 short code 또는 uuid string 둘 다 허용하도록
--           text 로 설정). 운영 row 에서 일관 형식 사용 권장.
--   - cluster_id: 4-grid UI 컬럼 분류값. CHECK 로 3 종에 한정.
--   - eligible_min/max_approved_weeks: 강화 적격 기간 범위 (null = 무제한).
--   - count_once_in_total: 활동 타입을 시즌 누적에 1회만 카운트할지 여부.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.activity_types (
  id            text         PRIMARY KEY,

  name          text         NOT NULL,
  line_code     text         NOT NULL,

  cluster_id    text         NOT NULL,
  description   text         NULL,

  eligible_min_approved_weeks integer NULL,
  eligible_max_approved_weeks integer NULL,
  count_once_in_total         boolean NOT NULL DEFAULT false,

  is_active     boolean      NOT NULL DEFAULT true,

  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT activity_types_cluster_id_valid CHECK (
    cluster_id IN (
      'practical_competency',
      'practical_experience',
      'practical_career'
    )
  ),
  CONSTRAINT activity_types_eligible_range CHECK (
    eligible_min_approved_weeks IS NULL
    OR eligible_max_approved_weeks IS NULL
    OR eligible_min_approved_weeks <= eligible_max_approved_weeks
  )
);

CREATE INDEX IF NOT EXISTS activity_types_cluster_active_idx
  ON public.activity_types (cluster_id, is_active);

CREATE INDEX IF NOT EXISTS activity_types_is_active_idx
  ON public.activity_types (is_active);

-- ============================================================
-- updated_at touch trigger (다른 migration 컨벤션과 동일)
-- ============================================================
CREATE OR REPLACE FUNCTION public.touch_activity_types_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS activity_types_set_updated_at
  ON public.activity_types;

CREATE TRIGGER activity_types_set_updated_at
BEFORE UPDATE ON public.activity_types
FOR EACH ROW
EXECUTE FUNCTION public.touch_activity_types_updated_at();

COMMIT;

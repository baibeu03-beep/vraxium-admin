-- fix_test_user_part_names.sql
-- 더미 테스터 part_name 교정 (encre ↔ oranke 뒤바뀜 보정)
--
-- 배경:
--   seed-90users-memberships-20260527.sql / membership-plan-preview.ts 가
--   encre ↔ oranke 의 team+part 를 통째로 뒤바꿔 배정했다(조직 라벨 오류).
--   이후 fix-test-user-operating-teams.ts 가 user_memberships.team_name 만
--   조직별 정규 팀으로 교정(round-robin)했고, part_name 은 그대로 남아
--   part 가 자기 팀에 맞지 않는 상태가 되었다.
--   (예: encre/갤러리 유저가 '플랫폼'(엔터테인먼트=oranke part) 보유)
--
-- 정책:
--   - organization_slug (user_profiles)  : 절대 변경하지 않음.
--   - team_name (user_memberships)        : 절대 변경하지 않음 (이미 정규 교정됨).
--   - part_name (user_memberships)        : 각 유저의 "현재 팀" 에 맞는 canonical
--                                           part 로만 재배정.
--   - phalanx                             : 전 팀 part='일반' → 변경 없음.
--
-- canonical (organization_slug, team_name) → part 후보 (실제 라인 대상자 필터 기준):
--   encre  : 갤러리(컬쳐/매거진/코믹스) · 비주얼(일반) · 팬마케팅(FanFlow/FanLog)
--            · 프로듀싱(이야기/소리/결) · A&R(일반)
--   oranke : 스타일(패션/뷰티) · F&B(릴스/카드뉴스/쇼츠) · 콘텐츠(코믹스)
--            · 엔터테인먼트(플랫폼/팬마케팅/컬쳐) · 커머스(솔루션/베네핏) · 신입(일반)
--
-- 팀 내 분배: 팀 단위로 legacy_user_id 순서 정렬 후, 가중 배열을 순환 인덱싱하여
--   결정적(deterministic)으로 part 를 배정한다. cardinality 모듈로로 인원수 변화에도 안전.
--
-- 재실행 안전: part_name 이 이미 목표값이면 IS DISTINCT FROM 으로 skip → idempotent.
--   대상은 test_user_markers 등재 유저(데모 대상)로 한정 → 실 운영 유저 미영향.

BEGIN;

WITH ranked AS (
  SELECT
    um.id            AS membership_id,
    up.organization_slug AS org,
    um.team_name     AS team,
    ROW_NUMBER() OVER (
      PARTITION BY up.organization_slug, um.team_name
      ORDER BY u.legacy_user_id NULLS LAST, um.id
    ) AS rn
  FROM public.user_memberships um
  JOIN public.test_user_markers tm ON tm.user_id = um.user_id
  JOIN public.user_profiles     up ON up.user_id = um.user_id
  JOIN public.users             u  ON u.id       = um.user_id
  WHERE COALESCE(um.is_current, true) = true
    AND up.organization_slug IN ('encre', 'oranke')  -- phalanx 제외 (이미 정상)
),
plan AS (
  SELECT
    membership_id,
    rn,
    CASE org || '|' || team
      -- ── encre (정규 encre 팀) ──
      WHEN 'encre|갤러리'        THEN ARRAY['컬쳐','컬쳐','컬쳐','매거진','매거진','코믹스']
      WHEN 'encre|비주얼'        THEN ARRAY['일반']
      WHEN 'encre|팬마케팅'      THEN ARRAY['FanFlow','FanFlow','FanFlow','FanFlow','FanLog','FanLog']
      WHEN 'encre|프로듀싱'      THEN ARRAY['이야기','이야기','이야기','소리','소리','결']
      WHEN 'encre|A&R'           THEN ARRAY['일반']
      -- ── oranke (정규 oranke 팀) ──
      WHEN 'oranke|스타일'       THEN ARRAY['패션','패션','패션','패션','뷰티','뷰티']
      WHEN 'oranke|F&B'          THEN ARRAY['릴스','릴스','카드뉴스','카드뉴스','쇼츠','쇼츠']
      WHEN 'oranke|콘텐츠'       THEN ARRAY['코믹스']
      WHEN 'oranke|엔터테인먼트' THEN ARRAY['플랫폼','플랫폼','팬마케팅','팬마케팅','컬쳐','컬쳐']
      WHEN 'oranke|커머스'       THEN ARRAY['솔루션','솔루션','솔루션','솔루션','베네핏','베네핏']
      WHEN 'oranke|신입'         THEN ARRAY['일반']
      ELSE NULL
    END AS parts
  FROM ranked
)
UPDATE public.user_memberships um
SET part_name  = plan.parts[ ((plan.rn - 1) % cardinality(plan.parts)) + 1 ],
    updated_at = now()
FROM plan
WHERE um.id = plan.membership_id
  AND plan.parts IS NOT NULL
  AND um.part_name IS DISTINCT FROM plan.parts[ ((plan.rn - 1) % cardinality(plan.parts)) + 1 ];

COMMIT;


-- ═══════════════════════════════════════════════════════════════════════
-- 검증: 조직별 team_name / part_name 분포 (적용 후 실행)
-- ═══════════════════════════════════════════════════════════════════════
/*
SELECT
  up.organization_slug AS org,
  um.team_name,
  um.part_name,
  COUNT(*) AS cnt
FROM public.user_memberships um
JOIN public.test_user_markers tm ON tm.user_id = um.user_id
JOIN public.user_profiles     up ON up.user_id = um.user_id
WHERE COALESCE(um.is_current, true) = true
GROUP BY up.organization_slug, um.team_name, um.part_name
ORDER BY up.organization_slug, um.team_name, um.part_name;

-- (org, team) 에 맞지 않는 part_name 잔여 검출 — 0 행이어야 한다.
SELECT up.organization_slug, um.team_name, um.part_name, COUNT(*)
FROM public.user_memberships um
JOIN public.test_user_markers tm ON tm.user_id = um.user_id
JOIN public.user_profiles     up ON up.user_id = um.user_id
WHERE COALESCE(um.is_current, true) = true
  AND NOT (
    (up.organization_slug, um.team_name, um.part_name) IN (
      VALUES
        ('encre','갤러리','컬쳐'),('encre','갤러리','매거진'),('encre','갤러리','코믹스'),
        ('encre','비주얼','일반'),
        ('encre','팬마케팅','FanFlow'),('encre','팬마케팅','FanLog'),
        ('encre','프로듀싱','이야기'),('encre','프로듀싱','소리'),('encre','프로듀싱','결'),
        ('encre','A&R','일반'),
        ('oranke','스타일','패션'),('oranke','스타일','뷰티'),
        ('oranke','F&B','릴스'),('oranke','F&B','카드뉴스'),('oranke','F&B','쇼츠'),
        ('oranke','콘텐츠','코믹스'),
        ('oranke','엔터테인먼트','플랫폼'),('oranke','엔터테인먼트','팬마케팅'),('oranke','엔터테인먼트','컬쳐'),
        ('oranke','커머스','솔루션'),('oranke','커머스','베네핏'),
        ('oranke','신입','일반'),
        ('phalanx','IT','일반'),('phalanx','서비스','일반'),('phalanx','브랜딩','일반')
    )
  )
GROUP BY up.organization_slug, um.team_name, um.part_name
ORDER BY up.organization_slug, um.team_name, um.part_name;
*/

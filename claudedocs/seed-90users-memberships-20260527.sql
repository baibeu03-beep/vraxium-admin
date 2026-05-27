/*************************************************************
 * PATCH: B그룹 90명 user_memberships INSERT
 * 대상: seed_batch_id = '2026-05-26_seed_90users_v2'
 *       (test031~test120@vraxium.test, legacy_user_id 900031–900120)
 *
 * 원인: seed-90users-v2-20260526.sql에 user_memberships INSERT 누락
 * 조치: user_memberships row 신규 INSERT (UPDATE/DELETE 없음)
 *
 * 조직별 팀/파트 배분 (현실적 편차):
 *   encre  (30명): 엔터테인먼트 9 / F&B 8 / 스타일 5 / 커머스 5 / 콘텐츠 3
 *   oranke (30명): 갤러리 9 / 프로듀싱 9 / 팬마케팅 6 / 비주얼 3 / A&R 3
 *   phalanx(30명): IT 12 / 서비스 12 / 브랜딩 6
 *
 * 카테고리 → membership 매핑:
 *   excellent / near_graduation  → membership_level '심화'
 *   나머지                       → membership_level '일반'
 *   rest                        → membership_state 'weekly_rest'
 *   나머지                       → membership_state 'active'
 *************************************************************/


-- ═══════════════════════════════════════════════════════════════════════
-- STEP 0: PRE-FLIGHT CHECKS
-- ═══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_profile_count  int;
  v_marker_count   int;
  v_existing_mem   int;
BEGIN
  -- B그룹 user_profiles 존재 확인
  SELECT COUNT(*) INTO v_profile_count
  FROM public.user_profiles up
  JOIN public.test_user_markers tm ON tm.user_id = up.user_id
  WHERE tm.seed_batch_id = '2026-05-26_seed_90users_v2';

  IF v_profile_count <> 90 THEN
    RAISE EXCEPTION 'PRE-FLIGHT FAIL: user_profiles = % (expected 90)', v_profile_count;
  END IF;

  -- test_user_markers 존재 확인
  SELECT COUNT(*) INTO v_marker_count
  FROM public.test_user_markers
  WHERE seed_batch_id = '2026-05-26_seed_90users_v2';

  IF v_marker_count <> 90 THEN
    RAISE EXCEPTION 'PRE-FLIGHT FAIL: test_user_markers = % (expected 90)', v_marker_count;
  END IF;

  -- 이미 membership이 있는 유저 수
  SELECT COUNT(*) INTO v_existing_mem
  FROM public.user_memberships um
  JOIN public.test_user_markers tm ON tm.user_id = um.user_id
  WHERE tm.seed_batch_id = '2026-05-26_seed_90users_v2';

  RAISE NOTICE 'PRE-FLIGHT OK: profiles=%, markers=%, existing_memberships=%',
    v_profile_count, v_marker_count, v_existing_mem;

  IF v_existing_mem > 0 THEN
    RAISE NOTICE 'WARNING: % users already have memberships — they will be skipped', v_existing_mem;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════
-- STEP 1: TEAM/PART ASSIGNMENT MAPPING
-- 각 카테고리(onboarding~near_graduation)가 팀 전체에 걸쳐 분산되도록 배정
-- ═══════════════════════════════════════════════════════════════════════

CREATE TEMP TABLE _membership_map (
  legacy_id   int PRIMARY KEY,
  team_name   text NOT NULL,
  part_name   text NOT NULL
);

INSERT INTO _membership_map (legacy_id, team_name, part_name) VALUES
  -- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  -- ENCRE (900031–900060): 30명
  -- 엔터테인먼트 9 / F&B 8 / 스타일 5 / 커머스 5 / 콘텐츠 3
  -- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  -- onboarding (900031–900035): 5개 팀에 1명씩 분산
  (900031, '엔터테인먼트', '플랫폼'),     -- 김민준 onboarding
  (900032, 'F&B',          '릴스'),       -- 이서연 onboarding
  (900033, '엔터테인먼트', '팬마케팅'),    -- 박지훈 onboarding
  (900034, '스타일',       '패션'),       -- 최수빈 onboarding
  (900035, '커머스',       '솔루션'),     -- 정하은 onboarding

  -- excellent (900036–900040): 주요 팀 위주
  (900036, '엔터테인먼트', '컬쳐'),       -- 강현우 excellent
  (900037, 'F&B',          '카드뉴스'),   -- 조예린 excellent
  (900038, '엔터테인먼트', '플랫폼'),     -- 윤도현 excellent
  (900039, 'F&B',          '쇼츠'),       -- 장소율 excellent
  (900040, '커머스',       '베네핏'),     -- 임시우 excellent

  -- average (900041–900045): 고르게 분산
  (900041, '엔터테인먼트', '팬마케팅'),    -- 한지민 average
  (900042, '스타일',       '뷰티'),       -- 오승현 average
  (900043, 'F&B',          '릴스'),       -- 서다은 average
  (900044, '스타일',       '패션'),       -- 신유진 average
  (900045, '커머스',       '솔루션'),     -- 권태현 average

  -- rest (900046–900050): 다양한 팀에 분산
  (900046, '엔터테인먼트', '컬쳐'),       -- 황민서 rest
  (900047, 'F&B',          '카드뉴스'),   -- 안준혁 rest
  (900048, '콘텐츠',       '코믹스'),     -- 송하린 rest
  (900049, 'F&B',          '쇼츠'),       -- 류지환 rest
  (900050, '콘텐츠',       '코믹스'),     -- 홍채원 rest

  -- failure (900051–900055): 다양한 팀에 분산
  (900051, '엔터테인먼트', '팬마케팅'),    -- 김건우 failure
  (900052, 'F&B',          '카드뉴스'),   -- 이수아 failure
  (900053, '스타일',       '뷰티'),       -- 박정우 failure
  (900054, '커머스',       '베네핏'),     -- 최예은 failure
  (900055, '콘텐츠',       '코믹스'),     -- 정시현 failure

  -- near_graduation (900056–900060): 주요 팀 위주
  (900056, '엔터테인먼트', '플랫폼'),     -- 강지아 near_graduation
  (900057, 'F&B',          '릴스'),       -- 조민재 near_graduation
  (900058, '엔터테인먼트', '컬쳐'),       -- 윤서진 near_graduation
  (900059, '스타일',       '패션'),       -- 장유준 near_graduation
  (900060, '커머스',       '솔루션'),     -- 임다인 near_graduation

  -- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  -- ORANKE (900061–900090): 30명
  -- 갤러리 9 / 프로듀싱 9 / 팬마케팅 6 / 비주얼 3 / A&R 3
  -- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  -- onboarding (900061–900065): 5개 팀에 1명씩 분산
  (900061, '갤러리',   '컬쳐'),       -- 한서준 onboarding
  (900062, '프로듀싱', '이야기'),     -- 오지우 onboarding
  (900063, '갤러리',   '매거진'),     -- 서도윤 onboarding
  (900064, '팬마케팅', 'FanFlow'),    -- 신하윤 onboarding
  (900065, '비주얼',   '일반'),       -- 권예준 onboarding

  -- excellent (900066–900070): 주요 팀 위주
  (900066, '프로듀싱', '소리'),       -- 황지유 excellent
  (900067, '갤러리',   '컬쳐'),       -- 안시우 excellent
  (900068, '갤러리',   '코믹스'),     -- 송윤서 excellent
  (900069, '팬마케팅', 'FanFlow'),    -- 류하준 excellent
  (900070, 'A&R',      '일반'),       -- 홍지후 excellent

  -- average (900071–900075): 고르게 분산
  (900071, '갤러리',   '매거진'),     -- 김주원 average
  (900072, '프로듀싱', '이야기'),     -- 이지호 average
  (900073, '팬마케팅', 'FanLog'),     -- 박수아 average
  (900074, '프로듀싱', '결'),         -- 최선우 average
  (900075, '비주얼',   '일반'),       -- 정채원 average

  -- rest (900076–900080): 다양한 팀에 분산
  (900076, '갤러리',   '컬쳐'),       -- 강서현 rest
  (900077, '프로듀싱', '소리'),       -- 조하은 rest
  (900078, '갤러리',   '코믹스'),     -- 윤민지 rest
  (900079, '팬마케팅', 'FanFlow'),    -- 장승우 rest
  (900080, 'A&R',      '일반'),       -- 임시은 rest

  -- failure (900081–900085): 다양한 팀에 분산
  (900081, '프로듀싱', '이야기'),     -- 한지윤 failure
  (900082, '갤러리',   '매거진'),     -- 오준서 failure
  (900083, '프로듀싱', '소리'),       -- 서유진 failure
  (900084, '팬마케팅', 'FanLog'),     -- 신현준 failure
  (900085, '비주얼',   '일반'),       -- 권소율 failure

  -- near_graduation (900086–900090): 주요 팀 위주
  (900086, '갤러리',   '컬쳐'),       -- 황하린 near_graduation
  (900087, '프로듀싱', '이야기'),     -- 안건우 near_graduation
  (900088, '프로듀싱', '결'),         -- 송태현 near_graduation
  (900089, '팬마케팅', 'FanLog'),     -- 류민서 near_graduation
  (900090, 'A&R',      '일반'),       -- 홍지환 near_graduation

  -- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  -- PHALANX (900091–900120): 30명
  -- IT 12 / 서비스 12 / 브랜딩 6
  -- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  -- onboarding (900091–900095)
  (900091, 'IT',     '일반'),         -- 김서윤 onboarding
  (900092, '서비스', '일반'),         -- 이하준 onboarding
  (900093, '서비스', '일반'),         -- 박민서 onboarding
  (900094, '브랜딩', '일반'),         -- 최지후 onboarding
  (900095, '브랜딩', '일반'),         -- 정도윤 onboarding

  -- excellent (900096–900100)
  (900096, 'IT',     '일반'),         -- 강시은 excellent
  (900097, 'IT',     '일반'),         -- 조현우 excellent
  (900098, '서비스', '일반'),         -- 윤예린 excellent
  (900099, '서비스', '일반'),         -- 장준혁 excellent
  (900100, '브랜딩', '일반'),         -- 임수빈 excellent

  -- average (900101–900105)
  (900101, 'IT',     '일반'),         -- 한유준 average
  (900102, '서비스', '일반'),         -- 오다은 average
  (900103, 'IT',     '일반'),         -- 서승현 average
  (900104, '서비스', '일반'),         -- 신소율 average
  (900105, '브랜딩', '일반'),         -- 권지민 average

  -- rest (900106–900110)
  (900106, 'IT',     '일반'),         -- 황하은 rest
  (900107, 'IT',     '일반'),         -- 안태우 rest
  (900108, '서비스', '일반'),         -- 송지아 rest
  (900109, '서비스', '일반'),         -- 류서진 rest
  (900110, '브랜딩', '일반'),         -- 홍예린 rest

  -- failure (900111–900115)
  (900111, 'IT',     '일반'),         -- 김예은 failure
  (900112, 'IT',     '일반'),         -- 이정우 failure
  (900113, '서비스', '일반'),         -- 박하린 failure
  (900114, '서비스', '일반'),         -- 최민재 failure
  (900115, '브랜딩', '일반'),         -- 정유진 failure

  -- near_graduation (900116–900120)
  (900116, 'IT',     '일반'),         -- 강지환 near_graduation
  (900117, '서비스', '일반'),         -- 조서현 near_graduation
  (900118, 'IT',     '일반'),         -- 윤태현 near_graduation
  (900119, 'IT',     '일반'),         -- 장시현 near_graduation
  (900120, '서비스', '일반');         -- 임건우 near_graduation


-- ═══════════════════════════════════════════════════════════════════════
-- STEP 2: PREVIEW SELECT — 실행 전 확인용
-- 이 쿼리 결과를 확인한 뒤 STEP 3를 실행하세요
-- ═══════════════════════════════════════════════════════════════════════

-- 2-A: 전체 배정 미리보기 (90행)
SELECT
  u.legacy_user_id,
  up.display_name,
  up.organization_slug,
  tm.user_type AS category,
  mm.team_name,
  mm.part_name,
  CASE tm.user_type
    WHEN 'excellent'        THEN '심화'
    WHEN 'near_graduation'  THEN '심화'
    ELSE '일반'
  END AS membership_level,
  CASE tm.user_type
    WHEN 'rest' THEN 'weekly_rest'
    ELSE 'active'
  END AS membership_state,
  true AS is_current,
  CASE WHEN em.user_id IS NOT NULL THEN '⚠ SKIP (already exists)' ELSE '✓ INSERT' END AS action
FROM public.users u
JOIN public.user_profiles up ON up.user_id = u.id
JOIN public.test_user_markers tm ON tm.user_id = u.id
JOIN _membership_map mm ON mm.legacy_id = u.legacy_user_id
LEFT JOIN public.user_memberships em ON em.user_id = u.id
WHERE tm.seed_batch_id = '2026-05-26_seed_90users_v2'
ORDER BY u.legacy_user_id;

-- 2-B: 조직별 팀/파트 분포 요약
SELECT
  up.organization_slug,
  mm.team_name,
  mm.part_name,
  COUNT(*) AS cnt
FROM public.users u
JOIN public.user_profiles up ON up.user_id = u.id
JOIN public.test_user_markers tm ON tm.user_id = u.id
JOIN _membership_map mm ON mm.legacy_id = u.legacy_user_id
LEFT JOIN public.user_memberships em ON em.user_id = u.id
WHERE tm.seed_batch_id = '2026-05-26_seed_90users_v2'
  AND em.user_id IS NULL
GROUP BY up.organization_slug, mm.team_name, mm.part_name
ORDER BY up.organization_slug, mm.team_name, mm.part_name;

-- 2-C: INSERT 대상 row count
SELECT
  COUNT(*) FILTER (WHERE em.user_id IS NULL) AS will_insert,
  COUNT(*) FILTER (WHERE em.user_id IS NOT NULL) AS will_skip,
  COUNT(*) AS total
FROM public.users u
JOIN public.test_user_markers tm ON tm.user_id = u.id
JOIN _membership_map mm ON mm.legacy_id = u.legacy_user_id
LEFT JOIN public.user_memberships em ON em.user_id = u.id
WHERE tm.seed_batch_id = '2026-05-26_seed_90users_v2';


-- ═══════════════════════════════════════════════════════════════════════
-- STEP 3: INSERT — preview 확인 후 실행
-- 이미 membership이 있는 유저는 LEFT JOIN + WHERE IS NULL로 제외
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO public.user_memberships (
  user_id, team_name, part_name, membership_level, membership_state, is_current
)
SELECT
  u.id,
  mm.team_name,
  mm.part_name,
  CASE tm.user_type
    WHEN 'excellent'        THEN '심화'
    WHEN 'near_graduation'  THEN '심화'
    ELSE '일반'
  END,
  CASE tm.user_type
    WHEN 'rest' THEN 'weekly_rest'
    ELSE 'active'
  END,
  true
FROM public.users u
JOIN public.test_user_markers tm ON tm.user_id = u.id
JOIN _membership_map mm ON mm.legacy_id = u.legacy_user_id
LEFT JOIN public.user_memberships em ON em.user_id = u.id
WHERE tm.seed_batch_id = '2026-05-26_seed_90users_v2'
  AND em.user_id IS NULL;


-- ═══════════════════════════════════════════════════════════════════════
-- STEP 4: POST-INSERT VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_total           int;
  v_encre           int;
  v_oranke          int;
  v_phalanx         int;
  v_level_simhwa    int;
  v_level_ilban     int;
  v_state_active    int;
  v_state_rest      int;
BEGIN
  -- 전체 membership count
  SELECT COUNT(*) INTO v_total
  FROM public.user_memberships um
  JOIN public.test_user_markers tm ON tm.user_id = um.user_id
  WHERE tm.seed_batch_id = '2026-05-26_seed_90users_v2';

  -- 조직별 count
  SELECT COUNT(*) INTO v_encre
  FROM public.user_memberships um
  JOIN public.test_user_markers tm ON tm.user_id = um.user_id
  JOIN public.user_profiles up ON up.user_id = um.user_id
  WHERE tm.seed_batch_id = '2026-05-26_seed_90users_v2'
    AND up.organization_slug = 'encre';

  SELECT COUNT(*) INTO v_oranke
  FROM public.user_memberships um
  JOIN public.test_user_markers tm ON tm.user_id = um.user_id
  JOIN public.user_profiles up ON up.user_id = um.user_id
  WHERE tm.seed_batch_id = '2026-05-26_seed_90users_v2'
    AND up.organization_slug = 'oranke';

  SELECT COUNT(*) INTO v_phalanx
  FROM public.user_memberships um
  JOIN public.test_user_markers tm ON tm.user_id = um.user_id
  JOIN public.user_profiles up ON up.user_id = um.user_id
  WHERE tm.seed_batch_id = '2026-05-26_seed_90users_v2'
    AND up.organization_slug = 'phalanx';

  -- membership_level 분포
  SELECT COUNT(*) INTO v_level_simhwa
  FROM public.user_memberships um
  JOIN public.test_user_markers tm ON tm.user_id = um.user_id
  WHERE tm.seed_batch_id = '2026-05-26_seed_90users_v2'
    AND um.membership_level = '심화';

  SELECT COUNT(*) INTO v_level_ilban
  FROM public.user_memberships um
  JOIN public.test_user_markers tm ON tm.user_id = um.user_id
  WHERE tm.seed_batch_id = '2026-05-26_seed_90users_v2'
    AND um.membership_level = '일반';

  -- membership_state 분포
  SELECT COUNT(*) INTO v_state_active
  FROM public.user_memberships um
  JOIN public.test_user_markers tm ON tm.user_id = um.user_id
  WHERE tm.seed_batch_id = '2026-05-26_seed_90users_v2'
    AND um.membership_state = 'active';

  SELECT COUNT(*) INTO v_state_rest
  FROM public.user_memberships um
  JOIN public.test_user_markers tm ON tm.user_id = um.user_id
  WHERE tm.seed_batch_id = '2026-05-26_seed_90users_v2'
    AND um.membership_state = 'weekly_rest';

  -- 검증
  IF v_total <> 90 THEN
    RAISE EXCEPTION 'VERIFY FAIL: total memberships = % (expected 90)', v_total;
  END IF;

  IF v_encre <> 30 THEN
    RAISE EXCEPTION 'VERIFY FAIL: encre = % (expected 30)', v_encre;
  END IF;

  IF v_oranke <> 30 THEN
    RAISE EXCEPTION 'VERIFY FAIL: oranke = % (expected 30)', v_oranke;
  END IF;

  IF v_phalanx <> 30 THEN
    RAISE EXCEPTION 'VERIFY FAIL: phalanx = % (expected 30)', v_phalanx;
  END IF;

  -- excellent(10) + near_graduation(10) = 심화 20명 (조직당 10명 × 2카테고리 / 3조직 → 전체 20)
  -- 나머지 70명 = 일반
  IF v_level_simhwa <> 30 THEN
    RAISE EXCEPTION 'VERIFY FAIL: 심화 = % (expected 30)', v_level_simhwa;
  END IF;

  IF v_level_ilban <> 60 THEN
    RAISE EXCEPTION 'VERIFY FAIL: 일반 = % (expected 60)', v_level_ilban;
  END IF;

  -- rest 카테고리 = 조직당 5명 × 3조직 = 15명 weekly_rest
  -- 나머지 75명 = active
  IF v_state_rest <> 15 THEN
    RAISE EXCEPTION 'VERIFY FAIL: weekly_rest = % (expected 15)', v_state_rest;
  END IF;

  IF v_state_active <> 75 THEN
    RAISE EXCEPTION 'VERIFY FAIL: active = % (expected 75)', v_state_active;
  END IF;

  RAISE NOTICE '══════════════════════════════════════════════';
  RAISE NOTICE 'VERIFICATION PASSED';
  RAISE NOTICE '  total     = %', v_total;
  RAISE NOTICE '  encre     = %  oranke = %  phalanx = %', v_encre, v_oranke, v_phalanx;
  RAISE NOTICE '  심화      = %  일반   = %', v_level_simhwa, v_level_ilban;
  RAISE NOTICE '  active    = %  weekly_rest = %', v_state_active, v_state_rest;
  RAISE NOTICE '══════════════════════════════════════════════';
END $$;


-- 4-B: 팀/파트별 상세 분포 확인
SELECT
  up.organization_slug AS org,
  um.team_name,
  um.part_name,
  um.membership_level,
  COUNT(*) AS cnt,
  COUNT(*) FILTER (WHERE um.membership_state = 'active') AS active,
  COUNT(*) FILTER (WHERE um.membership_state = 'weekly_rest') AS rest
FROM public.user_memberships um
JOIN public.test_user_markers tm ON tm.user_id = um.user_id
JOIN public.user_profiles up ON up.user_id = um.user_id
WHERE tm.seed_batch_id = '2026-05-26_seed_90users_v2'
GROUP BY up.organization_slug, um.team_name, um.part_name, um.membership_level
ORDER BY up.organization_slug, um.team_name, um.part_name;


-- cleanup temp table
DROP TABLE IF EXISTS _membership_map;

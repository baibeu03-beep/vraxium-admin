/*************************************************************
 * SEED: 90 TEST Users — Cluster3 / Period / Point / Rank / Graduation 검증용
 * Batch ID : 2026-05-26_seed_90users_v2
 * Legacy ID: 900031–900120
 *
 * 조직별 30명 x 3 (Encre / Oranke / Phalanx)
 * 카테고리 (각 조직 5명씩):
 *   온보딩(onboarding) | 우수(excellent) | 평균(average)
 *   휴식(rest)         | 실패(failure)   | 졸업직전(near_graduation)
 *
 * Display name : "실명 [TEST]"
 * auth.users   : FK 안전을 위한 최소 shell (로그인 비대상)
 * 졸업 기준    : approved_weeks (Encre/Phalanx >= 30, Oranke >= 25)
 *
 * INSERT 순서 (FK 체인): auth.users → public.users → user_profiles → test_user_markers → 나머지
 * 전체 단일 트랜잭션. 중간 오류 시 전체 ROLLBACK.
 *************************************************************/

BEGIN;


-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 0: PRE-FLIGHT COLLISION CHECK
-- ═══════════════════════════════════════════════════════════════════════

DO $$
DECLARE v_cnt int;
BEGIN
  SELECT COUNT(*) INTO v_cnt FROM public.users
  WHERE legacy_user_id BETWEEN 900031 AND 900120;
  IF v_cnt > 0 THEN
    RAISE EXCEPTION 'COLLISION: % rows in public.users legacy_user_id 900031-900120', v_cnt;
  END IF;

  SELECT COUNT(*) INTO v_cnt FROM auth.users
  WHERE email ~ '^test\d{3}@vraxium\.test$';
  IF v_cnt > 0 THEN
    RAISE EXCEPTION 'COLLISION: % auth.users matching test{NNN}@vraxium.test', v_cnt;
  END IF;

  SELECT COUNT(*) INTO v_cnt FROM public.user_profiles
  WHERE contact_phone LIKE '010-9901-%';
  IF v_cnt > 0 THEN
    RAISE EXCEPTION 'COLLISION: % rows with phone 010-9901-*', v_cnt;
  END IF;

  RAISE NOTICE 'Pre-flight OK: no collisions detected';
END $$;


-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 1: SEED CONFIG TEMP TABLE
-- ═══════════════════════════════════════════════════════════════════════

CREATE TEMP TABLE _seed90 (
  seq         int PRIMARY KEY,
  user_uuid   uuid NOT NULL DEFAULT gen_random_uuid(),
  legacy_id   int  NOT NULL,
  dname       text NOT NULL,
  gender      text NOT NULL,
  org_slug    text NOT NULL,
  category    text NOT NULL,
  email       text NOT NULL,
  phone       text NOT NULL,
  birth_date  date NOT NULL,
  school      text NOT NULL,
  dept        text NOT NULL
);

INSERT INTO _seed90
  (seq, legacy_id, dname, gender, org_slug, category, email, phone, birth_date, school, dept)
VALUES
  -- ENCRE onboarding
  ( 1, 900031, '김민준 [TEST]', '남', 'encre', 'onboarding', 'test031@vraxium.test', '010-9901-0031', '2002-03-15', '서울대', '경영학과'),
  ( 2, 900032, '이서연 [TEST]', '여', 'encre', 'onboarding', 'test032@vraxium.test', '010-9901-0032', '2001-07-22', '연세대', '컴퓨터공학과'),
  ( 3, 900033, '박지훈 [TEST]', '남', 'encre', 'onboarding', 'test033@vraxium.test', '010-9901-0033', '2003-01-08', '고려대', '디자인학과'),
  ( 4, 900034, '최수빈 [TEST]', '여', 'encre', 'onboarding', 'test034@vraxium.test', '010-9901-0034', '2002-11-19', '카이스트', '미디어학과'),
  ( 5, 900035, '정하은 [TEST]', '여', 'encre', 'onboarding', 'test035@vraxium.test', '010-9901-0035', '2001-05-30', '포스텍', '전자공학과'),
  -- ENCRE excellent
  ( 6, 900036, '강현우 [TEST]', '남', 'encre', 'excellent',  'test036@vraxium.test', '010-9901-0036', '2000-09-12', '한양대', '심리학과'),
  ( 7, 900037, '조예린 [TEST]', '여', 'encre', 'excellent',  'test037@vraxium.test', '010-9901-0037', '2003-02-28', '서강대', '경영학과'),
  ( 8, 900038, '윤도현 [TEST]', '남', 'encre', 'excellent',  'test038@vraxium.test', '010-9901-0038', '2001-12-05', '성균관대', '컴퓨터공학과'),
  ( 9, 900039, '장소율 [TEST]', '여', 'encre', 'excellent',  'test039@vraxium.test', '010-9901-0039', '2002-06-17', '서울대', '디자인학과'),
  (10, 900040, '임시우 [TEST]', '남', 'encre', 'excellent',  'test040@vraxium.test', '010-9901-0040', '2000-04-23', '연세대', '미디어학과'),
  -- ENCRE average
  (11, 900041, '한지민 [TEST]', '여', 'encre', 'average',    'test041@vraxium.test', '010-9901-0041', '2001-08-09', '고려대', '전자공학과'),
  (12, 900042, '오승현 [TEST]', '남', 'encre', 'average',    'test042@vraxium.test', '010-9901-0042', '2003-10-14', '카이스트', '심리학과'),
  (13, 900043, '서다은 [TEST]', '여', 'encre', 'average',    'test043@vraxium.test', '010-9901-0043', '2002-01-26', '포스텍', '경영학과'),
  (14, 900044, '신유진 [TEST]', '여', 'encre', 'average',    'test044@vraxium.test', '010-9901-0044', '2000-07-03', '한양대', '컴퓨터공학과'),
  (15, 900045, '권태현 [TEST]', '남', 'encre', 'average',    'test045@vraxium.test', '010-9901-0045', '2001-11-18', '서강대', '디자인학과'),
  -- ENCRE rest
  (16, 900046, '황민서 [TEST]', '여', 'encre', 'rest',       'test046@vraxium.test', '010-9901-0046', '2002-04-07', '성균관대', '미디어학과'),
  (17, 900047, '안준혁 [TEST]', '남', 'encre', 'rest',       'test047@vraxium.test', '010-9901-0047', '2003-08-21', '서울대', '전자공학과'),
  (18, 900048, '송하린 [TEST]', '여', 'encre', 'rest',       'test048@vraxium.test', '010-9901-0048', '2001-02-14', '연세대', '심리학과'),
  (19, 900049, '류지환 [TEST]', '남', 'encre', 'rest',       'test049@vraxium.test', '010-9901-0049', '2000-06-29', '고려대', '경영학과'),
  (20, 900050, '홍채원 [TEST]', '여', 'encre', 'rest',       'test050@vraxium.test', '010-9901-0050', '2002-10-03', '카이스트', '컴퓨터공학과'),
  -- ENCRE failure
  (21, 900051, '김건우 [TEST]', '남', 'encre', 'failure',    'test051@vraxium.test', '010-9901-0051', '2001-01-16', '포스텍', '디자인학과'),
  (22, 900052, '이수아 [TEST]', '여', 'encre', 'failure',    'test052@vraxium.test', '010-9901-0052', '2003-05-08', '한양대', '미디어학과'),
  (23, 900053, '박정우 [TEST]', '남', 'encre', 'failure',    'test053@vraxium.test', '010-9901-0053', '2002-09-25', '서강대', '전자공학과'),
  (24, 900054, '최예은 [TEST]', '여', 'encre', 'failure',    'test054@vraxium.test', '010-9901-0054', '2000-12-11', '성균관대', '심리학과'),
  (25, 900055, '정시현 [TEST]', '남', 'encre', 'failure',    'test055@vraxium.test', '010-9901-0055', '2001-03-27', '서울대', '경영학과'),
  -- ENCRE near_graduation
  (26, 900056, '강지아 [TEST]', '여', 'encre', 'near_graduation', 'test056@vraxium.test', '010-9901-0056', '2002-07-14', '연세대', '컴퓨터공학과'),
  (27, 900057, '조민재 [TEST]', '남', 'encre', 'near_graduation', 'test057@vraxium.test', '010-9901-0057', '2003-11-02', '고려대', '디자인학과'),
  (28, 900058, '윤서진 [TEST]', '여', 'encre', 'near_graduation', 'test058@vraxium.test', '010-9901-0058', '2001-04-19', '카이스트', '미디어학과'),
  (29, 900059, '장유준 [TEST]', '남', 'encre', 'near_graduation', 'test059@vraxium.test', '010-9901-0059', '2000-08-06', '포스텍', '전자공학과'),
  (30, 900060, '임다인 [TEST]', '여', 'encre', 'near_graduation', 'test060@vraxium.test', '010-9901-0060', '2002-12-23', '한양대', '심리학과'),
  -- ORANKE onboarding
  (31, 900061, '한서준 [TEST]', '남', 'oranke', 'onboarding', 'test061@vraxium.test', '010-9901-0061', '2001-06-18', '서강대', '경영학과'),
  (32, 900062, '오지우 [TEST]', '여', 'oranke', 'onboarding', 'test062@vraxium.test', '010-9901-0062', '2003-03-09', '성균관대', '컴퓨터공학과'),
  (33, 900063, '서도윤 [TEST]', '남', 'oranke', 'onboarding', 'test063@vraxium.test', '010-9901-0063', '2002-08-24', '서울대', '디자인학과'),
  (34, 900064, '신하윤 [TEST]', '여', 'oranke', 'onboarding', 'test064@vraxium.test', '010-9901-0064', '2000-02-15', '연세대', '미디어학과'),
  (35, 900065, '권예준 [TEST]', '남', 'oranke', 'onboarding', 'test065@vraxium.test', '010-9901-0065', '2001-10-07', '고려대', '전자공학과'),
  -- ORANKE excellent
  (36, 900066, '황지유 [TEST]', '여', 'oranke', 'excellent',  'test066@vraxium.test', '010-9901-0066', '2002-05-21', '카이스트', '심리학과'),
  (37, 900067, '안시우 [TEST]', '남', 'oranke', 'excellent',  'test067@vraxium.test', '010-9901-0067', '2003-09-13', '포스텍', '경영학과'),
  (38, 900068, '송윤서 [TEST]', '여', 'oranke', 'excellent',  'test068@vraxium.test', '010-9901-0068', '2001-01-29', '한양대', '컴퓨터공학과'),
  (39, 900069, '류하준 [TEST]', '남', 'oranke', 'excellent',  'test069@vraxium.test', '010-9901-0069', '2000-11-04', '서강대', '디자인학과'),
  (40, 900070, '홍지후 [TEST]', '남', 'oranke', 'excellent',  'test070@vraxium.test', '010-9901-0070', '2002-03-16', '성균관대', '미디어학과'),
  -- ORANKE average
  (41, 900071, '김주원 [TEST]', '남', 'oranke', 'average',    'test071@vraxium.test', '010-9901-0071', '2001-07-28', '서울대', '전자공학과'),
  (42, 900072, '이지호 [TEST]', '남', 'oranke', 'average',    'test072@vraxium.test', '010-9901-0072', '2003-12-10', '연세대', '심리학과'),
  (43, 900073, '박수아 [TEST]', '여', 'oranke', 'average',    'test073@vraxium.test', '010-9901-0073', '2002-02-05', '고려대', '경영학과'),
  (44, 900074, '최선우 [TEST]', '남', 'oranke', 'average',    'test074@vraxium.test', '010-9901-0074', '2000-06-19', '카이스트', '컴퓨터공학과'),
  (45, 900075, '정채원 [TEST]', '여', 'oranke', 'average',    'test075@vraxium.test', '010-9901-0075', '2001-11-01', '포스텍', '디자인학과'),
  -- ORANKE rest
  (46, 900076, '강서현 [TEST]', '여', 'oranke', 'rest',       'test076@vraxium.test', '010-9901-0076', '2002-04-13', '한양대', '미디어학과'),
  (47, 900077, '조하은 [TEST]', '여', 'oranke', 'rest',       'test077@vraxium.test', '010-9901-0077', '2003-08-25', '서강대', '전자공학과'),
  (48, 900078, '윤민지 [TEST]', '여', 'oranke', 'rest',       'test078@vraxium.test', '010-9901-0078', '2001-02-17', '성균관대', '심리학과'),
  (49, 900079, '장승우 [TEST]', '남', 'oranke', 'rest',       'test079@vraxium.test', '010-9901-0079', '2000-10-08', '서울대', '경영학과'),
  (50, 900080, '임시은 [TEST]', '여', 'oranke', 'rest',       'test080@vraxium.test', '010-9901-0080', '2002-06-22', '연세대', '컴퓨터공학과'),
  -- ORANKE failure
  (51, 900081, '한지윤 [TEST]', '여', 'oranke', 'failure',    'test081@vraxium.test', '010-9901-0081', '2001-01-03', '고려대', '디자인학과'),
  (52, 900082, '오준서 [TEST]', '남', 'oranke', 'failure',    'test082@vraxium.test', '010-9901-0082', '2003-05-14', '카이스트', '미디어학과'),
  (53, 900083, '서유진 [TEST]', '여', 'oranke', 'failure',    'test083@vraxium.test', '010-9901-0083', '2002-09-27', '포스텍', '전자공학과'),
  (54, 900084, '신현준 [TEST]', '남', 'oranke', 'failure',    'test084@vraxium.test', '010-9901-0084', '2000-12-19', '한양대', '심리학과'),
  (55, 900085, '권소율 [TEST]', '여', 'oranke', 'failure',    'test085@vraxium.test', '010-9901-0085', '2001-04-02', '서강대', '경영학과'),
  -- ORANKE near_graduation
  (56, 900086, '황하린 [TEST]', '여', 'oranke', 'near_graduation', 'test086@vraxium.test', '010-9901-0086', '2002-08-11', '성균관대', '컴퓨터공학과'),
  (57, 900087, '안건우 [TEST]', '남', 'oranke', 'near_graduation', 'test087@vraxium.test', '010-9901-0087', '2003-12-26', '서울대', '디자인학과'),
  (58, 900088, '송태현 [TEST]', '남', 'oranke', 'near_graduation', 'test088@vraxium.test', '010-9901-0088', '2001-03-18', '연세대', '미디어학과'),
  (59, 900089, '류민서 [TEST]', '여', 'oranke', 'near_graduation', 'test089@vraxium.test', '010-9901-0089', '2000-07-09', '고려대', '전자공학과'),
  (60, 900090, '홍지환 [TEST]', '남', 'oranke', 'near_graduation', 'test090@vraxium.test', '010-9901-0090', '2002-11-21', '카이스트', '심리학과'),
  -- PHALANX onboarding
  (61, 900091, '김서윤 [TEST]', '여', 'phalanx', 'onboarding', 'test091@vraxium.test', '010-9901-0091', '2001-05-06', '포스���', '경영학과'),
  (62, 900092, '이하준 [TEST]', '남', 'phalanx', 'onboarding', 'test092@vraxium.test', '010-9901-0092', '2003-09-18', '한양대', '컴퓨터공학과'),
  (63, 900093, '박민서 [TEST]', '여', 'phalanx', 'onboarding', 'test093@vraxium.test', '010-9901-0093', '2002-01-31', '서강대', '디자인학과'),
  (64, 900094, '최지후 [TEST]', '남', 'phalanx', 'onboarding', 'test094@vraxium.test', '010-9901-0094', '2000-08-12', '성균관대', '미디어학과'),
  (65, 900095, '정도윤 [TEST]', '남', 'phalanx', 'onboarding', 'test095@vraxium.test', '010-9901-0095', '2001-12-24', '서울대', '전자공학과'),
  -- PHALANX excellent
  (66, 900096, '강시은 [TEST]', '여', 'phalanx', 'excellent',  'test096@vraxium.test', '010-9901-0096', '2002-04-17', '연세대', '심리학과'),
  (67, 900097, '조현우 [TEST]', '남', 'phalanx', 'excellent',  'test097@vraxium.test', '010-9901-0097', '2003-06-29', '고려대', '경영학과'),
  (68, 900098, '윤예린 [TEST]', '여', 'phalanx', 'excellent',  'test098@vraxium.test', '010-9901-0098', '2001-10-15', '카이스트', '컴퓨터공학과'),
  (69, 900099, '장준혁 [TEST]', '남', 'phalanx', 'excellent',  'test099@vraxium.test', '010-9901-0099', '2000-02-08', '포스텍', '디자인학과'),
  (70, 900100, '임수빈 [TEST]', '여', 'phalanx', 'excellent',  'test100@vraxium.test', '010-9901-0100', '2002-07-23', '한양대', '미디어학과'),
  -- PHALANX average
  (71, 900101, '한유준 [TEST]', '남', 'phalanx', 'average',    'test101@vraxium.test', '010-9901-0101', '2001-11-05', '서강대', '전자공학과'),
  (72, 900102, '오다은 [TEST]', '여', 'phalanx', 'average',    'test102@vraxium.test', '010-9901-0102', '2003-03-20', '성균관대', '심리학과'),
  (73, 900103, '서승현 [TEST]', '남', 'phalanx', 'average',    'test103@vraxium.test', '010-9901-0103', '2002-08-01', '서울대', '경영학과'),
  (74, 900104, '신소율 [TEST]', '여', 'phalanx', 'average',    'test104@vraxium.test', '010-9901-0104', '2000-12-13', '연세대', '컴퓨터공학과'),
  (75, 900105, '권지민 [TEST]', '여', 'phalanx', 'average',    'test105@vraxium.test', '010-9901-0105', '2001-04-28', '고려대', '디자인학과'),
  -- PHALANX rest
  (76, 900106, '황하은 [TEST]', '여', 'phalanx', 'rest',       'test106@vraxium.test', '010-9901-0106', '2002-09-09', '카이스트', '미디어학과'),
  (77, 900107, '안태우 [TEST]', '남', 'phalanx', 'rest',       'test107@vraxium.test', '010-9901-0107', '2003-01-22', '포스텍', '전자공학과'),
  (78, 900108, '송지아 [TEST]', '여', 'phalanx', 'rest',       'test108@vraxium.test', '010-9901-0108', '2001-06-14', '한양대', '심리학과'),
  (79, 900109, '류서진 [TEST]', '여', 'phalanx', 'rest',       'test109@vraxium.test', '010-9901-0109', '2000-10-27', '서강대', '경영학과'),
  (80, 900110, '홍예린 [TEST]', '여', 'phalanx', 'rest',       'test110@vraxium.test', '010-9901-0110', '2002-02-19', '성균관대', '컴퓨터공학과'),
  -- PHALANX failure
  (81, 900111, '김예은 [TEST]', '여', 'phalanx', 'failure',    'test111@vraxium.test', '010-9901-0111', '2001-07-06', '서울대', '디자인학과'),
  (82, 900112, '이정우 [TEST]', '남', 'phalanx', 'failure',    'test112@vraxium.test', '010-9901-0112', '2003-11-18', '연세대', '미디어학과'),
  (83, 900113, '박하린 [TEST]', '여', 'phalanx', 'failure',    'test113@vraxium.test', '010-9901-0113', '2002-03-03', '고려대', '전자공학과'),
  (84, 900114, '최민재 [TEST]', '남', 'phalanx', 'failure',    'test114@vraxium.test', '010-9901-0114', '2000-05-25', '카이스트', '심리학과'),
  (85, 900115, '정유진 [TEST]', '여', 'phalanx', 'failure',    'test115@vraxium.test', '010-9901-0115', '2001-09-16', '포스텍', '경영학과'),
  -- PHALANX near_graduation
  (86, 900116, '강지환 [TEST]', '남', 'phalanx', 'near_graduation', 'test116@vraxium.test', '010-9901-0116', '2002-01-08', '한양대', '컴퓨터공학과'),
  (87, 900117, '조서현 [TEST]', '여', 'phalanx', 'near_graduation', 'test117@vraxium.test', '010-9901-0117', '2003-05-30', '서강대', '디자인학과'),
  (88, 900118, '윤태현 [TEST]', '남', 'phalanx', 'near_graduation', 'test118@vraxium.test', '010-9901-0118', '2001-08-22', '성균관대', '미디어학과'),
  (89, 900119, '장시현 [TEST]', '남', 'phalanx', 'near_graduation', 'test119@vraxium.test', '010-9901-0119', '2000-11-14', '서울대', '전자공학과'),
  (90, 900120, '임건우 [TEST]', '남', 'phalanx', 'near_graduation', 'test120@vraxium.test', '010-9901-0120', '2002-06-06', '연세대', '심리학과');


-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 2: auth.users (FK 안전용 shell)
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO auth.users (
  id, instance_id, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  aud, role,
  raw_app_meta_data, raw_user_meta_data,
  is_super_admin, is_sso_user
)
SELECT
  s.user_uuid,
  '00000000-0000-0000-0000-000000000000'::uuid,
  s.email,
  crypt('NoLogin!Shell2026', gen_salt('bf')),
  now(), now() - INTERVAL '90 days', now(),
  'authenticated', 'authenticated',
  jsonb_build_object('provider', 'email', 'providers', ARRAY['email']),
  jsonb_build_object(
    'seed_batch_id', '2026-05-26_seed_90users_v2',
    'is_test_user', true,
    'login_disabled', true
  ),
  false, false
FROM _seed90 s
ON CONFLICT (id) DO NOTHING;


-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 3: public.users (legacy_user_id 매핑)
-- FK: user_profiles.user_id → public.users(id)
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO public.users (id, legacy_user_id)
SELECT s.user_uuid, s.legacy_id
FROM _seed90 s
ON CONFLICT (id) DO NOTHING;


-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 4: user_profiles
-- FK: user_id → public.users(id) ON DELETE CASCADE
-- NOT NULL: user_id, created_at, updated_at (나머지 전부 NULL 허용)
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO public.user_profiles (
  user_id, display_name, gender, birth_date,
  contact_phone, contact_email, auth_email,
  school_name, department_name, address,
  organization_slug, status,
  created_at, updated_at
)
SELECT
  s.user_uuid, s.dname, s.gender, s.birth_date,
  s.phone, s.email, s.email,
  s.school, s.dept, 'Seoul (TEST)',
  s.org_slug, 'active',
  now() - INTERVAL '90 days', now()
FROM _seed90 s
ON CONFLICT (user_id) DO NOTHING;


-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 5: test_user_markers
-- FK: user_id → user_profiles(user_id)
-- NOT NULL: user_id, seed_batch_id, legacy_user_id, user_type, created_at
-- UNIQUE: legacy_user_id
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO public.test_user_markers (user_id, seed_batch_id, legacy_user_id, user_type, note)
SELECT
  s.user_uuid,
  '2026-05-26_seed_90users_v2',
  s.legacy_id,
  s.category,
  'org=' || s.org_slug || ', category=' || s.category
FROM _seed90 s
ON CONFLICT (user_id) DO NOTHING;


-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 6: GROWTH DATA (DO block)
-- ═══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  rec RECORD;
  v_cat_offset    int;
  v_sub           int;
  v_org           text;
  v_growth_status text;
  v_profile_status text;
  v_started_at    timestamptz;
  v_ended_at      timestamptz;
  v_success       int;
  v_fail          int;
  v_personal_rest int;
  v_official_rest int;
  v_total_weeks   int;
  v_grad_threshold int;
  v_total_stars   int;
  v_total_raw_adv int;
  v_total_light   int;
  v_total_shields int;
  v_week_cursor   date;
  v_week_count    int;
  v_iso_year      int;
  v_iso_week      int;
  v_status        text;
  v_s_placed      int;
  v_f_placed      int;
  v_p_placed      int;
  v_d_placed      int;
BEGIN
  FOR rec IN SELECT user_uuid, legacy_id, org_slug, category FROM _seed90 ORDER BY seq
  LOOP
    v_org := rec.org_slug;
    v_cat_offset := (rec.legacy_id - 900031) % 30;
    v_sub := v_cat_offset % 5;
    v_ended_at := NULL;
    v_profile_status := 'active';
    v_grad_threshold := CASE v_org WHEN 'oranke' THEN 25 ELSE 30 END;

    IF rec.category = 'onboarding' THEN
      v_growth_status := 'active';
      v_total_weeks   := 4;
      v_official_rest := 0;
      v_personal_rest := 0;
      v_success       := 3 + (v_sub % 2);
      v_fail          := v_total_weeks - v_success;
      v_total_stars   := v_success * 2 + v_sub;
      v_total_raw_adv := v_success;
      v_total_light   := 0;

    ELSIF rec.category = 'excellent' THEN
      v_growth_status := 'active';
      v_total_weeks   := 18 + v_sub;
      v_official_rest := CASE WHEN v_total_weeks >= 20 THEN 2 ELSE 1 END;
      v_personal_rest := 0;
      v_fail          := v_sub % 2;
      v_success       := v_total_weeks - v_official_rest - v_fail;
      v_total_stars   := v_success * 3 + v_sub;
      v_total_raw_adv := v_success * 2;
      v_total_light   := 0;

    ELSIF rec.category = 'average' THEN
      v_growth_status := 'active';
      v_total_weeks   := 12 + v_sub;
      v_official_rest := CASE WHEN v_total_weeks >= 14 THEN 2 ELSE 1 END;
      v_personal_rest := 1;
      v_fail          := 3 + (v_sub % 3);
      v_success       := v_total_weeks - v_official_rest - v_personal_rest - v_fail;
      IF v_success < 2 THEN v_success := 2; v_fail := v_total_weeks - v_official_rest - v_personal_rest - v_success; END IF;
      v_total_stars   := v_success * 2 + (v_sub % 3);
      v_total_raw_adv := v_success + v_sub;
      v_total_light   := v_fail;

    ELSIF rec.category = 'rest' THEN
      CASE v_sub
        WHEN 0 THEN v_growth_status := 'seasonal_rest';
        WHEN 1 THEN v_growth_status := 'paused';
        WHEN 2 THEN v_growth_status := 'seasonal_rest'; v_profile_status := 'weekly_rest';
        WHEN 3 THEN v_growth_status := 'paused';
        WHEN 4 THEN v_growth_status := 'seasonal_rest';
      END CASE;
      v_total_weeks   := 12 + v_sub;
      v_official_rest := 2;
      v_personal_rest := 2 + (v_sub % 3);
      v_fail          := 1 + (v_sub % 2);
      v_success       := v_total_weeks - v_official_rest - v_personal_rest - v_fail;
      IF v_success < 2 THEN v_success := 2; v_fail := v_total_weeks - v_official_rest - v_personal_rest - v_success; END IF;
      v_total_stars   := v_success * 2;
      v_total_raw_adv := v_success + 1;
      v_total_light   := v_fail + v_personal_rest;

    ELSIF rec.category = 'failure' THEN
      v_growth_status := 'active';
      v_total_weeks   := 10 + v_sub;
      v_official_rest := CASE WHEN v_total_weeks >= 12 THEN 2 ELSE 1 END;
      v_personal_rest := 0;
      v_success       := 3 + (v_sub % 2);
      v_fail          := v_total_weeks - v_official_rest - v_success;
      v_total_stars   := v_success;
      v_total_raw_adv := 1;
      v_total_light   := v_fail * 2;

    ELSIF rec.category = 'near_graduation' THEN
      CASE v_sub
        WHEN 0 THEN
          v_growth_status := 'graduating'; v_success := v_grad_threshold - 3;
          v_fail := 3; v_personal_rest := 1; v_official_rest := 2;
        WHEN 1 THEN
          v_growth_status := 'graduating'; v_success := v_grad_threshold - 2;
          v_fail := 2; v_personal_rest := 1; v_official_rest := 2;
        WHEN 2 THEN
          v_growth_status := 'graduating'; v_success := v_grad_threshold - 1;
          v_fail := 2; v_personal_rest := 1; v_official_rest := 3;
        WHEN 3 THEN
          v_growth_status := 'graduated'; v_profile_status := 'graduated';
          v_ended_at := (CURRENT_DATE - 14)::date;
          v_success := v_grad_threshold; v_fail := 3; v_personal_rest := 0; v_official_rest := 3;
        WHEN 4 THEN
          v_growth_status := 'graduated'; v_profile_status := 'graduated';
          v_ended_at := (CURRENT_DATE - 7)::date;
          v_success := v_grad_threshold + 1; v_fail := 2; v_personal_rest := 1; v_official_rest := 3;
      END CASE;
      v_total_stars   := v_success * 3;
      v_total_raw_adv := v_success * 2 + 3;
      v_total_light   := v_fail;
    END IF;

    v_total_weeks := v_success + v_fail + v_personal_rest + v_official_rest;
    v_total_shields := v_total_raw_adv - ABS(v_total_light);
    IF v_total_shields < 0 THEN v_total_shields := 0; v_total_raw_adv := ABS(v_total_light); END IF;

    IF v_ended_at IS NOT NULL THEN
      v_started_at := (v_ended_at::date - (v_total_weeks * 7))::date;
    ELSE
      v_started_at := (CURRENT_DATE - (v_total_weeks * 7))::date;
    END IF;
    v_started_at := v_started_at - ((EXTRACT(ISODOW FROM v_started_at::date)::int - 1) || ' days')::interval;

    UPDATE public.user_profiles
    SET growth_status = v_growth_status, status = v_profile_status,
        activity_started_at = v_started_at, activity_ended_at = v_ended_at, updated_at = now()
    WHERE user_id = rec.user_uuid;

    v_week_cursor := v_started_at::date;
    v_s_placed := 0; v_f_placed := 0; v_p_placed := 0; v_d_placed := 0; v_week_count := 0;

    WHILE v_week_count < v_total_weeks LOOP
      v_iso_year := EXTRACT(ISOYEAR FROM v_week_cursor)::int;
      v_iso_week := EXTRACT(WEEK FROM v_week_cursor)::int;

      IF (v_iso_year = 2025 AND v_iso_week IN (1,5,31,32,40,41,52))
         OR (v_iso_year = 2026 AND v_iso_week IN (1,5,22)) THEN
        IF v_d_placed < v_official_rest THEN v_status := 'official_rest'; v_d_placed := v_d_placed + 1;
        ELSIF v_s_placed < v_success THEN v_status := 'success'; v_s_placed := v_s_placed + 1;
        ELSE v_status := 'fail'; v_f_placed := v_f_placed + 1; END IF;
      ELSE
        IF v_s_placed < v_success THEN v_status := 'success'; v_s_placed := v_s_placed + 1;
        ELSIF v_p_placed < v_personal_rest THEN v_status := 'personal_rest'; v_p_placed := v_p_placed + 1;
        ELSIF v_f_placed < v_fail THEN v_status := 'fail'; v_f_placed := v_f_placed + 1;
        ELSIF v_d_placed < v_official_rest THEN v_status := 'official_rest'; v_d_placed := v_d_placed + 1;
        ELSE v_status := 'success'; v_s_placed := v_s_placed + 1; END IF;
      END IF;

      INSERT INTO public.user_week_statuses (user_id, year, week_number, week_start_date, status)
      VALUES (rec.user_uuid, v_iso_year::smallint, v_iso_week::smallint, v_week_cursor, v_status)
      ON CONFLICT (user_id, year, week_number) DO NOTHING;

      v_week_cursor := v_week_cursor + 7;
      v_week_count  := v_week_count + 1;
    END LOOP;

    INSERT INTO public.user_growth_stats (user_id, approved_weeks, cumulative_weeks)
    VALUES (rec.user_uuid, v_success, v_total_weeks)
    ON CONFLICT (user_id) DO UPDATE SET approved_weeks = EXCLUDED.approved_weeks, cumulative_weeks = EXCLUDED.cumulative_weeks;

    INSERT INTO public.user_cumulative_points (user_id, total_stars, total_shields, total_lightnings, total_raw_advantages)
    VALUES (rec.user_uuid, v_total_stars, v_total_shields, v_total_light, v_total_raw_adv)
    ON CONFLICT (user_id) DO UPDATE SET total_stars = EXCLUDED.total_stars, total_shields = EXCLUDED.total_shields,
      total_lightnings = EXCLUDED.total_lightnings, total_raw_advantages = EXCLUDED.total_raw_advantages;
  END LOOP;
END $$;


-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 7: user_weekly_points
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO public.user_weekly_points (user_id, year, week_number, week_start_date, points, advantages, penalty)
SELECT
  uws.user_id, uws.year, uws.week_number, uws.week_start_date,
  CASE uws.status WHEN 'success' THEN 2 + (rn % 3) WHEN 'fail' THEN (rn % 2) ELSE 0 END,
  CASE uws.status WHEN 'success' THEN (rn % 3) ELSE 0 END,
  CASE uws.status WHEN 'fail' THEN 1 + (rn % 2) ELSE 0 END
FROM (
  SELECT user_id, year, week_number, week_start_date, status,
    ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY year, week_number) AS rn
  FROM public.user_week_statuses
  WHERE user_id IN (SELECT user_uuid FROM _seed90)
) uws
ON CONFLICT (user_id, year, week_number) DO NOTHING;


-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 8: user_season_statuses
-- FK: season_key → season_definitions(season_key)
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO public.user_season_statuses (user_id, season_key, status)
SELECT
  up.user_id, sd.season_key,
  CASE
    WHEN up.growth_status = 'seasonal_rest'
     AND sd.season_key = (
       SELECT sd2.season_key FROM public.season_definitions sd2
       WHERE sd2.start_date <= COALESCE(up.activity_ended_at::date, CURRENT_DATE)
         AND sd2.end_date >= up.activity_started_at::date
       ORDER BY sd2.start_date DESC LIMIT 1
     ) THEN 'rest'
    ELSE 'success'
  END
FROM public.user_profiles up
CROSS JOIN public.season_definitions sd
WHERE up.user_id IN (SELECT user_uuid FROM _seed90)
  AND up.activity_started_at IS NOT NULL
  AND sd.start_date <= COALESCE(up.activity_ended_at::date, CURRENT_DATE)
  AND sd.end_date >= up.activity_started_at::date
ON CONFLICT (user_id, season_key) DO NOTHING;


-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 9: user_club_rank_frozen (graduated 6명)
-- ═══════════════════════════════════════════════════════════════════════

WITH weekly_scores AS (
  SELECT uwp.user_id, uwp.year, uwp.week_number,
    (uwp.points * 1) + (uwp.advantages * 3) - (uwp.penalty * 5) AS weekly_score,
    ROW_NUMBER() OVER (PARTITION BY uwp.user_id ORDER BY uwp.year, uwp.week_number) AS user_week_seq
  FROM public.user_weekly_points uwp
),
week_participants AS (
  SELECT year, week_number, COUNT(DISTINCT user_id) AS total FROM weekly_scores GROUP BY year, week_number
),
weekly_ranked AS (
  SELECT ws.user_id, ws.user_week_seq,
    RANK() OVER (PARTITION BY ws.year, ws.week_number ORDER BY ws.weekly_score DESC) AS weekly_rank, wp.total
  FROM weekly_scores ws JOIN week_participants wp ON wp.year = ws.year AND wp.week_number = ws.week_number
),
weekly_percentiles AS (
  SELECT user_id, user_week_seq,
    CASE WHEN total <= 1 THEN 1 ELSE CEIL(((weekly_rank - 1)::numeric / (total - 1)) * 99)::integer + 1 END AS weekly_percentile
  FROM weekly_ranked
),
avg_pct AS (
  SELECT user_id, CEIL(AVG(weekly_percentile) * 100) / 100.0 AS avg_percentile
  FROM weekly_percentiles WHERE user_week_seq > 1 GROUP BY user_id HAVING COUNT(*) > 0
),
frozen_candidates AS (
  SELECT ap.user_id, ap.avg_percentile,
    CASE
      WHEN ap.avg_percentile <= 10 THEN '정승' WHEN ap.avg_percentile <= 20 THEN '정1품'
      WHEN ap.avg_percentile <= 30 THEN '정2품' WHEN ap.avg_percentile <= 40 THEN '정3품'
      WHEN ap.avg_percentile <= 50 THEN '정4품' WHEN ap.avg_percentile <= 60 THEN '정5품'
      WHEN ap.avg_percentile <= 70 THEN '정6품' WHEN ap.avg_percentile <= 80 THEN '정7품'
      WHEN ap.avg_percentile <= 90 THEN '정8품' ELSE '정9품'
    END AS rank_grade
  FROM avg_pct ap
  JOIN public.user_profiles up ON up.user_id = ap.user_id
  WHERE up.growth_status = 'graduated' AND up.user_id IN (SELECT user_uuid FROM _seed90)
)
INSERT INTO public.user_club_rank_frozen (user_id, avg_percentile, rank_grade)
SELECT user_id, avg_percentile, rank_grade FROM frozen_candidates
ON CONFLICT (user_id) DO NOTHING;


-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 10: user_grade_stats sync
-- ═══════════════════════════════════════════════════════════════════════

WITH weekly_scores AS (
  SELECT uwp.user_id, uwp.year, uwp.week_number,
    (uwp.points * 1) + (uwp.advantages * 3) - (uwp.penalty * 5) AS weekly_score,
    ROW_NUMBER() OVER (PARTITION BY uwp.user_id ORDER BY uwp.year, uwp.week_number) AS user_week_seq
  FROM public.user_weekly_points uwp
),
week_participants AS (
  SELECT year, week_number, COUNT(DISTINCT user_id) AS total FROM weekly_scores GROUP BY year, week_number
),
weekly_ranked AS (
  SELECT ws.user_id, ws.user_week_seq,
    RANK() OVER (PARTITION BY ws.year, ws.week_number ORDER BY ws.weekly_score DESC) AS weekly_rank, wp.total
  FROM weekly_scores ws JOIN week_participants wp ON wp.year = ws.year AND wp.week_number = ws.week_number
),
weekly_percentiles AS (
  SELECT user_id, user_week_seq,
    CASE WHEN total <= 1 THEN 1 ELSE CEIL(((weekly_rank - 1)::numeric / (total - 1)) * 99)::integer + 1 END AS weekly_percentile
  FROM weekly_ranked
),
avg_pct AS (
  SELECT user_id, CEIL(AVG(weekly_percentile) * 100) / 100.0 AS avg_percentile
  FROM weekly_percentiles WHERE user_week_seq > 1 GROUP BY user_id HAVING COUNT(*) > 0
),
grade_computed AS (
  SELECT ap.user_id, ap.avg_percentile,
    CASE
      WHEN CEIL(ap.avg_percentile) <= 10 THEN 1 WHEN CEIL(ap.avg_percentile) <= 20 THEN 2
      WHEN CEIL(ap.avg_percentile) <= 30 THEN 3 WHEN CEIL(ap.avg_percentile) <= 40 THEN 4
      WHEN CEIL(ap.avg_percentile) <= 50 THEN 5 WHEN CEIL(ap.avg_percentile) <= 60 THEN 6
      WHEN CEIL(ap.avg_percentile) <= 70 THEN 7 WHEN CEIL(ap.avg_percentile) <= 80 THEN 8
      WHEN CEIL(ap.avg_percentile) <= 90 THEN 9 ELSE 10
    END AS grade,
    CASE
      WHEN CEIL(ap.avg_percentile) <= 10 THEN '정승' WHEN CEIL(ap.avg_percentile) <= 20 THEN '정 1품'
      WHEN CEIL(ap.avg_percentile) <= 30 THEN '정 2품' WHEN CEIL(ap.avg_percentile) <= 40 THEN '정 3품'
      WHEN CEIL(ap.avg_percentile) <= 50 THEN '정 4품' WHEN CEIL(ap.avg_percentile) <= 60 THEN '정 5품'
      WHEN CEIL(ap.avg_percentile) <= 70 THEN '정 6품' WHEN CEIL(ap.avg_percentile) <= 80 THEN '정 7품'
      WHEN CEIL(ap.avg_percentile) <= 90 THEN '정 8품' ELSE '정 9품'
    END AS grade_label
  FROM avg_pct ap
  WHERE ap.user_id IN (SELECT user_uuid FROM _seed90)
)
INSERT INTO public.user_grade_stats (user_id, avg_percentile, grade, grade_label)
SELECT user_id, avg_percentile, grade, grade_label FROM grade_computed
ON CONFLICT (user_id) DO UPDATE
  SET avg_percentile = EXCLUDED.avg_percentile, grade = EXCLUDED.grade,
      grade_label = EXCLUDED.grade_label, updated_at = now();


-- ═══════════════════════════════════════════════════════════════════════
-- SECTION 11: VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_profile int; v_marker int; v_encre int; v_oranke int; v_phalanx int;
  v_weeks int; v_points int; v_frozen int;
BEGIN
  SELECT COUNT(*) INTO v_profile FROM public.user_profiles
  WHERE user_id IN (SELECT id FROM public.users WHERE legacy_user_id BETWEEN 900031 AND 900120);

  SELECT COUNT(*) INTO v_marker FROM public.test_user_markers
  WHERE seed_batch_id = '2026-05-26_seed_90users_v2';

  SELECT COUNT(*) INTO v_encre FROM public.user_profiles
  WHERE user_id IN (SELECT id FROM public.users WHERE legacy_user_id BETWEEN 900031 AND 900120) AND organization_slug = 'encre';

  SELECT COUNT(*) INTO v_oranke FROM public.user_profiles
  WHERE user_id IN (SELECT id FROM public.users WHERE legacy_user_id BETWEEN 900031 AND 900120) AND organization_slug = 'oranke';

  SELECT COUNT(*) INTO v_phalanx FROM public.user_profiles
  WHERE user_id IN (SELECT id FROM public.users WHERE legacy_user_id BETWEEN 900031 AND 900120) AND organization_slug = 'phalanx';

  SELECT COUNT(*) INTO v_weeks FROM public.user_week_statuses
  WHERE user_id IN (SELECT id FROM public.users WHERE legacy_user_id BETWEEN 900031 AND 900120);

  SELECT COUNT(*) INTO v_points FROM public.user_weekly_points
  WHERE user_id IN (SELECT id FROM public.users WHERE legacy_user_id BETWEEN 900031 AND 900120);

  SELECT COUNT(*) INTO v_frozen FROM public.user_club_rank_frozen
  WHERE user_id IN (SELECT id FROM public.users WHERE legacy_user_id BETWEEN 900031 AND 900120);

  IF v_profile <> 90 THEN RAISE EXCEPTION 'user_profiles = % (expected 90)', v_profile; END IF;
  IF v_marker  <> 90 THEN RAISE EXCEPTION 'test_user_markers = % (expected 90)', v_marker; END IF;
  IF v_encre   <> 30 THEN RAISE EXCEPTION 'encre = % (expected 30)', v_encre; END IF;
  IF v_oranke  <> 30 THEN RAISE EXCEPTION 'oranke = % (expected 30)', v_oranke; END IF;
  IF v_phalanx <> 30 THEN RAISE EXCEPTION 'phalanx = % (expected 30)', v_phalanx; END IF;

  RAISE NOTICE '=== SEED VERIFICATION PASSED ===';
  RAISE NOTICE 'profiles=% markers=% encre=% oranke=% phalanx=%', v_profile, v_marker, v_encre, v_oranke, v_phalanx;
  RAISE NOTICE 'week_statuses=% weekly_points=% frozen=%', v_weeks, v_points, v_frozen;
END $$;


-- Cleanup temp table
DROP TABLE IF EXISTS _seed90;

COMMIT;


-- ═══════════════════════════════════════════════════════════════════════
-- DRY-RUN VERIFICATION SQL (INSERT 전에 단독 실행하여 충돌 확인)
-- ═══════════════════════════════════════════════════════════════════════
/*
SELECT 'legacy_id_collision' AS check,
  COUNT(*) AS conflicts
FROM public.users WHERE legacy_user_id BETWEEN 900031 AND 900120

UNION ALL

SELECT 'email_collision',
  COUNT(*)
FROM auth.users WHERE email ~ '^test\d{3}@vraxium\.test$'

UNION ALL

SELECT 'phone_collision',
  COUNT(*)
FROM public.user_profiles WHERE contact_phone LIKE '010-9901-%'

UNION ALL

SELECT 'marker_batch_collision',
  COUNT(*)
FROM public.test_user_markers WHERE seed_batch_id = '2026-05-26_seed_90users_v2'

UNION ALL

SELECT 'marker_legacy_collision',
  COUNT(*)
FROM public.test_user_markers WHERE legacy_user_id BETWEEN 900031 AND 900120

UNION ALL

SELECT 'season_definitions_exist',
  COUNT(*)
FROM public.season_definitions WHERE season_key LIKE '2025-%' OR season_key LIKE '2026-%';

-- 모든 check 에서 conflicts = 0, season_definitions_exist > 0 이면 안전.
*/


-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK SQL (필요 시 별도 실행)
-- ═══════════════════════════════════════════════════════════════════════
/*
BEGIN;

DELETE FROM public.user_grade_stats WHERE user_id IN (SELECT id FROM public.users WHERE legacy_user_id BETWEEN 900031 AND 900120);
DELETE FROM public.user_club_rank_frozen WHERE user_id IN (SELECT id FROM public.users WHERE legacy_user_id BETWEEN 900031 AND 900120);
DELETE FROM public.user_season_statuses WHERE user_id IN (SELECT id FROM public.users WHERE legacy_user_id BETWEEN 900031 AND 900120);
DELETE FROM public.user_weekly_points WHERE user_id IN (SELECT id FROM public.users WHERE legacy_user_id BETWEEN 900031 AND 900120);
DELETE FROM public.user_week_statuses WHERE user_id IN (SELECT id FROM public.users WHERE legacy_user_id BETWEEN 900031 AND 900120);
DELETE FROM public.user_cumulative_points WHERE user_id IN (SELECT id FROM public.users WHERE legacy_user_id BETWEEN 900031 AND 900120);
DELETE FROM public.user_growth_stats WHERE user_id IN (SELECT id FROM public.users WHERE legacy_user_id BETWEEN 900031 AND 900120);
DELETE FROM public.test_user_markers WHERE seed_batch_id = '2026-05-26_seed_90users_v2';
DELETE FROM public.user_profiles WHERE user_id IN (SELECT id FROM public.users WHERE legacy_user_id BETWEEN 900031 AND 900120);
DELETE FROM public.users WHERE legacy_user_id BETWEEN 900031 AND 900120;
DELETE FROM auth.users WHERE email ~ '^test\d{3}@vraxium\.test$';

COMMIT;
*/

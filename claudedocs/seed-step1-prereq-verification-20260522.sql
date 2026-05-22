-- ============================================================
-- Step 1: 30명 더미 사용자 Seed 사전 검증 SQL
-- 작성일: 2026-05-22
-- 목적: §1-A 스키마 미확정 항목 + §12 미해결 결정사항 #1, #3-6 해소
-- 모든 쿼리: SELECT only (운영 데이터 zero touch)
-- 적용 환경: Supabase SQL Editor (prod 또는 staging)
-- ============================================================
--
-- 실행 방법:
--   1. Supabase Dashboard > SQL Editor
--   2. 아래 쿼리를 섹션별로 개별 실행 (Run 버튼)
--      또는 전체 paste 후 각 쿼리 결과를 순서대로 캡처
--   3. 결과를 v2 작성용으로 채팅에 paste
--
-- 결과 paste 양식 (예시):
--   ## Q1 결과
--   organization_slug | row_count
--   encre             | 1
--   oranke            | 1
--   phalanx           | 1
--
-- ============================================================

-- ========== Q1. organization_resume_card_settings 분포 ==========
-- 목적: encre/oranke/phalanx 외 다른 slug 가 운영에 존재하는지 확인
-- 기대: 3 row (encre, oranke, phalanx) — CHECK 제약 그대로
SELECT
  'Q1' AS query_id,
  organization_slug,
  medal_theme,
  updated_at
FROM public.organization_resume_card_settings
ORDER BY organization_slug;


-- ========== Q2. organizations 테이블 구조 확인 ==========
-- 목적: organizations 테이블의 실제 컬럼 구조 확인 (CREATE TABLE migration 부재)
-- 기대: slug/name/display_name/is_active 등 — 실제 컬럼 dump
SELECT
  'Q2' AS query_id,
  *
FROM public.organizations
ORDER BY 1
LIMIT 10;


-- ========== Q3. 현재 시즌 (seasons) 존재 확인 ==========
-- 목적: seasons.is_current = true 인 시즌 row 존재 여부 + 컬럼 구조
-- 기대: 1 row (현재 시즌) — 부재 시 Cluster4 콘텐츠 skip 필요
SELECT
  'Q3' AS query_id,
  *
FROM public.seasons
ORDER BY 1
LIMIT 10;


-- ========== Q4. weeks 전체 dump (시즌 구분 없이) ==========
-- 목적: weeks 컬럼 구조 + season_id 분포 + week_index 범위
-- 변경 사유 (2026-05-22 검증):
--   - seasons.is_current 컬럼 부재 → WHERE 조건 제거
--   - weeks.week_number 컬럼 부재, 실제는 week_index (정정)
-- 기대: season_id 별 week_index 분포 — Q15 결과와 함께 "사용할 시즌" 결정
SELECT
  'Q4' AS query_id,
  w.*
FROM public.weeks w
LEFT JOIN public.seasons s ON s.id = w.season_id
ORDER BY w.season_id, w.week_index
LIMIT 50;


-- ========== Q5. activity_types canonical seed 확인 ==========
-- 목적: 마스터 데이터 적재 여부 + cluster_id 분포
-- 기대: 3 cluster_id × N rows (canonical seed 적재 시 다수)
-- 부재 시: Cluster4 user_activity_details FK 불일치 → 별도 seed 필요
SELECT
  'Q5' AS query_id,
  cluster_id,
  COUNT(*) AS type_count,
  COUNT(*) FILTER (WHERE is_active = true) AS active_count,
  array_agg(id ORDER BY id) FILTER (WHERE is_active = true) AS active_ids
FROM public.activity_types
GROUP BY cluster_id
ORDER BY cluster_id;


-- ========== Q6. reputation_keywords 100 키워드 확인 ==========
-- 목적: 5 cluster × N keywords (총 100) seed 적재 여부
-- 기대: cluster_number 1~5 각각 row 분포
-- 부재 시: weekly_reputations.keyword 자유 text 이지만 reference 없음 → 더미 키워드 직접 생성
SELECT
  'Q6' AS query_id,
  cluster_number,
  cluster_name,
  cluster_color,
  COUNT(*) AS keyword_count
FROM public.reputation_keywords
GROUP BY cluster_number, cluster_name, cluster_color
ORDER BY cluster_number;


-- ========== Q7. 조직별 실사용자 분포 (핵심 검증) ==========
-- 목적: encre/oranke 실사용자 0명 가정 확인 + phalanx 34명 확인
-- 기대: phalanx=34, encre=0, oranke=0 (사용자 보고 기준)
SELECT
  'Q7' AS query_id,
  COALESCE(organization_slug, '(null)') AS organization_slug,
  COUNT(*) AS total_user_count,
  COUNT(*) FILTER (WHERE display_name LIKE '[TEST]%') AS existing_test_count,
  COUNT(*) FILTER (WHERE display_name IS NULL OR display_name NOT LIKE '[TEST]%') AS real_user_count,
  MIN(created_at) AS earliest_created,
  MAX(created_at) AS latest_created
FROM public.user_profiles
GROUP BY organization_slug
ORDER BY total_user_count DESC NULLS LAST;


-- ========== Q8. 식별자 충돌 사전 점검 (마커 스키마 + 3종 prefix) ==========
-- 목적: test_user_markers 스키마 상태 + @vraxium.test / 010-9900-* / [TEST] 충돌 확인
-- 변경 사유 (2026-05-22):
--   PostgreSQL 파서는 WHERE EXISTS 가드와 무관하게 SELECT 컬럼 참조를 먼저 검증함
--   → Q8a 는 information_schema.columns + to_regclass 로 스키마 확인만 (실제 컬럼 SELECT 없이)
--   → 실제 row count 는 Q8a 결과 = 1 (legacy_user_id 컬럼 존재) 일 때만 Q8e 로 실행

-- Q8a: test_user_markers 스키마 상태 (3-state)
--   0  = 테이블 없음 → v3 에서 CREATE 가능
--   1  = legacy_user_id 컬럼 있음 (v3 구조)
--   -1 = 구버전 test_user_markers 잔존 (legacy_user_id 컬럼 없음)
SELECT
  'Q8a test_user_markers_schema' AS check_name,
  CASE
    WHEN to_regclass('public.test_user_markers') IS NULL THEN 0
    WHEN EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'test_user_markers'
        AND column_name = 'legacy_user_id'
    ) THEN 1
    ELSE -1
  END AS marker_schema_status,
  CASE
    WHEN to_regclass('public.test_user_markers') IS NULL THEN 'table_absent_ok'
    WHEN EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'test_user_markers'
        AND column_name = 'legacy_user_id'
    ) THEN 'table_has_legacy_user_id'
    ELSE 'old_marker_table_without_legacy_user_id'
  END AS note;

-- Q8b: @vraxium.test 도메인 충돌
SELECT 'Q8b vraxium_test_domain' AS check_name, COUNT(*) AS conflict_count
FROM public.user_profiles
WHERE lower(auth_email) LIKE '%@vraxium.test'
   OR lower(contact_email) LIKE '%@vraxium.test';

-- Q8c: 010-9900-* phone prefix 충돌
SELECT 'Q8c phone_9900_prefix' AS check_name, COUNT(*) AS conflict_count
FROM public.user_profiles
WHERE contact_phone LIKE '010-9900-%';

-- Q8d: [TEST] display_name prefix 충돌
SELECT 'Q8d display_name_test_prefix' AS check_name, COUNT(*) AS conflict_count
FROM public.user_profiles
WHERE display_name LIKE '[TEST]%';


-- ========== Q9. test_user_markers 마커 테이블 부재 확인 ==========
-- 목적: 마커 테이블 신규 CREATE 가능 여부
-- 기대: false (없음) — true 면 기존 마커 테이블 구조 확인 필요
SELECT
  'Q9' AS query_id,
  EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'test_user_markers'
  ) AS markers_table_exists,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name IN ('is_test_user', 'seed_batch_id', 'is_dummy')
  ) AS test_marker_column_exists;


-- ========== Q10. live-DB only 테이블 컬럼 구조 dump (핵심) ==========
-- 목적: §1-A 의 18개 미확정 테이블 컬럼 NOT NULL/default 확정
-- 기대: 각 테이블의 모든 컬럼 + 타입 + nullable + default + max length
-- ⚠️ 결과 row 수가 많으므로 (200+) 전부 캡처 필요
SELECT
  'Q10' AS query_id,
  c.table_name,
  c.ordinal_position,
  c.column_name,
  c.data_type,
  c.udt_name,
  c.is_nullable,
  c.column_default,
  c.character_maximum_length,
  c.numeric_precision,
  c.numeric_scale
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND c.table_name IN (
    -- 핵심 Cluster1
    'organizations',
    'user_profiles',
    'user_memberships',
    'user_cumulative_points',
    'user_growth_stats',
    'applicants',
    'admin_users',
    'legacy_crew_import',
    -- 시즌/주차 차원
    'seasons',
    'weeks',
    'user_season_histories',
    -- Cluster2 콘텐츠
    'user_cluster2',
    'user_introductions',
    'user_educations',
    'user_resume_card_settings',
    'organization_resume_card_settings',
    'site_resume_card_settings',
    'user_review_links',
    'user_edit_windows',
    -- Cluster3 포트폴리오
    'portfolio_top_cards',
    'portfolio_channel_cards',
    -- Cluster4 활동/평판
    'activity_types',
    'user_activity_details',
    'career_projects',
    'career_project_weeks',
    'career_records',
    'weekly_reviews',
    'weekly_colleagues',
    'weekly_reputations',
    'season_reputations',
    'reputation_keywords'
  )
ORDER BY c.table_name, c.ordinal_position;


-- ========== Q11. 핵심 테이블 PK / UNIQUE 제약 확인 ==========
-- 목적: PK / UNIQUE constraint 확정 (특히 live-DB only 테이블)
-- 기대: PRIMARY KEY 와 UNIQUE 제약 목록
SELECT
  'Q11' AS query_id,
  tc.table_name,
  tc.constraint_name,
  tc.constraint_type,
  string_agg(kcu.column_name, ', ' ORDER BY kcu.ordinal_position) AS columns
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON kcu.constraint_name = tc.constraint_name
 AND kcu.table_schema = tc.table_schema
WHERE tc.table_schema = 'public'
  AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
  AND tc.table_name IN (
    'user_profiles', 'user_memberships', 'user_cumulative_points', 'user_growth_stats',
    'applicants', 'admin_users', 'legacy_crew_import',
    'seasons', 'weeks', 'user_season_histories',
    'user_cluster2', 'user_introductions', 'user_educations',
    'portfolio_top_cards', 'portfolio_channel_cards',
    'career_projects', 'career_records',
    'organizations'
  )
GROUP BY tc.table_name, tc.constraint_name, tc.constraint_type
ORDER BY tc.table_name, tc.constraint_type DESC, tc.constraint_name;


-- ========== Q12. 핵심 테이블 FK 의존성 확인 ==========
-- 목적: FK target 확정 (CASCADE 동작 검증)
SELECT
  'Q12' AS query_id,
  tc.table_name AS source_table,
  string_agg(kcu.column_name, ', ' ORDER BY kcu.ordinal_position) AS source_columns,
  ccu.table_name AS target_table,
  string_agg(ccu.column_name, ', ' ORDER BY kcu.ordinal_position) AS target_columns,
  rc.delete_rule
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
JOIN information_schema.referential_constraints rc
  ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
JOIN information_schema.constraint_column_usage ccu
  ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
WHERE tc.table_schema = 'public'
  AND tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_name IN (
    'user_memberships', 'user_cumulative_points', 'user_growth_stats',
    'applicants', 'admin_users',
    'user_season_histories',
    'user_cluster2', 'user_introductions', 'user_educations',
    'portfolio_top_cards', 'portfolio_channel_cards',
    'user_activity_details', 'weekly_reviews', 'weekly_colleagues',
    'weekly_reputations', 'season_reputations',
    'career_records', 'career_project_weeks',
    'user_resume_card_settings', 'user_review_links', 'user_edit_windows'
  )
GROUP BY tc.table_name, tc.constraint_name, ccu.table_name, rc.delete_rule
ORDER BY tc.table_name, target_table;


-- ========== Q13. career_projects 마스터 row 수 확인 ==========
-- 목적: 운영 데이터 존재 여부 (있으면 career_records 더미 가능, 없으면 skip)
SELECT
  'Q13' AS query_id,
  COUNT(*) AS career_project_count,
  COUNT(*) FILTER (WHERE supervisor_company IS NOT NULL) AS with_supervisor
FROM public.career_projects;


-- ========== Q14. auth.users 컬럼 구조 확인 ==========
-- 목적: auth.users INSERT 가능 여부 + 필수 컬럼 파악 (Auth API vs SQL 결정)
SELECT
  'Q14' AS query_id,
  column_name,
  data_type,
  udt_name,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'auth' AND table_name = 'users'
ORDER BY ordinal_position;


-- ========== Q15. seasons + weeks 매핑 (확정 스키마 기준) ==========
-- 목적: Cluster4 콘텐츠 적재용 week_id 풀 확정 — 어떤 season_id 사용할지 결정 근거
-- 확정 스키마 (2026-05-22 사용자 보고):
--   seasons: id uuid, season_index integer, name text, started_at timestamptz, ended_at timestamptz nullable
--   weeks  : id uuid, season_id uuid, week_index integer, started_at timestamptz, ended_at timestamptz
-- 현재 시즌 선택 규칙: ended_at IS NULL 우선 → started_at DESC → season_index DESC
SELECT
  'Q15' AS query_id,
  s.id AS season_id,
  s.season_index,
  s.name AS season_name,
  s.started_at,
  s.ended_at,
  (s.ended_at IS NULL) AS is_open,
  COUNT(w.id) AS week_count,
  MIN(w.week_index) AS first_week_index,
  MAX(w.week_index) AS last_week_index
FROM public.seasons s
LEFT JOIN public.weeks w ON w.season_id = s.id
GROUP BY s.id, s.season_index, s.name, s.started_at, s.ended_at
ORDER BY
  CASE WHEN s.ended_at IS NULL THEN 0 ELSE 1 END,
  s.started_at DESC,
  s.season_index DESC;


-- ========== Q18. 구버전 test_user_markers row count 안전 조회 ==========
-- 목적: Q8a marker_schema_status = -1 (구버전 잔존) 인 경우 row 수 확인
--   → row=0 이면 v3 Phase 1 의 DROP/재생성 안전
--   → row>0 이면 어떤 seed batch 인지 확인 후 삭제 여부 판단 (수동 검토)
-- 안전장치: 테이블 부재 시 row count 0 반환 (SELECT 자체가 깨지지 않음)
DO $$
DECLARE
  old_row_count int;
BEGIN
  IF to_regclass('public.test_user_markers') IS NULL THEN
    RAISE NOTICE 'Q18: test_user_markers 테이블 없음 (row_count=0)';
  ELSE
    EXECUTE 'SELECT COUNT(*) FROM public.test_user_markers' INTO old_row_count;
    RAISE NOTICE 'Q18: test_user_markers row_count=%', old_row_count;
  END IF;
END $$;

-- Q18-b: 위 NOTICE 가 SQL Editor 에서 안 보일 경우 — 결과 컬럼으로 확인
SELECT
  'Q18' AS query_id,
  CASE
    WHEN to_regclass('public.test_user_markers') IS NULL THEN 0
    ELSE (SELECT COUNT(*)::int FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'test_user_markers')
  END AS marker_column_count,
  CASE
    WHEN to_regclass('public.test_user_markers') IS NULL THEN 'table_absent'
    ELSE 'table_exists — run SELECT COUNT(*) FROM public.test_user_markers manually'
  END AS instruction;

-- 위 instruction 이 'table_exists ...' 이면 아래 쿼리를 수동으로 한 번 실행:
--   SELECT COUNT(*) AS old_marker_rows FROM public.test_user_markers;
-- 결과:
--   0  → v3 Phase 1 의 자동 DROP 안전 (현재 v3 SQL 의 안전 가드가 작동)
--   >0 → 수동 검토 필요:
--     SELECT seed_batch_id, COUNT(*)
--     FROM public.test_user_markers
--     GROUP BY 1
--     ORDER BY 2 DESC;


-- ========== Q16. user_profiles 실제 컬럼 구조 (v3 작성 필수) ==========
-- 목적: user_profiles 의 정확한 컬럼 목록 확정 — v3 INSERT 컬럼 목록 확정 키
-- 추가 사유 (2026-05-22):
--   v2 에서 user_profiles.legacy_user_id INSERT 시 오류 발생
--   → 실제 컬럼 목록 확인 후 v3 INSERT 컬럼 결정
SELECT
  'Q16' AS query_id,
  column_name,
  data_type,
  udt_name,
  is_nullable,
  column_default,
  character_maximum_length
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'user_profiles'
ORDER BY ordinal_position;


-- ========== Q17. user_profiles 와 비슷한 역할의 컬럼이 다른 테이블에 있는지 확인 ==========
-- 목적: legacy_user_id 컬럼이 어느 테이블에 실제로 존재하는지 파악
-- (예상 후보: public.users, public.legacy_crew_import, public.test_user_markers)
SELECT
  'Q17' AS query_id,
  table_name,
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND column_name = 'legacy_user_id'
ORDER BY table_name;


-- ========== Q19. public.users 컬럼 구조 (v4 작성 필수) ==========
-- 목적: public.users 의 정확한 컬럼 목록 확정 — v4 INSERT 컬럼 키
-- 추가 사유 (2026-05-22):
--   user_profiles.user_id 가 auth.users 가 아닌 public.users(id) 를 FK 참조 확인
--   → public.users 에 row 먼저 만들어야 함
SELECT
  'Q19' AS query_id,
  column_name,
  data_type,
  udt_name,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'users'
ORDER BY ordinal_position;


-- ========== Q20. user_profiles FK 정확한 target 확인 ==========
-- 목적: user_profiles.user_id FK 가 정확히 어느 테이블/컬럼을 참조하는지 확정
-- 기대: target = public.users(id) — 사용자 보고 일치
SELECT
  'Q20' AS query_id,
  tc.constraint_name,
  kcu.column_name AS source_column,
  ccu.table_schema AS foreign_table_schema,
  ccu.table_name AS foreign_table_name,
  ccu.column_name AS foreign_column_name,
  rc.delete_rule,
  rc.update_rule
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
JOIN information_schema.referential_constraints rc
  ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
JOIN information_schema.constraint_column_usage ccu
  ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema = 'public'
  AND tc.table_name = 'user_profiles';


-- ========== Q21. public.users 의 FK 확인 (auth.users 관계) ==========
-- 목적: public.users 가 auth.users 와 FK 관계 있는지 확인
--   → 있으면: auth.users 먼저 생성 필요
--   → 없으면: public.users 만 생성해도 OK (단 로그인 불가)
SELECT
  'Q21' AS query_id,
  tc.constraint_name,
  kcu.column_name AS source_column,
  ccu.table_schema AS foreign_table_schema,
  ccu.table_name AS foreign_table_name,
  ccu.column_name AS foreign_column_name,
  rc.delete_rule
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
JOIN information_schema.referential_constraints rc
  ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
JOIN information_schema.constraint_column_usage ccu
  ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema = 'public'
  AND tc.table_name = 'users';


-- ========== Q22. public.users 기존 row 샘플 (legacy_user_id 분포 확인) ==========
-- 목적: 기존 row 의 id 형식 + legacy_user_id 범위 + 다른 컬럼 사용 패턴 확인
SELECT
  'Q22' AS query_id,
  *
FROM public.users
ORDER BY legacy_user_id NULLS LAST
LIMIT 5;

SELECT
  'Q22-stats' AS query_id,
  COUNT(*) AS total_users,
  COUNT(legacy_user_id) AS with_legacy_id,
  MIN(legacy_user_id) AS min_legacy_id,
  MAX(legacy_user_id) AS max_legacy_id
FROM public.users;


-- ============================================================
-- 결과 paste 가이드:
--
-- 각 쿼리 결과를 다음 형식으로 채팅에 paste 해주세요:
--
-- ## Q1 (organization_resume_card_settings)
-- ```
-- query_id | organization_slug | medal_theme | updated_at
-- Q1       | encre             | EC          | 2026-05-07 ...
-- Q1       | oranke            | OK          | 2026-05-07 ...
-- Q1       | phalanx           | PX          | 2026-05-07 ...
-- ```
--
-- ## Q2 (organizations)
-- ```
-- (컬럼 목록 + row dump)
-- ```
--
-- ... (Q15 까지)
--
-- Q10 은 row 수가 많을 수 있으니 csv 다운로드 후 첨부도 가능합니다.
-- ============================================================

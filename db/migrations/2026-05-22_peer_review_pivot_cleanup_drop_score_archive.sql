-- 2026-05-22_peer_review_pivot_cleanup_drop_score_archive.sql
--
-- 목적: peer-review pivot 이전 archive 테이블 2개 제거.
--   - public.weekly_reputation_scores
--   - public.season_reputation_scores
--
-- 배경:
--   2026-05-21 의 peer-review pivot step1 (rename) 에서 옛 score-grid 테이블
--   `weekly_reputations` / `season_reputations` 를 각각 `*_scores` 로 rename 하여
--   보존했다. 같은 날 step2 가 동일 이름(`weekly_reputations` / `season_reputations`)
--   으로 새 peer-review canonical 테이블을 생성했다.
--   본 migration 은 보존했던 *_scores archive 두 개를 정리한다.
--
-- 점검 근거 (2026-05-22, admin repo `oksnumlerbaybxlmgdux` 환경 기준):
--   - weekly_reputation_scores  row 수: 0   (service_role REST count=exact)
--   - season_reputation_scores  row 수: 0
--   - admin repo (lib/, app/, components/) 의 production 코드 참조: 0건
--     · 잔존 문자열은 본 migration 의 step1, audit 문서, audit 스크립트뿐
--   - claudedocs/table-role-audit-20260522.md 가 둘 다 "deprecated 후보" 로 분류
--
-- ⚠ peer-review pivot 이전 archive 테이블, row 0, code ref 0  ⚠
--
-- 적용 절차:
--   STEP A. 아래 PRE-FLIGHT PROBE 6개 쿼리를 prod / staging 모든 환경에서 실행.
--           단 하나라도 row 가 반환되면 본 migration 을 적용하지 말 것.
--   STEP B. ROLLBACK DDL CAPTURE 쿼리를 실행하여 출력을 본 파일의
--           "-- !! ROLLBACK SNAPSHOT (paste before apply) !!" 블록에 붙여 넣어
--           PR 에 함께 커밋. (rollback 시 archive 재생성용)
--   STEP C. 본 파일의 BEGIN ... COMMIT 블록을 SQL Editor 에 붙여 실행.
--   STEP D. POST-DROP VERIFICATION 쿼리로 두 테이블이 사라졌는지 확인.
--
-- 안전 가드:
--   - DROP 은 CASCADE 사용하지 않음. 예기치 못한 의존성이 있으면 noisy 실패.
--   - DROP TABLE IF EXISTS 라 재실행 안전.
--   - row 0 이라 데이터 손실 없음.


-- ============================================================
-- STEP A. PRE-FLIGHT PROBE (read-only, must all return 0 rows)
-- ============================================================
-- prod / staging 각 환경에서 한 번씩 실행. 한 줄이라도 row 반환되면 STOP.

/*

-- (A1) FK refs INTO archive tables
SELECT n.nspname AS schema,
       c.relname AS referencing_table,
       con.conname AS fk_name
FROM   pg_constraint con
JOIN   pg_class c       ON c.oid = con.conrelid
JOIN   pg_namespace n   ON n.oid = c.relnamespace
JOIN   pg_class c_ref   ON c_ref.oid = con.confrelid
WHERE  con.contype = 'f'
  AND  c_ref.relname IN ('weekly_reputation_scores','season_reputation_scores')
  AND  c_ref.relnamespace = 'public'::regnamespace;

-- (A2) views (regular + materialized) referencing either name
SELECT n.nspname AS schema, v.relname AS view_name, v.relkind
FROM   pg_rewrite r
JOIN   pg_class v       ON v.oid = r.ev_class
JOIN   pg_namespace n   ON n.oid = v.relnamespace
JOIN   pg_depend d      ON d.objid = r.oid
JOIN   pg_class dep     ON dep.oid = d.refobjid
WHERE  v.relkind IN ('v','m')
  AND  dep.relname IN ('weekly_reputation_scores','season_reputation_scores')
  AND  dep.relnamespace = 'public'::regnamespace
GROUP  BY n.nspname, v.relname, v.relkind;

-- (A3) functions / procedures whose definition mentions either name
SELECT n.nspname AS schema, p.proname AS routine_name
FROM   pg_proc p
JOIN   pg_namespace n ON n.oid = p.pronamespace
WHERE  n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
  AND  (
         pg_get_functiondef(p.oid) ILIKE '%weekly_reputation_scores%'
      OR pg_get_functiondef(p.oid) ILIKE '%season_reputation_scores%'
       );

-- (A4) triggers on either table (excluding system triggers)
SELECT c.relname AS table_name, t.tgname AS trigger_name
FROM   pg_trigger t
JOIN   pg_class c ON c.oid = t.tgrelid
WHERE  NOT t.tgisinternal
  AND  c.relname IN ('weekly_reputation_scores','season_reputation_scores')
  AND  c.relnamespace = 'public'::regnamespace;

-- (A5) RLS policies attached to either
SELECT schemaname, tablename, policyname
FROM   pg_policies
WHERE  tablename IN ('weekly_reputation_scores','season_reputation_scores')
  AND  schemaname = 'public';

-- (A6) row count re-confirmation
SELECT 'weekly_reputation_scores' AS t, count(*) AS rows FROM public.weekly_reputation_scores
UNION ALL
SELECT 'season_reputation_scores',         count(*)      FROM public.season_reputation_scores;

*/


-- ============================================================
-- STEP B. ROLLBACK DDL CAPTURE (run once, paste output below)
-- ============================================================
-- 이 SQL 의 출력을 아래 ROLLBACK SNAPSHOT 블록에 PR 적용 전 붙여넣고 commit 한다.
-- (PostgREST 가 pg_attribute 를 노출하지 않으므로 자동 캡처 불가 — 사용자 수동 단계)

/*

-- (B1) reconstruct CREATE TABLE for both archive tables
SELECT format(
         E'CREATE TABLE public.%I (\n%s\n);',
         c.relname,
         string_agg(
           format('  %I %s%s%s',
             a.attname,
             format_type(a.atttypid, a.atttypmod),
             CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END,
             CASE WHEN ad.adbin IS NOT NULL
                  THEN ' DEFAULT ' || pg_get_expr(ad.adbin, ad.adrelid)
                  ELSE '' END
           ),
           E',\n'
           ORDER BY a.attnum
         )
       ) AS create_table_ddl
FROM   pg_class      c
JOIN   pg_attribute  a  ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
LEFT   JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
WHERE  c.relname IN ('weekly_reputation_scores','season_reputation_scores')
  AND  c.relnamespace = 'public'::regnamespace
GROUP  BY c.relname;

-- (B2) reconstruct constraints (PK, UNIQUE, CHECK, FK) for both
SELECT c.relname AS table_name,
       con.conname,
       pg_get_constraintdef(con.oid) AS definition
FROM   pg_constraint con
JOIN   pg_class c     ON c.oid = con.conrelid
WHERE  c.relname IN ('weekly_reputation_scores','season_reputation_scores')
  AND  c.relnamespace = 'public'::regnamespace;

-- (B3) reconstruct indexes (non-constraint indexes only)
SELECT tablename, indexname, indexdef
FROM   pg_indexes
WHERE  tablename IN ('weekly_reputation_scores','season_reputation_scores')
  AND  schemaname = 'public';

-- (B4) outbound FKs FROM these tables (e.g. .keyword_key -> reputation_score_keys)
SELECT c.relname AS table_name,
       con.conname,
       pg_get_constraintdef(con.oid) AS definition
FROM   pg_constraint con
JOIN   pg_class c ON c.oid = con.conrelid
WHERE  c.relname IN ('weekly_reputation_scores','season_reputation_scores')
  AND  c.relnamespace = 'public'::regnamespace
  AND  con.contype = 'f';

*/


-- ============================================================
-- !! ROLLBACK SNAPSHOT (paste before apply) !!
-- ============================================================
-- PR 적용 전 STEP B 의 출력을 아래에 붙여넣고 다시 commit 한다.
-- 비어 있으면 reviewer 는 PR 을 반려할 것.
--
-- ----- BEGIN PASTE -----
--
-- (B1) CREATE TABLE statements:
--   <PASTE HERE>
--
-- (B2) constraints (PK / UNIQUE / CHECK / FK):
--   <PASTE HERE>
--
-- (B3) indexes:
--   <PASTE HERE>
--
-- (B4) outbound FKs:
--   <PASTE HERE>
--
-- ----- END PASTE -----
--
-- (참고) step1 (2026-05-21_peer_review_pivot_step1_rename_score_grid.sql) 주석에
-- 명시된 알려진 의존성:
--   - weekly_reputation_scores.keyword_key → reputation_score_keys.keyword_key  (FK)
--   - rename 후 컬럼/CHECK/UNIQUE/INDEX/TRIGGER 식별자 이름은 옛 이름
--     ('weekly_reputations_*', 'season_reputations_*') 그대로 잔존
--   - 옛 score 컬럼 shape: numeric (scale 모름 — survey doc D-6 참조)


-- ============================================================
-- STEP C. DROP (idempotent, non-cascading)
-- ============================================================
-- CASCADE 미사용. 만약 STEP A 가 놓친 의존성이 있다면 PostgreSQL 가 noisy 실패시킴.
-- 그 경우 rollback 후 STEP A 를 다시 정밀 점검.

BEGIN;

DROP TABLE IF EXISTS public.weekly_reputation_scores;
DROP TABLE IF EXISTS public.season_reputation_scores;

COMMIT;


-- ============================================================
-- STEP D. POST-DROP VERIFICATION
-- ============================================================
-- 두 테이블이 더 이상 존재하지 않음을 확인. 결과는 0 rows 여야 한다.

/*

SELECT n.nspname AS schema, c.relname AS still_exists
FROM   pg_class c
JOIN   pg_namespace n ON n.oid = c.relnamespace
WHERE  c.relname IN ('weekly_reputation_scores','season_reputation_scores')
  AND  n.nspname = 'public';

*/


-- ============================================================
-- ROLLBACK (필요 시)
-- ============================================================
-- STEP B 에서 캡처해 위 ROLLBACK SNAPSHOT 블록에 붙여넣은 DDL 을 그대로 실행한다.
-- snapshot 이 비어 있으면 rollback 불가능 — 그 상태로 본 migration 을 apply 하지 말 것.


-- ============================================================
-- 비범위 (별도 PR)
-- ============================================================
--  1. reputation_score_keys 정리 — outbound FK 가 본 두 테이블에만 있다면 함께
--     deprecate 가능하나, taxonomy seed 가 다른 곳에서 참조될 수 있어 별도 점검 필요.
--  2. step2 의 신규 canonical 테이블에서 옛 식별자 잔존 이름 (rename 부산물) cleanup.
--  3. admin lib 의 옛 score-grid shape 가정 (survey doc D-6) — 본 migration 과
--     무관, 별도 PR.

-- 2026-05-30_experience_masters_category_slot.sql
-- cluster4_experience_line_masters 에 5슬롯 분류(experience_category, experience_slot_order) 추가 + 25행 백필.
--
-- 카테고리 ↔ 슬롯 (1:1):
--   도출=derivation/1, 분석=analysis/2, 평가=evaluation/3, 확장=extension/4, 관리=management/5
--
-- 백필 키: line_code (안정 키). line_name 은 참고 주석.
--   ※ 일부 라인은 라이브 line_name 이 요청 스펙과 다르나(예: '[분석] …퍼포먼스 결과' vs '…적용'),
--     의미 매핑 기준으로 line_code 에 직접 매핑한다 (2026-05-30 확정).
--
-- [3클럽 공통] EXBS-EL0001~0004 는 encre/oranke/phalanx 각각 별도 row 로 존재 →
--   org 미지정 WHERE line_code IN (...) 로 3조직 동시 적용.
--
-- 의존: 2026-05-28_experience_line_masters_org_slug.sql (organization_slug 컬럼)
--       2026-05-28_cluster4_line_masters_xlsx_seed.sql  (25행 seed)
-- 재실행 안전: ADD COLUMN IF NOT EXISTS, guarded CHECK, UPDATE 멱등.
-- 기존 컬럼/제약 변경·삭제 없음 (append-only).

BEGIN;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 1: 컬럼 추가 + 도메인 제약 + 인덱스
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.cluster4_experience_line_masters
  ADD COLUMN IF NOT EXISTS experience_category   text     NULL,
  ADD COLUMN IF NOT EXISTS experience_slot_order smallint NULL;

-- 카테고리 값 도메인 (NULL = 미분류 허용)
DO $$ BEGIN
  ALTER TABLE public.cluster4_experience_line_masters
    ADD CONSTRAINT cluster4_exp_masters_category_chk
    CHECK (experience_category IS NULL OR experience_category IN
      ('derivation','analysis','evaluation','extension','management'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 슬롯 범위 1~5 (NULL 허용)
DO $$ BEGIN
  ALTER TABLE public.cluster4_experience_line_masters
    ADD CONSTRAINT cluster4_exp_masters_slot_chk
    CHECK (experience_slot_order IS NULL OR experience_slot_order BETWEEN 1 AND 5);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- category ↔ slot 1:1 정합성 강제
DO $$ BEGIN
  ALTER TABLE public.cluster4_experience_line_masters
    ADD CONSTRAINT cluster4_exp_masters_cat_slot_pair_chk
    CHECK (
      experience_category IS NULL OR (experience_category, experience_slot_order) IN
      (('derivation',1),('analysis',2),('evaluation',3),('extension',4),('management',5))
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS cluster4_exp_masters_org_slot_idx
  ON public.cluster4_experience_line_masters (organization_slug, experience_slot_order);

COMMENT ON COLUMN public.cluster4_experience_line_masters.experience_category
  IS '5슬롯 분류: derivation(도출)/analysis(분석)/evaluation(평가)/extension(확장)/management(관리).';
COMMENT ON COLUMN public.cluster4_experience_line_masters.experience_slot_order
  IS '고정 슬롯 순서 1~5. category 와 1:1 (도출1·분석2·평가3·확장4·관리5).';


-- ═══════════════════════════════════════════════════════════════════════
-- PART 2: 백필 (line_code 기준, 25행)
-- ═══════════════════════════════════════════════════════════════════════

-- ── [3클럽 공통] EXBS-EL* : org 무관, 3조직 동시 적용 ──
-- management / 5
UPDATE public.cluster4_experience_line_masters
   SET experience_category='management', experience_slot_order=5, updated_at=now()
 WHERE line_code IN ('EXBS-EL0001',  -- [매니징] 세부 팀/조직 관리_파트장
                     'EXBS-EL0002'); -- [매니징] 세부 팀/조직 관리_에이전트
-- extension / 4
UPDATE public.cluster4_experience_line_masters
   SET experience_category='extension', experience_slot_order=4, updated_at=now()
 WHERE line_code IN ('EXBS-EL0003',  -- [실무 PT] 온라인 : 현황 취합과 제안 발표
                     'EXBS-EL0004'); -- [실무 PT] 오프라인 : 경쟁력 어필과 계약 입찰

-- ── 조직별 (organization_slug + line_code) ──
WITH mapping(organization_slug, line_code, cat, slot) AS (VALUES
  -- encre
  ('encre','EXEC-EN0001','derivation',1),  -- [기획] 엔터테인먼트/미디어 콘텐츠 제작
  ('encre','EXEC-EN0002','analysis',  2),  -- DB:[분석] …퍼포먼스 결과 (요청:"…적용")
  ('encre','EXEC-EN0003','evaluation',3),  -- DB:[다면 피드백] 실무 생산성 강화 (요청:"[피드백] 엔터테인먼트 …")
  -- oranke
  ('oranke','EXOK-EN0001','evaluation',3), -- [커리어] 마케터 Launch
  ('oranke','EXOK-EN0002','derivation',1), -- DB:[콘텐츠] 마케팅 실무_기획/제작 (요청:"[콘텐츠] 마케팅 실무")
  ('oranke','EXOK-EN0003','analysis',  2), -- DB:[퍼포먼스] 마케팅 실무_확산/분석 (요청:"[퍼포먼스] 마케팅 실무")
  ('oranke','EXOK-EN0004','evaluation',3), -- DB:[생산성] 상호 피드백 (요청:"[생산성] 상호 다면 피드백")
  -- phalanx
  ('phalanx','EXPX-EN0001','derivation',1),-- [실무 기획] 니즈의 파악 (1/4)
  ('phalanx','EXPX-EN0002','derivation',1),-- [실무 기획] 내용의 구조화 (2/4)
  ('phalanx','EXPX-EN0003','derivation',1),-- [실무 기획] 디테일의 확충 (3/4)
  ('phalanx','EXPX-EN0004','derivation',1),-- [실무 기획] 제안의 타진 (4/4)
  ('phalanx','EXPX-EN0005','analysis',  2),-- [실무 기획] 레퍼런스 분석
  ('phalanx','EXPX-EN0006','evaluation',3) -- [실무 기획] 사례 강화
)
UPDATE public.cluster4_experience_line_masters m
   SET experience_category   = mp.cat,
       experience_slot_order = mp.slot,
       updated_at            = now()
  FROM mapping mp
 WHERE m.organization_slug = mp.organization_slug
   AND m.line_code         = mp.line_code;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 3: NULL 잔존 검증 (NOTICE — 적용 직후 콘솔 확인)
-- ═══════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  null_cnt int;
  total_cnt int;
BEGIN
  SELECT COUNT(*) INTO null_cnt
    FROM public.cluster4_experience_line_masters
   WHERE is_active = true AND experience_category IS NULL;
  SELECT COUNT(*) INTO total_cnt
    FROM public.cluster4_experience_line_masters
   WHERE is_active = true;
  RAISE NOTICE '[exp category/slot backfill] active=% , category NULL=% (기대 0)', total_cnt, null_cnt;
  IF null_cnt > 0 THEN
    RAISE WARNING '미분류 experience master % 건 — 추가 매핑 필요', null_cnt;
  END IF;
END $$;


COMMIT;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES — 적용 후 직접 실행
-- ═══════════════════════════════════════════════════════════════════════
/*
-- 1) NULL 잔존 0 확인
SELECT organization_slug, line_code, line_name
  FROM public.cluster4_experience_line_masters
 WHERE is_active = true AND experience_category IS NULL;   -- 기대: 0 rows

-- 2) 슬롯 분포
SELECT experience_slot_order, experience_category, COUNT(*)
  FROM public.cluster4_experience_line_masters
 GROUP BY 1,2 ORDER BY 1;

-- 3) 조직별 매핑 전수
SELECT organization_slug, experience_slot_order, experience_category, line_code, line_name
  FROM public.cluster4_experience_line_masters
 ORDER BY organization_slug, experience_slot_order, line_code;

-- 4) 3클럽 공통 EXBS-EL* 가 3조직 모두 동일 분류인지
SELECT line_code, experience_category, experience_slot_order, COUNT(*) AS org_count
  FROM public.cluster4_experience_line_masters
 WHERE line_code LIKE 'EXBS-EL%'
 GROUP BY 1,2,3 ORDER BY 1;   -- 기대: 각 line_code org_count=3
*/


-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK (필요 시) — append 컬럼/제약/인덱스만 제거 (기존 데이터 보존)
-- ═══════════════════════════════════════════════════════════════════════
/*
BEGIN;
DROP INDEX IF EXISTS public.cluster4_exp_masters_org_slot_idx;
ALTER TABLE public.cluster4_experience_line_masters
  DROP CONSTRAINT IF EXISTS cluster4_exp_masters_cat_slot_pair_chk,
  DROP CONSTRAINT IF EXISTS cluster4_exp_masters_slot_chk,
  DROP CONSTRAINT IF EXISTS cluster4_exp_masters_category_chk,
  DROP COLUMN IF EXISTS experience_slot_order,
  DROP COLUMN IF EXISTS experience_category;
COMMIT;
*/

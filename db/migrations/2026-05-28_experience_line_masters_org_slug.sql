-- 2026-05-28_experience_line_masters_org_slug.sql
-- cluster4_experience_line_masters 를 조직별 마스터로 재구성 + oranke seed.
--
-- 변경:
--   1) organization_slug text NOT NULL DEFAULT 'oranke' 추가
--   2) 기존 UNIQUE(line_code) → UNIQUE(organization_slug, line_code) 교체
--   3) oranke 조직 라인 마스터 6개 seed
--
-- 의존: 2026-05-27_cluster4_experience_phase1.sql
-- 재실행 안전: ADD COLUMN IF NOT EXISTS, ON CONFLICT DO NOTHING, guarded constraint.

BEGIN;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 1: organization_slug 컬럼 추가
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.cluster4_experience_line_masters
  ADD COLUMN IF NOT EXISTS organization_slug text;

UPDATE public.cluster4_experience_line_masters
  SET organization_slug = 'oranke'
  WHERE organization_slug IS NULL;

DO $$
BEGIN
  ALTER TABLE public.cluster4_experience_line_masters
    ALTER COLUMN organization_slug SET NOT NULL;
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;

ALTER TABLE public.cluster4_experience_line_masters
  ALTER COLUMN organization_slug SET DEFAULT 'oranke';

COMMENT ON COLUMN public.cluster4_experience_line_masters.organization_slug
  IS '소속 조직 (encre / oranke / phalanx). 라인 코드는 조직 내에서만 unique.';


-- ═══════════════════════════════════════════════════════════════════════
-- PART 2: UNIQUE 제약 교체 — line_code → (organization_slug, line_code)
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.cluster4_experience_line_masters
  DROP CONSTRAINT IF EXISTS cluster4_experience_line_masters_line_code_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cluster4_experience_line_masters_org_line_code_unique'
      AND conrelid = 'public.cluster4_experience_line_masters'::regclass
  ) THEN
    ALTER TABLE public.cluster4_experience_line_masters
      ADD CONSTRAINT cluster4_experience_line_masters_org_line_code_unique
      UNIQUE (organization_slug, line_code);
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;

CREATE INDEX IF NOT EXISTS cluster4_experience_line_masters_org_slug_idx
  ON public.cluster4_experience_line_masters (organization_slug);


-- ═══════════════════════════════════════════════════════════════════════
-- PART 3: oranke 라인 마스터 6개 seed
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO public.cluster4_experience_line_masters
  (organization_slug, line_code, line_name, default_main_title, is_active)
VALUES
  (
    'oranke',
    'EX02A - ES0001',
    '[커리어] 마케터 Launch',
    '[역량 파악 & 성장점 분석] 백날 말로만 떠드는 마케팅 커리어가 아니라, 지금 당장 어느 정도로 준비되었는지 그 현실을 뼈저리게 느껴보자구!',
    true
  ),
  (
    'oranke',
    'EX99A - ER0003',
    '[콘텐츠] 마케팅 실무',
    '[콘텐츠 마케팅] 어떤 제품/서비스더라도, 마케터가 제대로 ''표현'' 하지 못한다면, 그저 ''낙서'' 에 불과해. 어떻게 내 제품/서비스를 표현할 수 있을까?',
    true
  ),
  (
    'oranke',
    'EX99A - ER0004',
    '[퍼포먼스] 마케팅 실무',
    '[퍼포먼스 마케팅] 마케팅 효과가 좋더라도, 결과를 제대로 ''인지'' 하지 못한다면, 운 좋은 ''우연'' 에 지나지 않아. 이 마케팅.. 계속 나아갈 수 있어?',
    true
  ),
  (
    'oranke',
    'EX99A - ER0002',
    '[생산성] 상호 다면 피드백',
    '[상호 피드백] 100명의 사람이 있으면, 100개의 시각과 관점이 있다고 하지. 과연 내 마케팅은, 내가 의도한대로 전달되고 있는 것이 맞을까?',
    true
  ),
  (
    'oranke',
    'EX99L - ER0005',
    '[매니징] 세부 팀/조직 관리_파트장',
    '[매니징 실무] 다수의 팀원을 리딩하는 ''파트'' 의 장(將)은 무엇을 고려하며, 정기적인 일정과 개별적인 적용은 어떻게 조화시키는가?',
    true
  ),
  (
    'oranke',
    'EX99L - ER0006',
    '[매니징] 세부 팀/조직 관리_에이전트',
    '[매니징 실무] 다수의 팀원들이 따라올 수 있는 가이드라인과 자료 체계는 어떻게 구성하며, 이는 팀 전체의 퍼포먼스에 어떤 영향을 미치는가?',
    true
  )
ON CONFLICT (organization_slug, line_code) DO NOTHING;


COMMIT;


-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK (필요 시)
-- ═══════════════════════════════════════════════════════════════════════
/*
BEGIN;

DELETE FROM public.cluster4_experience_line_masters
  WHERE organization_slug = 'oranke'
    AND line_code IN (
      'EX02A - ES0001', 'EX99A - ER0003', 'EX99A - ER0004',
      'EX99A - ER0002', 'EX99L - ER0005', 'EX99L - ER0006'
    );

ALTER TABLE public.cluster4_experience_line_masters
  DROP CONSTRAINT IF EXISTS cluster4_experience_line_masters_org_line_code_unique;

DROP INDEX IF EXISTS public.cluster4_experience_line_masters_org_slug_idx;

ALTER TABLE public.cluster4_experience_line_masters
  ALTER COLUMN organization_slug DROP NOT NULL,
  ALTER COLUMN organization_slug DROP DEFAULT;

ALTER TABLE public.cluster4_experience_line_masters
  DROP COLUMN IF EXISTS organization_slug;

ALTER TABLE public.cluster4_experience_line_masters
  ADD CONSTRAINT cluster4_experience_line_masters_line_code_key UNIQUE (line_code);

COMMIT;
*/

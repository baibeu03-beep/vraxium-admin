-- 2026-05-13_user_review_links.sql
-- Cluster2 Club Review 링크 10개 슬롯 운영 저장 테이블.
-- 기존 user_cluster2.cluving_review_link 는 삭제하지 않고 week_index=30 으로 backfill 한다.

CREATE TABLE IF NOT EXISTS public.user_review_links (
  user_id uuid NOT NULL
    REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,

  week_index smallint NOT NULL,
  url text NULL,
  is_visible boolean NOT NULL DEFAULT true,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, week_index),
  CONSTRAINT user_review_links_week_index_check
    CHECK (week_index IN (3, 6, 9, 12, 15, 18, 21, 24, 27, 30))
);

CREATE INDEX IF NOT EXISTS user_review_links_user_id_idx
  ON public.user_review_links (user_id);

CREATE INDEX IF NOT EXISTS user_review_links_visible_idx
  ON public.user_review_links (user_id, is_visible);

CREATE OR REPLACE FUNCTION public.touch_user_review_links_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_review_links_set_updated_at
  ON public.user_review_links;

CREATE TRIGGER user_review_links_set_updated_at
BEFORE UPDATE ON public.user_review_links
FOR EACH ROW
EXECUTE FUNCTION public.touch_user_review_links_updated_at();

INSERT INTO public.user_review_links (user_id, week_index, url, is_visible)
SELECT uc.user_id, 30, NULLIF(BTRIM(uc.cluving_review_link), ''), true
FROM public.user_cluster2 uc
JOIN public.user_profiles up ON up.user_id = uc.user_id
WHERE NULLIF(BTRIM(uc.cluving_review_link), '') IS NOT NULL
ON CONFLICT (user_id, week_index) DO UPDATE
SET
  url = COALESCE(public.user_review_links.url, EXCLUDED.url),
  is_visible = public.user_review_links.is_visible,
  updated_at = now();

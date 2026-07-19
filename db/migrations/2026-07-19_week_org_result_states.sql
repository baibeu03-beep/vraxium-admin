CREATE TABLE IF NOT EXISTS public.cluster4_week_org_result_states (
  week_id uuid NOT NULL REFERENCES public.weeks(id) ON DELETE CASCADE,
  organization_slug text NOT NULL,
  status text NOT NULL DEFAULT 'aggregating' CHECK (status IN ('aggregating','reviewing','published')),
  review_started_at timestamptz NULL,
  published_at timestamptz NULL,
  reviewed_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (week_id, organization_slug)
);

COMMENT ON TABLE public.cluster4_week_org_result_states IS
  'Weekly-card result visibility SoT per (week, organization); weeks.result_published_at is legacy only.';

INSERT INTO public.cluster4_week_org_result_states
  (week_id, organization_slug, status, published_at, created_at, updated_at)
SELECT w.id, org.organization_slug,
       CASE WHEN EXISTS (
         SELECT 1 FROM public.user_week_statuses uws
         JOIN public.user_profiles up ON up.user_id=uws.user_id
         WHERE uws.week_start_date=w.start_date AND up.organization_slug=org.organization_slug
       ) THEN 'published' ELSE 'aggregating' END,
       CASE WHEN EXISTS (
         SELECT 1 FROM public.user_week_statuses uws
         JOIN public.user_profiles up ON up.user_id=uws.user_id
         WHERE uws.week_start_date=w.start_date AND up.organization_slug=org.organization_slug
       ) THEN w.result_published_at ELSE NULL END,
       now(), now()
FROM public.weeks w
CROSS JOIN (VALUES ('encre'),('oranke'),('phalanx')) org(organization_slug)
WHERE w.start_date >= DATE '2026-06-29'
ON CONFLICT (week_id, organization_slug) DO NOTHING;

ALTER TABLE public.cluster4_week_finalize_runs
  ADD COLUMN IF NOT EXISTS organization_slug text NULL;
CREATE INDEX IF NOT EXISTS cluster4_week_finalize_runs_week_org_idx
  ON public.cluster4_week_finalize_runs (week_id, organization_slug, created_at DESC);

-- Team/week/line_type common output asset fields.
ALTER TABLE public.cluster4_experience_team_overall_outputs
  ADD COLUMN IF NOT EXISTS output_image_url text NULL,
  ADD COLUMN IF NOT EXISTS output_image_description text NULL;

COMMENT ON TABLE public.cluster4_experience_team_overall_outputs IS
  'Common output link and image per organization/team/week/line_type (category).';

-- 2026-05-29_cluster4_info_lines_excel_import_meta.sql
-- Excel-origin practical-info line metadata.
--
-- Scope:
--   - Store imported practical-info lines directly in cluster4_lines.
--   - Do not create cluster4_line_targets from the Excel import.
--   - Preserve existing operational data; all new metadata is nullable except
--     boolean flags with backward-compatible defaults.

BEGIN;

ALTER TABLE public.cluster4_lines
  ADD COLUMN IF NOT EXISTS source_type text NULL,
  ADD COLUMN IF NOT EXISTS recognition_mode text NULL,
  ADD COLUMN IF NOT EXISTS is_readonly boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS period_label text NULL,
  ADD COLUMN IF NOT EXISTS start_date date NULL,
  ADD COLUMN IF NOT EXISTS end_date date NULL,
  ADD COLUMN IF NOT EXISTS week_id uuid NULL REFERENCES public.weeks(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_file_name text NULL,
  ADD COLUMN IF NOT EXISTS source_sheet_name text NULL,
  ADD COLUMN IF NOT EXISTS is_recurring_content boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS recurring_source_sheet_name text NULL;

ALTER TABLE public.cluster4_lines
  DROP CONSTRAINT IF EXISTS cluster4_lines_source_type_check;

ALTER TABLE public.cluster4_lines
  ADD CONSTRAINT cluster4_lines_source_type_check
    CHECK (source_type IS NULL OR source_type IN ('excel_import'));

ALTER TABLE public.cluster4_lines
  DROP CONSTRAINT IF EXISTS cluster4_lines_recognition_mode_check;

ALTER TABLE public.cluster4_lines
  ADD CONSTRAINT cluster4_lines_recognition_mode_check
    CHECK (recognition_mode IS NULL OR recognition_mode IN ('legacy_allowed'));

ALTER TABLE public.cluster4_lines
  DROP CONSTRAINT IF EXISTS cluster4_lines_import_date_range_check;

ALTER TABLE public.cluster4_lines
  ADD CONSTRAINT cluster4_lines_import_date_range_check
    CHECK (start_date IS NULL OR end_date IS NULL OR start_date <= end_date);

ALTER TABLE public.cluster4_lines
  DROP CONSTRAINT IF EXISTS cluster4_lines_recurring_content_source_check;

ALTER TABLE public.cluster4_lines
  ADD CONSTRAINT cluster4_lines_recurring_content_source_check
    CHECK (is_recurring_content = false OR recurring_source_sheet_name IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS cluster4_info_excel_import_unique_idx
  ON public.cluster4_lines (activity_type_id, week_id, main_title)
  WHERE part_type = 'info'
    AND source_type = 'excel_import'
    AND activity_type_id IS NOT NULL
    AND week_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS cluster4_lines_excel_import_week_idx
  ON public.cluster4_lines (week_id)
  WHERE part_type = 'info'
    AND source_type = 'excel_import';

CREATE INDEX IF NOT EXISTS cluster4_lines_excel_import_date_idx
  ON public.cluster4_lines (activity_type_id, start_date, end_date)
  WHERE part_type = 'info'
    AND source_type = 'excel_import';

COMMIT;

/*
ROLLBACK reference:

BEGIN;
DROP INDEX IF EXISTS public.cluster4_lines_excel_import_date_idx;
DROP INDEX IF EXISTS public.cluster4_lines_excel_import_week_idx;
DROP INDEX IF EXISTS public.cluster4_info_excel_import_unique_idx;
ALTER TABLE public.cluster4_lines DROP CONSTRAINT IF EXISTS cluster4_lines_recurring_content_source_check;
ALTER TABLE public.cluster4_lines DROP CONSTRAINT IF EXISTS cluster4_lines_import_date_range_check;
ALTER TABLE public.cluster4_lines DROP CONSTRAINT IF EXISTS cluster4_lines_recognition_mode_check;
ALTER TABLE public.cluster4_lines DROP CONSTRAINT IF EXISTS cluster4_lines_source_type_check;
ALTER TABLE public.cluster4_lines
  DROP COLUMN IF EXISTS recurring_source_sheet_name,
  DROP COLUMN IF EXISTS is_recurring_content,
  DROP COLUMN IF EXISTS source_sheet_name,
  DROP COLUMN IF EXISTS source_file_name,
  DROP COLUMN IF EXISTS week_id,
  DROP COLUMN IF EXISTS end_date,
  DROP COLUMN IF EXISTS start_date,
  DROP COLUMN IF EXISTS period_label,
  DROP COLUMN IF EXISTS is_readonly,
  DROP COLUMN IF EXISTS recognition_mode,
  DROP COLUMN IF EXISTS source_type;
COMMIT;
*/

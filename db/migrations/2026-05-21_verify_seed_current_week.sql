-- 2026-05-21_verify_seed_current_week.sql
-- Verify-only fixture that guarantees at least one public.weeks row covers CURRENT_DATE.
--
-- Goals:
--   1) Create >= 1 public.weeks row where started_at <= CURRENT_DATE <= ended_at
--   2) Reuse an existing public.seasons row when available
--   3) If public.seasons is empty, create a verify-only season fixture
--   4) Avoid damaging production rows
--   5) Keep rollback simple via verify markers / deterministic ids
--
-- Safety:
--   - No-op if a current week row already exists
--   - Reuses an existing season when possible
--   - Creates verify-only rows only when required
--   - Rollback deletes only verify-marked fixture rows

BEGIN;

DO $$
DECLARE
  v_today date := CURRENT_DATE;
  v_week_start date := date_trunc('week', CURRENT_DATE)::date;
  v_week_end date := (date_trunc('week', CURRENT_DATE)::date + interval '6 day')::date;
  v_week_index integer := EXTRACT(week FROM CURRENT_DATE)::integer;

  v_existing_current_week text;
  v_existing_season_id text;
  v_target_season_id text;

  v_season_id_type text;
  v_week_id_type text;
  v_week_season_id_type text;
  v_started_at_type text;
  v_ended_at_type text;

  v_season_has_id boolean;
  v_season_has_name boolean;
  v_season_has_year boolean;
  v_season_has_started_at boolean;
  v_season_has_ended_at boolean;
  v_season_has_created_at boolean;
  v_season_has_updated_at boolean;

  v_week_has_id boolean;
  v_week_has_week_index boolean;
  v_week_has_started_at boolean;
  v_week_has_ended_at boolean;
  v_week_has_season_id boolean;
  v_week_has_created_at boolean;
  v_week_has_updated_at boolean;

  v_season_cols text[] := ARRAY[]::text[];
  v_season_vals text[] := ARRAY[]::text[];
  v_week_cols text[] := ARRAY[]::text[];
  v_week_vals text[] := ARRAY[]::text[];
  v_sql text;

  v_verify_tag text := 'verify-fixture-2026-05-21';
  v_verify_season_name text := 'verify-season-2026-05-21';
  v_verify_text_season_id text := 'verify-season-2026-05-21';
  v_verify_text_week_id text := 'verify-week-2026-05-21';
  v_verify_uuid_season_id text := '00000000-0000-0000-0000-202605210001';
  v_verify_uuid_week_id text := '00000000-0000-0000-0000-202605210002';
BEGIN
  SELECT w.id::text
    INTO v_existing_current_week
  FROM public.weeks w
  WHERE w.started_at <= v_today
    AND w.ended_at >= v_today
  ORDER BY w.started_at DESC, w.id::text DESC
  LIMIT 1;

  IF v_existing_current_week IS NOT NULL THEN
    RAISE NOTICE 'Skipped verify seed: current week already exists (weeks.id=%).', v_existing_current_week;
    RETURN;
  END IF;

  SELECT EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'seasons' AND column_name = 'id'
         ),
         EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'seasons' AND column_name = 'name'
         ),
         EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'seasons' AND column_name = 'year'
         ),
         EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'seasons' AND column_name = 'started_at'
         ),
         EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'seasons' AND column_name = 'ended_at'
         ),
         EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'seasons' AND column_name = 'created_at'
         ),
         EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'seasons' AND column_name = 'updated_at'
         )
    INTO v_season_has_id,
         v_season_has_name,
         v_season_has_year,
         v_season_has_started_at,
         v_season_has_ended_at,
         v_season_has_created_at,
         v_season_has_updated_at;

  SELECT EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'weeks' AND column_name = 'id'
         ),
         EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'weeks' AND column_name = 'week_index'
         ),
         EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'weeks' AND column_name = 'started_at'
         ),
         EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'weeks' AND column_name = 'ended_at'
         ),
         EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'weeks' AND column_name = 'season_id'
         ),
         EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'weeks' AND column_name = 'created_at'
         ),
         EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'weeks' AND column_name = 'updated_at'
         )
    INTO v_week_has_id,
         v_week_has_week_index,
         v_week_has_started_at,
         v_week_has_ended_at,
         v_week_has_season_id,
         v_week_has_created_at,
         v_week_has_updated_at;

  IF NOT v_week_has_started_at OR NOT v_week_has_ended_at OR NOT v_week_has_season_id THEN
    RAISE EXCEPTION 'weeks schema missing one of required columns: started_at, ended_at, season_id';
  END IF;

  SELECT c.data_type
    INTO v_season_id_type
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'seasons'
    AND c.column_name = 'id';

  SELECT c.data_type
    INTO v_week_id_type
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'weeks'
    AND c.column_name = 'id';

  SELECT c.data_type
    INTO v_week_season_id_type
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'weeks'
    AND c.column_name = 'season_id';

  SELECT c.data_type
    INTO v_started_at_type
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'weeks'
    AND c.column_name = 'started_at';

  SELECT c.data_type
    INTO v_ended_at_type
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'weeks'
    AND c.column_name = 'ended_at';

  EXECUTE 'SELECT id::text FROM public.seasons ORDER BY 1 LIMIT 1'
    INTO v_existing_season_id;

  IF v_existing_season_id IS NOT NULL THEN
    v_target_season_id := v_existing_season_id;
    RAISE NOTICE 'Reusing existing season (seasons.id=%).', v_target_season_id;
  ELSE
    IF v_season_has_id THEN
      v_season_cols := array_append(v_season_cols, 'id');
      v_season_vals := array_append(
        v_season_vals,
        CASE
          WHEN v_season_id_type = 'uuid' THEN quote_literal(v_verify_uuid_season_id) || '::uuid'
          ELSE quote_literal(v_verify_text_season_id)
        END
      );
    END IF;

    IF v_season_has_name THEN
      v_season_cols := array_append(v_season_cols, 'name');
      v_season_vals := array_append(v_season_vals, quote_literal(v_verify_season_name));
    END IF;

    IF v_season_has_year THEN
      v_season_cols := array_append(v_season_cols, 'year');
      v_season_vals := array_append(v_season_vals, EXTRACT(year FROM v_today)::text);
    END IF;

    IF v_season_has_started_at THEN
      v_season_cols := array_append(v_season_cols, 'started_at');
      v_season_vals := array_append(v_season_vals, quote_literal(v_week_start));
    END IF;

    IF v_season_has_ended_at THEN
      v_season_cols := array_append(v_season_cols, 'ended_at');
      v_season_vals := array_append(v_season_vals, quote_literal(v_week_end));
    END IF;

    IF v_season_has_created_at THEN
      v_season_cols := array_append(v_season_cols, 'created_at');
      v_season_vals := array_append(v_season_vals, 'now()');
    END IF;

    IF v_season_has_updated_at THEN
      v_season_cols := array_append(v_season_cols, 'updated_at');
      v_season_vals := array_append(v_season_vals, 'now()');
    END IF;

    IF array_length(v_season_cols, 1) IS NULL THEN
      RAISE EXCEPTION 'Could not build seasons insert payload. seasons table has no usable columns.';
    END IF;

    v_sql := format(
      'INSERT INTO public.seasons (%s) VALUES (%s) RETURNING id::text',
      array_to_string(v_season_cols, ', '),
      array_to_string(v_season_vals, ', ')
    );
    EXECUTE v_sql INTO v_target_season_id;

    RAISE NOTICE 'Created verify season fixture (seasons.id=%).', v_target_season_id;
  END IF;

  IF v_week_has_id THEN
    v_week_cols := array_append(v_week_cols, 'id');
    v_week_vals := array_append(
      v_week_vals,
      CASE
        WHEN v_week_id_type = 'uuid' THEN quote_literal(v_verify_uuid_week_id) || '::uuid'
        ELSE quote_literal(v_verify_text_week_id)
      END
    );
  END IF;

  IF v_week_has_week_index THEN
    v_week_cols := array_append(v_week_cols, 'week_index');
    v_week_vals := array_append(v_week_vals, v_week_index::text);
  END IF;

  v_week_cols := array_append(v_week_cols, 'started_at');
  v_week_vals := array_append(
    v_week_vals,
    CASE
      WHEN v_started_at_type = 'date' THEN quote_literal(v_week_start)
      ELSE quote_literal(v_week_start) || '::timestamp'
    END
  );

  v_week_cols := array_append(v_week_cols, 'ended_at');
  v_week_vals := array_append(
    v_week_vals,
    CASE
      WHEN v_ended_at_type = 'date' THEN quote_literal(v_week_end)
      ELSE quote_literal(v_week_end) || '::timestamp'
    END
  );

  v_week_cols := array_append(v_week_cols, 'season_id');
  v_week_vals := array_append(
    v_week_vals,
    CASE
      WHEN v_week_season_id_type = 'uuid' THEN quote_literal(v_target_season_id) || '::uuid'
      ELSE quote_literal(v_target_season_id)
    END
  );

  IF v_week_has_created_at THEN
    v_week_cols := array_append(v_week_cols, 'created_at');
    v_week_vals := array_append(v_week_vals, 'now()');
  END IF;

  IF v_week_has_updated_at THEN
    v_week_cols := array_append(v_week_cols, 'updated_at');
    v_week_vals := array_append(v_week_vals, 'now()');
  END IF;

  v_sql := format(
    'INSERT INTO public.weeks (%s) VALUES (%s)',
    array_to_string(v_week_cols, ', '),
    array_to_string(v_week_vals, ', ')
  );
  EXECUTE v_sql;

  RAISE NOTICE
    'Created verify current-week fixture (week_start=%, week_end=%, season_id=%, tag=%).',
    v_week_start, v_week_end, v_target_season_id, v_verify_tag;
END
$$;

COMMIT;

-- Verify query
/*
SELECT id, week_index, started_at, ended_at, season_id
FROM public.weeks
WHERE started_at <= CURRENT_DATE
  AND ended_at >= CURRENT_DATE
ORDER BY started_at DESC, id;
*/

-- Rollback
/*
BEGIN;

DELETE FROM public.weeks
WHERE id::text IN (
  'verify-week-2026-05-21',
  '00000000-0000-0000-0000-202605210002'
);

DELETE FROM public.seasons
WHERE id::text IN (
  'verify-season-2026-05-21',
  '00000000-0000-0000-0000-202605210001'
)
   OR name = 'verify-season-2026-05-21';

COMMIT;
*/

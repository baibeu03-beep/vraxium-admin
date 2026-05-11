-- 2026-05-11_users_legacy_user_id_default.sql
-- Synthetic bigint default for `users.legacy_user_id` so admin-approved new users
-- can be inserted without supplying a legacy id. Reserves 100_000_000+ as the
-- synthetic range, leaving imported legacy ids below that threshold untouched.

CREATE SEQUENCE IF NOT EXISTS public.users_legacy_user_id_seq
  START WITH 100000000
  MINVALUE 100000000;

-- If the sequence already existed at a lower value (e.g. created with default
-- MINVALUE 1), bump it past the imported-user range so synthetic ids never
-- collide with legacy ids. Also keep it ahead of any current data.
DO $$
DECLARE
  current_last bigint;
  data_max bigint;
  target bigint;
BEGIN
  SELECT last_value INTO current_last FROM public.users_legacy_user_id_seq;
  SELECT COALESCE(MAX(legacy_user_id), 0) INTO data_max FROM public.users;

  target := GREATEST(current_last, data_max, 99999999) + 1;

  IF target > current_last THEN
    PERFORM setval('public.users_legacy_user_id_seq', target, false);
  END IF;
END $$;

ALTER TABLE public.users
  ALTER COLUMN legacy_user_id
  SET DEFAULT nextval('public.users_legacy_user_id_seq');

ALTER SEQUENCE public.users_legacy_user_id_seq
  OWNED BY public.users.legacy_user_id;

-- 2026-05-11_applicants_email_provider_unique.sql
-- Make Kakao re-logins idempotent: a single applicants row per (email, provider).
-- The `/auth/callback` handler inserts on first Kakao login and relies on a
-- unique-violation (SQLSTATE 23505) on subsequent logins to no-op safely.

CREATE UNIQUE INDEX IF NOT EXISTS applicants_email_provider_unique_idx
  ON public.applicants (lower(email), provider);

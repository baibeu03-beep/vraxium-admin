-- Derived point caches only. process_point_awards and published snapshots are untouched.
-- Canonical formula:
--   A = SUM(point_check)
--   C = SUM(ABS(point_penalty))
--   B = SUM(point_advantage) - C
-- Current user_cumulative_points schema:
--   A -> total_checks
--   raw advantage -> total_raw_advantages
--   C -> total_penalties
--   B -> total_advantages
-- Historical total_stars/total_lightnings/total_shields names are not present
-- in the current database.

with ledger as (
  select
    p.user_id,
    p.year,
    p.week_number,
    min(w.start_date) as week_start_date,
    coalesce(sum(point_check), 0)::integer as point_a,
    coalesce(sum(point_advantage), 0)::integer as raw_advantage,
    coalesce(sum(abs(point_penalty)), 0)::integer as point_c
  from public.process_point_awards p
  join public.weeks w
    on w.iso_year = p.year and w.iso_week = p.week_number
  where p.cancelled_at is null
  group by p.user_id, p.year, p.week_number
)
insert into public.user_weekly_points
  (user_id, year, week_number, week_start_date, points, advantages, penalty, checks_migrated)
select
  user_id, year, week_number, week_start_date, point_a, raw_advantage, point_c, true
from ledger
on conflict (user_id, year, week_number) do update
set week_start_date = excluded.week_start_date,
    points = excluded.points,
    advantages = excluded.advantages,
    penalty = excluded.penalty,
    checks_migrated = true;

-- Remove stale derived weekly values for keys whose ledger has no active rows.
update public.user_weekly_points uwp
set points = 0, advantages = 0, penalty = 0, checks_migrated = true
where uwp.checks_migrated = true
  and not exists (
    select 1
    from public.process_point_awards ppa
    where ppa.user_id = uwp.user_id
      and ppa.year = uwp.year
      and ppa.week_number = uwp.week_number
      and ppa.cancelled_at is null
  );

create or replace function public.sync_cumulative_points_for_user(p_user_id uuid)
returns void
language plpgsql
as $$
declare
  v_a integer;
  v_raw_advantage integer;
  v_c integer;
begin
  select
    coalesce(sum(points), 0)::integer,
    coalesce(sum(advantages), 0)::integer,
    coalesce(sum(abs(penalty)), 0)::integer
  into v_a, v_raw_advantage, v_c
  from public.user_weekly_points
  where user_id = p_user_id;

  insert into public.user_cumulative_points
    (
      user_id,
      total_checks,
      total_raw_advantages,
      total_penalties,
      total_advantages,
      updated_at
    )
  values
    (p_user_id, v_a, v_raw_advantage, v_c, v_raw_advantage - v_c, now())
  on conflict (user_id) do update
  set total_checks = excluded.total_checks,
      total_raw_advantages = excluded.total_raw_advantages,
      total_penalties = excluded.total_penalties,
      total_advantages = excluded.total_advantages,
      updated_at = excluded.updated_at;
end;
$$;

select public.sync_cumulative_points_for_user(user_id)
from (select distinct user_id from public.user_profiles) users;

-- roster slim stores display-ready A/B/C; B is already net and must not be subtracted again.
update public.cluster4_roster_card_stats stats
set po_a = points.point_a,
    po_b = points.point_b,
    po_c = points.point_c,
    updated_at = now()
from (
  select
    user_id,
    coalesce(sum(point_check), 0)::integer as point_a,
    (
      coalesce(sum(point_advantage), 0)
      - coalesce(sum(abs(point_penalty)), 0)
    )::integer as point_b,
    coalesce(sum(abs(point_penalty)), 0)::integer as point_c
  from public.process_point_awards
  where cancelled_at is null
  group by user_id
) points
where stats.user_id = points.user_id;

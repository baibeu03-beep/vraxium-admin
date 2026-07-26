-- ⛔ DO NOT RUN — SUPERSEDED / DESTRUCTIVE (neutralized 2026-07-26).
--
-- ⚠ 정정(2026-07-26 재조사): **이 스크립트는 이 DB 에 이미 실행됐다.**
--   실행 시각 2026-07-25T04:52:05.480492Z (13:52 KST). 증거 —
--     · user_weekly_points 13,110행의 updated_at 이 그 timestamp 로 완전 동일(전부 checks_migrated=true)
--     · user_cumulative_points 723/730행 동일 timestamp(아래 3번 문)
--     · 함수 public.sync_cumulative_points_for_user 가 DB 에 존재(아래 3번 문만 생성)
--     · cluster4_roster_card_stats 85행 동일 timestamp(아래 4번 문)
--   이전 주석의 "적용된 적이 없다"는 오판이었다. checks_migrated=true 13,117행이 남아 있는 것은
--   2번 문이 **값만 0 으로 덮고 플래그는 true 로 유지**하기 때문이라 미적용 근거가 되지 못한다.
--
--   피해: PMS·레거시 이관 주차 포인트 11,508행 / 629명 / ΣA 449,474 · Σadvantage 30,810 ·
--   Σpenalty 18,891 소멸. checks_migrated 는 "process_point_awards 발" 플래그가 아니라
--   "PMS 이관 완료 = 체크 게이트 enforce" 플래그이므로 2번 문의 전제가 틀렸다.
--
--   복구: db/migrations/2026-07-26_uwp_point_recovery_{00,01,99}_*.sql (원천 legacy_point_ledger).
--
-- 전제가 틀렸다: process_point_awards 를 "완전한 원장"으로 보고 user_weekly_points
-- 를 그 투영으로 덮어쓴다. 실측(2026-07-26)은 정반대다 —
--   · user_weekly_points 14,581행 / process_point_awards 1,084행
--   · awards 의 (user,year,week) 키 205개가 전부 uwp 에 동일 값으로 존재
--   · awards 전용 키 0개  ⇒  uwp ⊇ awards
--   · uwp 단독 보유: year=1900 PMS 이관(629행) · 2023~2025 과거 시즌 · 레거시 수동 포인트
-- 즉 아래 1·2번 문은 과거 누적(세 자릿수 A)을 복구 불가능하게 파괴하고,
-- 4번 문은 roster slim 캐시를 같은 축소값으로 덮는다.
--
-- 누적 A/B/C 의 단일 SoT 는 lib/pointResolver.ts (user_weekly_points 전체기간 합).
-- 캐시 재집계가 정말 필요하면 uwp → user_cumulative_points 방향(3번 문 형태)만
-- 쓰고, uwp 자체를 awards 로 덮는 1·2·4번 문은 절대 되살리지 말 것.
--
-- 원문은 이력 보존을 위해 아래에 주석으로 남긴다.

/* ─── NEUTRALIZED (원본, 실행 금지) ───────────────────────────────────

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

─── END NEUTRALIZED ───────────────────────────────────────────────── */

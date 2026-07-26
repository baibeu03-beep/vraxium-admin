-- 2026-07-26 — user_weekly_points 포인트 계층 분리 (재발 방지 · ⛔ 검토 승인 전 실행 금지)
--
-- 목적: "레거시/PMS 기준층" 과 "신규 process_point_awards 기여층" 을 명시적으로 분리해,
--   award 적립·수정·취소·삭제가 기존 PMS·레거시 포인트를 지우지 못하게 한다.
--
-- 재발 원인(실측): lib/processPointAccrual.ts recomputeWeeklyPoints() 가 (user, year, week) 의
--   user_weekly_points 를 **활성 award 합만으로 통째로 덮었다**. 그 주차에 PMS 이관 포인트가
--   있어도 award 하나가 생기면 치환되고, 취소하면 0 이 된다.
--   실증: 최윤하 2024-07-01 — 2026-07-16 08:32 라인 award 1건(0/1/0) 적립 → 08:35 취소
--         → PMS 48/2/4 소멸(2026-07-25 §2 일괄 wipe 보다 9일 앞선 별개 손상).
--
-- 계약(적용 후):
--   points     = legacy_points     + Σ 활성 award.point_check
--   advantages = legacy_advantages + Σ 활성 award.point_advantage
--   penalty    = legacy_penalty    + Σ |활성 award.point_penalty|
--   B = advantages − penalty (lib/pointResolver.ts · 이 마이그레이션과 무관하게 불변)
--
-- ⚠ 배포 순서: **이 마이그레이션을 먼저 적용한 뒤** 코드를 배포할 것.
--   미적용 상태의 신규 코드는 레거시 era 주차의 uwp 쓰기를 건너뛴다(파괴 금지 fail-safe).
--
-- ⚠ 이 스크립트는 points/advantages/penalty 를 **변경하지 않는다**. 파생 컬럼만 채운다.
--   2026-07-25 §2 로 0 이 된 값의 복구는 별도(_01_apply.sql)이며 아직 실행되지 않았다.

begin;

-- ── 1) 컬럼 추가 (nullable — NULL = "아직 분리 안 됨") ────────────────────
alter table public.user_weekly_points
  add column if not exists legacy_points     integer,
  add column if not exists legacy_advantages integer,
  add column if not exists legacy_penalty    integer;

comment on column public.user_weekly_points.legacy_points is
  'PMS·레거시·QA 시드 기준층 A. points = legacy_points + Σ활성 process_point_awards.point_check';
comment on column public.user_weekly_points.legacy_advantages is
  'PMS·레거시·QA 시드 기준층 raw advantage. advantages = legacy_advantages + Σ활성 award.point_advantage';
comment on column public.user_weekly_points.legacy_penalty is
  'PMS·레거시·QA 시드 기준층 penalty magnitude(≥0 크기). penalty = legacy_penalty + Σ|활성 award.point_penalty|';

-- ── 2) 백필: legacy = 현재값 − 활성 award 합 ──────────────────────────────
--   실측 근거(2026-07-26 read-only): 활성 award 키 205개 전부 uwp 값과 **정확히 일치**(불일치 0).
--   즉 이 뺄셈은 award 키에서 정확히 0 을, 그 외 행에서는 현재값 그대로를 남긴다.
--   → QA 시드 test 행(1,383)과 §2 로 0 이 된 행(11,508) 모두 현재 상태 그대로 보존된다.
with active_award as (
  select user_id, year, week_number,
         coalesce(sum(point_check), 0)::integer      as a,
         coalesce(sum(point_advantage), 0)::integer  as adv,
         coalesce(sum(abs(point_penalty)), 0)::integer as pen
    from public.process_point_awards
   where cancelled_at is null
   group by user_id, year, week_number
)
update public.user_weekly_points u
   set legacy_points     = u.points     - coalesce(w.a, 0),
       legacy_advantages = u.advantages - coalesce(w.adv, 0),
       legacy_penalty    = u.penalty    - coalesce(w.pen, 0)
  from (select u2.id,
               aa.a, aa.adv, aa.pen
          from public.user_weekly_points u2
          left join active_award aa
            on aa.user_id = u2.user_id and aa.year = u2.year and aa.week_number = u2.week_number) w
 where w.id = u.id
   and u.legacy_points is null
   and u.legacy_advantages is null
   and u.legacy_penalty is null;   -- 멱등: 이미 분리된 행은 건드리지 않음

-- ── 3) 검증 (하나라도 어긋나면 전체 ROLLBACK) ─────────────────────────────
do $$
declare
  n_null bigint; n_rows bigint;
  s_a bigint; s_adv bigint; s_pen bigint;
  s_la bigint; s_ladv bigint; s_lpen bigint;
  n_broken bigint; n_award_nonzero bigint;
begin
  select count(*) into n_rows from public.user_weekly_points;
  select count(*) into n_null from public.user_weekly_points
   where legacy_points is null or legacy_advantages is null or legacy_penalty is null;
  if n_null > 0 then raise exception '백필 누락 %행 — ROLLBACK', n_null; end if;

  select sum(points), sum(advantages), sum(penalty),
         sum(legacy_points), sum(legacy_advantages), sum(legacy_penalty)
    into s_a, s_adv, s_pen, s_la, s_ladv, s_lpen
    from public.user_weekly_points;
  raise notice '[backfill] rows=% | points=%/%/% | legacy=%/%/%', n_rows, s_a, s_adv, s_pen, s_la, s_ladv, s_lpen;

  -- 불변식: 모든 행에서 points = legacy + 활성 award
  select count(*) into n_broken
    from public.user_weekly_points u
    left join (
      select user_id, year, week_number,
             coalesce(sum(point_check), 0)::integer      as a,
             coalesce(sum(point_advantage), 0)::integer  as adv,
             coalesce(sum(abs(point_penalty)), 0)::integer as pen
        from public.process_point_awards where cancelled_at is null
       group by user_id, year, week_number) aa
      on aa.user_id = u.user_id and aa.year = u.year and aa.week_number = u.week_number
   where u.points     <> u.legacy_points     + coalesce(aa.a, 0)
      or u.advantages <> u.legacy_advantages + coalesce(aa.adv, 0)
      or u.penalty    <> u.legacy_penalty    + coalesce(aa.pen, 0);
  if n_broken > 0 then raise exception '불변식 위반 %행 (points ≠ legacy + award) — ROLLBACK', n_broken; end if;

  -- 활성 award 가 붙은 키는 legacy 가 전부 0 이어야 한다(실측 205/205 정확일치 근거).
  select count(*) into n_award_nonzero
    from public.user_weekly_points u
    join (select distinct user_id, year, week_number from public.process_point_awards where cancelled_at is null) k
      on k.user_id = u.user_id and k.year = u.year and k.week_number = u.week_number
   where u.legacy_points <> 0 or u.legacy_advantages <> 0 or u.legacy_penalty <> 0;
  raise notice '[backfill] award 키 중 legacy≠0 인 행 = % (실측 기준 0 기대)', n_award_nonzero;

  -- 총합 항등: Σlegacy = Σpoints − Σ활성award (참고 출력)
  raise notice '[backfill] 검산 Σlegacy A=% (기대 = Σpoints % − Σaward 1454)', s_la, s_a;
end $$;

commit;

-- 롤백(컬럼 제거):
--   alter table public.user_weekly_points
--     drop column if exists legacy_points,
--     drop column if exists legacy_advantages,
--     drop column if exists legacy_penalty;

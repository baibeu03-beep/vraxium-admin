-- 2026-07-26 user_weekly_points 포인트 복구 — STEP 40: 본 복구 (단일 트랜잭션)
--
-- 원인: db/migrations/2026-07-25_point_resolver_sot.sql §2 가 2026-07-25T04:52:05.480492Z 에
--   운영 DB 에서 실행되어, checks_migrated=true 이면서 활성 process_point_awards 가 없는
--   user_weekly_points 행을 전부 0 으로 덮었다(PMS·레거시 이관 포인트 소멸).
-- 복구 원천: public.legacy_point_ledger 재구성 — 11508행 / 629명 / ΣA 449474 · Σadv 30810 · Σpen 18891
--
-- ⚠ 실행 순서: 10 → 20(001~008) → 30 → 40.  롤백은 99.
-- ⚠ 현재 단계: 40 (실제 UPDATE — 되돌리려면 99)

-- ⚠ STEP 30 이 전 항목 통과한 뒤에만 실행할 것. (이 파일도 같은 게이트를 다시 검사한다 — 30 을
--    건너뛰어도 안전하지만, 순서대로 실행하는 것이 원칙이다.)
--
-- 갱신 컬럼: points · advantages · penalty · legacy_points · legacy_advantages · legacy_penalty ·
--   updated_at 뿐. checks_migrated·year·week_number·week_start_date·created_at·id 는 불변.
--   행 삭제/삽입 0. 스코프 행은 활성 award 가 없으므로 legacy == 최종값(계층 불변식 유지).
--
-- 멱등: 가산이 아니라 staging 값으로 **교체(SET)**. 이미 목표값인 행은 WHERE 에서 빠져
--   재실행 시 갱신 0행이 되고 검증은 그대로 통과한다.

begin;

-- ── 0) 선행 조건 ────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.uwp_recovery_staging_20260726') is null then
    raise exception 'staging 표 부재 — STEP 10/20 먼저 실행할 것';
  end if;
  if (select count(*) from information_schema.columns
       where table_schema='public' and table_name='user_weekly_points'
         and column_name in ('legacy_points','legacy_advantages','legacy_penalty')) <> 3 then
    raise exception '계층 분리 컬럼(legacy_*) 미적용 — 2026-07-26_uwp_legacy_baseline_columns.sql 먼저 적용할 것';
  end if;
end $$;

-- ── 1) 백업 (전체 uwp 사본 — 롤백 원천. 이미 있으면 보존) ─────────────
create table if not exists public.uwp_point_recovery_backup_20260726 as
select *, now() as backed_up_at from public.user_weekly_points;

do $$
declare n bigint;
begin
  select count(*) into n from public.uwp_point_recovery_backup_20260726;
  raise notice '[backup] uwp_point_recovery_backup_20260726 rows=%', n;
  if n = 0 then raise exception '백업 표가 비어 있다 — 중단'; end if;
end $$;

-- ── 2) 계획·대상 재검증 (STEP 30 과 동일 게이트) ──────────────────────
do $$
declare n bigint; nu bigint; s_a bigint; s_adv bigint; s_pen bigint; bad bigint; nochunk bigint;
begin
  select count(*), count(distinct user_id), sum(points), sum(advantages), sum(penalty)
    into n, nu, s_a, s_adv, s_pen from public.uwp_recovery_staging_20260726;
  raise notice '[plan] rows=% users=% ΣA=% Σadv=% Σpen=%', n, nu, s_a, s_adv, s_pen;
  if n     <> 11508     then raise exception '계획 행수 % (기대 11508)', n; end if;
  if nu    <> 629 then raise exception '계획 사용자수 % (기대 629)', nu; end if;
  if s_a   <> 449474    then raise exception '계획 ΣA % (기대 449474)', s_a; end if;
  if s_adv <> 30810  then raise exception '계획 Σadvantage % (기대 30810)', s_adv; end if;
  if s_pen <> 18891  then raise exception '계획 Σpenalty % (기대 18891)', s_pen; end if;

  select count(*) into nochunk from public.uwp_recovery_chunk_manifest_20260726 m
   where not exists (select 1 from public.uwp_recovery_staging_20260726 s where s.chunk_no = m.chunk_no);
  if nochunk > 0 then raise exception '미적재 청크 %개 — STEP 20 미완료', nochunk; end if;

  if exists (select 1 from public.uwp_recovery_staging_20260726 where penalty < 0) then
    raise exception 'penalty 음수 계획값 존재'; end if;
  if exists (select 1 from public.uwp_recovery_staging_20260726 where pre_points <> 0 or pre_advantages <> 0 or pre_penalty <> 0) then
    raise exception 'pre_* 가 0 이 아닌 행 존재'; end if;

  select count(*) into bad from public.uwp_recovery_staging_20260726 s
    left join public.user_weekly_points u on u.id = s.uwp_id where u.id is null;
  if bad > 0 then raise exception 'uwp 행 부재 %건', bad; end if;

  select count(*) into bad from public.uwp_recovery_staging_20260726 s
    join public.user_weekly_points u on u.id = s.uwp_id
   where u.user_id <> s.user_id or u.week_start_date <> s.week_start_date;
  if bad > 0 then raise exception '행 키 불일치 %건', bad; end if;

  select count(*) into bad from public.uwp_recovery_staging_20260726 s
    join public.user_weekly_points u on u.id = s.uwp_id
   where not (
        (u.points = s.pre_points and u.advantages = s.pre_advantages and u.penalty = s.pre_penalty and u.checks_migrated)
     or (u.points = s.points and u.advantages = s.advantages and u.penalty = s.penalty));
  if bad > 0 then raise exception '대상 상태가 dry-run 과 다름 %건 — 덮어쓰기 금지', bad; end if;

  select count(*) into bad from public.uwp_recovery_staging_20260726 s
    join public.user_weekly_points u on u.id = s.uwp_id
   where exists (select 1 from public.process_point_awards a
                  where a.user_id = u.user_id and a.year = u.year and a.week_number = u.week_number
                    and a.cancelled_at is null);
  if bad > 0 then raise exception 'active award 교집합 %건', bad; end if;
end $$;

-- ── 3) 복구 실행 (SET · 가산 아님) ──────────────────────────────────
do $$
declare
  n_upd bigint;
  a0 bigint; adv0 bigint; pen0 bigint;
  a1 bigint; adv1 bigint; pen1 bigint;
begin
  select sum(points), sum(advantages), sum(penalty) into a0, adv0, pen0 from public.user_weekly_points;
  raise notice '[before] uwp 전체 ΣA=% Σadv=% Σpen=%', a0, adv0, pen0;

  update public.user_weekly_points u
     set points            = s.points,
         advantages        = s.advantages,
         penalty           = s.penalty,
         legacy_points     = s.points,
         legacy_advantages = s.advantages,
         legacy_penalty    = s.penalty,
         updated_at        = now()
    from public.uwp_recovery_staging_20260726 s
   where u.id = s.uwp_id
     and (u.points <> s.points or u.advantages <> s.advantages or u.penalty <> s.penalty
       or u.legacy_points is distinct from s.points
       or u.legacy_advantages is distinct from s.advantages
       or u.legacy_penalty is distinct from s.penalty);
  get diagnostics n_upd = row_count;
  raise notice '[update] 갱신 %행 (초회 기대 11508 · 재실행 기대 0)', n_upd;
  if n_upd <> 11508 and n_upd <> 0 then
    raise exception '갱신 행수 % 가 기대(11508 또는 0)와 다름 — ROLLBACK', n_upd;
  end if;

  select sum(points), sum(advantages), sum(penalty) into a1, adv1, pen1 from public.user_weekly_points;
  raise notice '[after]  uwp 전체 ΣA=% Σadv=% Σpen=%', a1, adv1, pen1;
  raise notice '[delta]  ΔA=% Δadv=% Δpen=% (초회 기대 449474/30810/18891)', a1-a0, adv1-adv0, pen1-pen0;
  if n_upd = 11508 and (a1-a0 <> 449474 or adv1-adv0 <> 30810 or pen1-pen0 <> 18891) then
    raise exception '증분 합계 불일치 (ΔA=% Δadv=% Δpen=%) — ROLLBACK', a1-a0, adv1-adv0, pen1-pen0;
  end if;
end $$;

-- ── 4) 사후 검증 ────────────────────────────────────────────────────
do $$
declare bad bigint; touched bigint; backup_fresh boolean;
begin
  select count(*) into bad
    from public.uwp_recovery_staging_20260726 s join public.user_weekly_points u on u.id = s.uwp_id
   where u.points <> s.points or u.advantages <> s.advantages or u.penalty <> s.penalty;
  if bad > 0 then raise exception '사후 불일치 %건 — ROLLBACK', bad; end if;

  -- 계층 불변식: points = legacy + Σ활성 award
  select count(*) into bad
    from public.uwp_recovery_staging_20260726 s
    join public.user_weekly_points u on u.id = s.uwp_id
    left join (select user_id, year, week_number,
                      coalesce(sum(point_check),0)::int a,
                      coalesce(sum(point_advantage),0)::int adv,
                      coalesce(sum(abs(point_penalty)),0)::int pen
                 from public.process_point_awards where cancelled_at is null
                group by user_id, year, week_number) aa
      on aa.user_id = u.user_id and aa.year = u.year and aa.week_number = u.week_number
   where u.points     <> u.legacy_points     + coalesce(aa.a,0)
      or u.advantages <> u.legacy_advantages + coalesce(aa.adv,0)
      or u.penalty    <> u.legacy_penalty    + coalesce(aa.pen,0);
  if bad > 0 then raise exception '계층 불변식 위반 %건 — ROLLBACK', bad; end if;

  -- 계획 밖 행 미접촉(백업을 이 트랜잭션에서 막 뜬 경우에만 엄격 적용)
  select max(backed_up_at) > now() - interval '10 minutes' into backup_fresh from public.uwp_point_recovery_backup_20260726;
  select count(*) into touched
    from public.user_weekly_points u join public.uwp_point_recovery_backup_20260726 b on b.id = u.id
   where not exists (select 1 from public.uwp_recovery_staging_20260726 s where s.uwp_id = u.id)
     and (u.points is distinct from b.points
       or u.advantages is distinct from b.advantages
       or u.penalty is distinct from b.penalty
       or u.legacy_points is distinct from b.legacy_points
       or u.legacy_advantages is distinct from b.legacy_advantages
       or u.legacy_penalty is distinct from b.legacy_penalty
       or u.checks_migrated is distinct from b.checks_migrated
       or u.week_start_date is distinct from b.week_start_date
       or u.year is distinct from b.year
       or u.week_number is distinct from b.week_number);
  if touched > 0 then
    if backup_fresh then raise exception '계획 밖 %행이 변경됨 — ROLLBACK', touched;
    else raise warning '계획 밖 %행이 백업 시점과 다름(재실행 — 이번 트랜잭션 변경 아님). 확인 요망', touched;
    end if;
  end if;

  if backup_fresh and (select count(*) from public.user_weekly_points) <> (select count(*) from public.uwp_point_recovery_backup_20260726) then
    raise exception 'uwp 행수 변동 — ROLLBACK';
  end if;

  raise notice '[verify] 통과 — 계획 11508행 일치 · 계층 불변식 OK · 계획 밖 변경 %', touched;
end $$;

commit;

-- 기대 최종값(별도 실행으로 확인):
--   select count(*) rows, sum(points) a, sum(advantages) raw_adv, sum(penalty) c from public.user_weekly_points;
--   → rows 14581 · a 474277 · raw_adv 39766 · c 22525

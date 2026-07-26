-- 2026-07-26 uwp 포인트 복구 — STEP 99: 롤백 (STEP 01 이후 문제가 발견됐을 때만)
--
-- uwp_point_recovery_backup_20260726 는 STEP 01 이 복구 직전에 뜬 user_weekly_points 전량 사본이다.
-- 이 스크립트는 복구 대상 11508행의 points/advantages/penalty 를 그 사본 값으로 되돌린다.
-- (=§2 피해 상태인 0/0/0 로 회귀한다. "복구 이전"으로 되돌릴 뿐 데이터가 좋아지지 않는다.)

begin;

do $$
declare n_upd bigint;
begin
  if to_regclass('public.uwp_point_recovery_backup_20260726') is null then
    raise exception '백업 표 uwp_point_recovery_backup_20260726 부재 — 롤백 불가';
  end if;

  update public.user_weekly_points u
     set points            = b.points,
         advantages        = b.advantages,
         penalty           = b.penalty,
         legacy_points     = b.legacy_points,
         legacy_advantages = b.legacy_advantages,
         legacy_penalty    = b.legacy_penalty,
         updated_at        = b.updated_at
    from public.uwp_point_recovery_backup_20260726 b
   where u.id = b.id
     and exists (select 1 from public.uwp_point_recovery_plan_20260726 p where p.uwp_id = u.id)
     and (u.points <> b.points or u.advantages <> b.advantages or u.penalty <> b.penalty
       or u.legacy_points is distinct from b.legacy_points
       or u.legacy_advantages is distinct from b.legacy_advantages
       or u.legacy_penalty is distinct from b.legacy_penalty);
  get diagnostics n_upd = row_count;
  raise notice '[rollback] % 행 되돌림', n_upd;
end $$;

commit;

-- 롤백 후에는 STEP 06 파생 재생성(user_cumulative_points → snapshot → roster slim)을
-- 반드시 다시 돌려야 화면이 정합 상태로 돌아온다.

-- 2026-07-26 user_weekly_points 포인트 복구 — STEP 99: 롤백
--
-- 원인: db/migrations/2026-07-25_point_resolver_sot.sql §2 가 2026-07-25T04:52:05.480492Z 에
--   운영 DB 에서 실행되어, checks_migrated=true 이면서 활성 process_point_awards 가 없는
--   user_weekly_points 행을 전부 0 으로 덮었다(PMS·레거시 이관 포인트 소멸).
-- 복구 원천: public.legacy_point_ledger 재구성 — 11508행 / 629명 / ΣA 449474 · Σadv 30810 · Σpen 18891
--
-- ⚠ 실행 순서: 10 → 20(001~008) → 30 → 40.  롤백은 99.
-- ⚠ 현재 단계: 99 (STEP 40 이후 문제 발견 시에만)

-- uwp_point_recovery_backup_20260726 는 STEP 40 이 복구 직전에 뜬 user_weekly_points 전량 사본이다.
-- staging 에 등재된 11508행의 points/advantages/penalty/legacy_* 를 그 사본 값으로 되돌린다.
-- (= §2 피해 상태인 0/0/0 으로 회귀한다. "복구 이전" 으로 되돌릴 뿐 데이터가 좋아지지 않는다.)

begin;

do $$
declare n_upd bigint;
begin
  if to_regclass('public.uwp_point_recovery_backup_20260726') is null then
    raise exception '백업 표 uwp_point_recovery_backup_20260726 부재 — 롤백 불가'; end if;
  if to_regclass('public.uwp_recovery_staging_20260726') is null then
    raise exception 'staging 표 부재 — 롤백 대상 특정 불가'; end if;

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
     and exists (select 1 from public.uwp_recovery_staging_20260726 s where s.uwp_id = u.id)
     and (u.points <> b.points or u.advantages <> b.advantages or u.penalty <> b.penalty
       or u.legacy_points is distinct from b.legacy_points
       or u.legacy_advantages is distinct from b.legacy_advantages
       or u.legacy_penalty is distinct from b.legacy_penalty);
  get diagnostics n_upd = row_count;
  raise notice '[rollback] % 행 되돌림', n_upd;
end $$;

commit;

-- 롤백 후에는 파생 재생성(scripts/recover-uwp-derived.ts)을 다시 돌려야 화면이 정합 상태로 돌아온다.
-- 정리(모든 검증이 끝난 뒤에만):
--   drop table if exists public.uwp_recovery_staging_20260726;
--   drop table if exists public.uwp_recovery_chunk_manifest_20260726;
--   drop table if exists public.uwp_point_recovery_backup_20260726;

-- 2026-07-26 user_weekly_points 포인트 복구 — STEP 10: staging + chunk manifest 생성
--
-- 원인: db/migrations/2026-07-25_point_resolver_sot.sql §2 가 2026-07-25T04:52:05.480492Z 에
--   운영 DB 에서 실행되어, checks_migrated=true 이면서 활성 process_point_awards 가 없는
--   user_weekly_points 행을 전부 0 으로 덮었다(PMS·레거시 이관 포인트 소멸).
-- 복구 원천: public.legacy_point_ledger 재구성 — 11508행 / 629명 / ΣA 449474 · Σadv 30810 · Σpen 18891
--
-- ⚠ 실행 순서: 10 → 20(001~008) → 30 → 40.  롤백은 99.
-- ⚠ 현재 단계: 10 (구조만 생성 · user_weekly_points 무접촉)

-- 이 파일은 표 2개를 만들 뿐 운영 데이터를 읽거나 쓰지 않는다. 재실행 안전(if not exists / on conflict).

begin;

-- 선행 조건: 계층 분리 컬럼이 적용돼 있어야 한다.
do $$
begin
  if (select count(*) from information_schema.columns
       where table_schema='public' and table_name='user_weekly_points'
         and column_name in ('legacy_points','legacy_advantages','legacy_penalty')) <> 3 then
    raise exception '계층 분리 컬럼(legacy_*) 미적용 — 2026-07-26_uwp_legacy_baseline_columns.sql 먼저 적용할 것';
  end if;
end $$;

create table if not exists public.uwp_recovery_staging_20260726 (
  uwp_id          uuid primary key,          -- user_weekly_points.id
  user_id         uuid        not null,
  week_start_date date        not null,
  points          integer     not null,      -- 복구 목표 A
  advantages      integer     not null,      -- 복구 목표 raw advantage
  penalty         integer     not null,      -- 복구 목표 penalty magnitude(≥0)
  pre_points      integer     not null,      -- dry-run 시점 현재값(=§2 피해 상태, 전부 0)
  pre_advantages  integer     not null,
  pre_penalty     integer     not null,
  chunk_no        smallint    not null,
  loaded_at       timestamptz not null default now()
);

create index if not exists uwp_recovery_staging_20260726_user_idx on public.uwp_recovery_staging_20260726 (user_id);

-- 청크 적재 완전성 검증용 기대치(생성기가 dry-run 에서 산출).
create table if not exists public.uwp_recovery_chunk_manifest_20260726 (
  chunk_no         smallint primary key,
  expected_rows    integer not null,
  expected_sum_a   bigint  not null,
  expected_sum_adv bigint  not null,
  expected_sum_pen bigint  not null
);

insert into public.uwp_recovery_chunk_manifest_20260726 (chunk_no, expected_rows, expected_sum_a, expected_sum_adv, expected_sum_pen) values
 (1,1500,144168,8789,1360),
 (2,1500,93906,6054,1720),
 (3,1500,75504,4481,2456),
 (4,1500,60988,3104,3271),
 (5,1500,46307,2720,4212),
 (6,1500,24303,2397,3007),
 (7,1500,4308,1721,1439),
 (8,1008,-10,1544,1426)
on conflict (chunk_no) do update
   set expected_rows = excluded.expected_rows,
       expected_sum_a = excluded.expected_sum_a,
       expected_sum_adv = excluded.expected_sum_adv,
       expected_sum_pen = excluded.expected_sum_pen;

do $$
declare n int; s_r bigint; s_a bigint;
begin
  select count(*), sum(expected_rows), sum(expected_sum_a) into n, s_r, s_a from public.uwp_recovery_chunk_manifest_20260726;
  raise notice '[staging] 표 생성 완료 · chunk manifest % 청크 · 기대 총행 % · 기대 ΣA %', n, s_r, s_a;
  if n <> 8 then raise exception 'chunk manifest 청크 수 % (기대 8)', n; end if;
  if s_r <> 11508 then raise exception 'chunk manifest 총 행수 % (기대 11508)', s_r; end if;
  if s_a <> 449474 then raise exception 'chunk manifest ΣA % (기대 449474)', s_a; end if;
end $$;

commit;

-- 확인: [staging] 표 생성 완료 · chunk manifest 8 청크 · 기대 총행 11508 · 기대 ΣA 449474

-- 2026-07-26 uwp 포인트 복구 — STEP 00: 독립 검증 기준선 동결 (읽기 원천 보호)
--
-- ⚠ 가장 먼저 실행할 것. pre-wipe 캐시는 화면 접근/스냅샷 재계산 때마다 덮여 사라진다.
--   실측(2026-07-26 05:40): cluster4_weekly_card_snapshots 730행 중 pre-wipe 잔존 648,
--   cluster4_roster_card_stats 732행 중 pre-wipe 잔존 565. 이미 각각 75/167행이 소실됐다.
--   이 표들은 §2 이전의 주차별·누적 A/B/C 를 담은 **유일한 독립 증거**다.
--
-- 안전 계약(검토 완료):
--   · 운영 원본에 UPDATE/DELETE 없음 — CREATE TABLE AS + SELECT 만.
--   · 별도 백업 테이블만 생성.
--   · 기존 백업이 있으면 덮어쓰지 않음 — 전부 `if not exists`.
--   · 재실행해도 중복 백업 없음 — `if not exists` 가 no-op 이 되고, manifest 도 중복 방지.
--   · 행 수 · 사용자 수 · A/raw advantage/penalty 합계를 manifest 테이블에 기록.
--   · 원본 updated_at · checks_migrated · 사용자/주차 식별자를 `select *` 로 전 컬럼 보존.
--   · 실패 시 트랜잭션 전체 취소 — 원본 무영향.
--
-- ⚠ 파일 기반 동결은 이미 완료돼 있다(backups/uwp-baseline-freeze-*, DB write 0).
--   이 스크립트는 DB 안에도 사본을 두고 싶을 때 실행한다.

begin;

-- ── 1) 원본 사본 (전 컬럼 — updated_at·checks_migrated·식별자 포함) ────
create table if not exists public.uwp_point_recovery_backup_20260726_user_weekly_points as
select *, now() as frozen_at from public.user_weekly_points;

create table if not exists public.uwp_point_recovery_backup_20260726_process_point_awards as
select *, now() as frozen_at from public.process_point_awards;

create table if not exists public.uwp_point_recovery_backup_20260726_weekly_card_snapshots as
select *, now() as frozen_at from public.cluster4_weekly_card_snapshots;

create table if not exists public.uwp_point_recovery_backup_20260726_roster_card_stats as
select *, now() as frozen_at from public.cluster4_roster_card_stats;

create table if not exists public.uwp_point_recovery_backup_20260726_user_cumulative_points as
select *, now() as frozen_at from public.user_cumulative_points;

-- ── 2) manifest — 행 수 · 사용자 수 · 합계 기록 ─────────────────────────
create table if not exists public.uwp_point_recovery_backup_20260726_manifest (
  frozen_at            timestamptz not null default now(),
  source_table         text        not null,
  row_count            bigint      not null,
  user_count           bigint      not null,
  sum_a                bigint,
  sum_raw_advantage    bigint,
  sum_penalty          bigint,
  note                 text,
  primary key (source_table, frozen_at)
);

insert into public.uwp_point_recovery_backup_20260726_manifest (source_table, row_count, user_count, sum_a, sum_raw_advantage, sum_penalty, note)
select 'user_weekly_points', count(*), count(distinct user_id),
       sum(points), sum(advantages), sum(penalty),
       'checks_migrated=true ' || count(*) filter (where checks_migrated)
         || ' / wiped(' || '2026-07-25 04:52:05.480492+00' || ') ' || count(*) filter (where updated_at = timestamptz '2026-07-25 04:52:05.480492+00')
  from public.uwp_point_recovery_backup_20260726_user_weekly_points
 where not exists (select 1 from public.uwp_point_recovery_backup_20260726_manifest m where m.source_table = 'user_weekly_points')
union all
select 'process_point_awards', count(*), count(distinct user_id),
       sum(point_check) filter (where cancelled_at is null),
       sum(point_advantage) filter (where cancelled_at is null),
       sum(abs(point_penalty)) filter (where cancelled_at is null),
       'active ' || count(*) filter (where cancelled_at is null) || ' / cancelled ' || count(*) filter (where cancelled_at is not null)
  from public.uwp_point_recovery_backup_20260726_process_point_awards
 where not exists (select 1 from public.uwp_point_recovery_backup_20260726_manifest m where m.source_table = 'process_point_awards')
union all
select 'cluster4_roster_card_stats', count(*), count(distinct user_id),
       sum(po_a) filter (where updated_at < timestamptz '2026-07-25 04:52:05.480492+00'),
       sum(po_b) filter (where updated_at < timestamptz '2026-07-25 04:52:05.480492+00'),
       sum(po_c) filter (where updated_at < timestamptz '2026-07-25 04:52:05.480492+00'),
       'pre-wipe ' || count(*) filter (where updated_at < timestamptz '2026-07-25 04:52:05.480492+00') || ' (po_b = raw advantage)'
  from public.uwp_point_recovery_backup_20260726_roster_card_stats
 where not exists (select 1 from public.uwp_point_recovery_backup_20260726_manifest m where m.source_table = 'cluster4_roster_card_stats')
union all
select 'cluster4_weekly_card_snapshots', count(*), count(distinct user_id), null, null, null,
       'pre-wipe ' || count(*) filter (where computed_at < timestamptz '2026-07-25 04:52:05.480492+00')
  from public.uwp_point_recovery_backup_20260726_weekly_card_snapshots
 where not exists (select 1 from public.uwp_point_recovery_backup_20260726_manifest m where m.source_table = 'cluster4_weekly_card_snapshots')
union all
select 'user_cumulative_points', count(*), count(distinct user_id), null, null, null, null
  from public.uwp_point_recovery_backup_20260726_user_cumulative_points
 where not exists (select 1 from public.uwp_point_recovery_backup_20260726_manifest m where m.source_table = 'user_cumulative_points');

-- ── 3) 결과 출력 ────────────────────────────────────────────────────────
select * from public.uwp_point_recovery_backup_20260726_manifest order by source_table;

commit;

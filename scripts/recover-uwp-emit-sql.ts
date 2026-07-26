/**
 * READ-ONLY 생성기 — dry-run 결과로부터 **실행하지 않는** 복구 SQL 3종을 파일로 출력한다.
 *   npx tsx --env-file=.env.local scripts/recover-uwp-emit-sql.ts
 * DB write 0 (파일 쓰기만).
 *
 * 산출물:
 *   db/migrations/2026-07-26_uwp_point_recovery_00_baseline_backup.sql  ← 소실 중인 기준선 즉시 동결
 *   db/migrations/2026-07-26_uwp_point_recovery_01_apply.sql            ← 본 복구(트랜잭션·검증·idempotent)
 *   db/migrations/2026-07-26_uwp_point_recovery_99_rollback.sql         ← 백업표에서 역복원
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs";

type Row = {
  user_id: string; display_name: string; org: string; is_test: boolean; week_start_date: string; week_kind: string;
  year: number | null; week_number: number | null;
  cur_a: number; exp_a: number; cur_adv: number; exp_adv: number; cur_pen: number; exp_pen: number;
  checks_migrated: boolean; wiped: boolean; has_award: boolean; uwp_row_id: string | null;
};

const WIPE_TS = "2026-07-25 04:52:05.480492+00";
const BACKUP = "uwp_point_recovery_backup_20260726";
const PLAN_TBL = "uwp_point_recovery_plan_20260726";

function main() {
  const file = "claudedocs/" + readdirSync("claudedocs").filter((x) => x.startsWith("recover-uwp-dryrun-") && x.endsWith(".json")).sort().pop()!;
  const { rows } = JSON.parse(readFileSync(file, "utf8")) as { rows: Row[] };

  const scope = rows.filter(
    (r) => r.wiped && r.checks_migrated && !r.has_award && r.cur_a === 0 && r.cur_adv === 0 && r.cur_pen === 0 &&
      (r.exp_a !== 0 || r.exp_adv !== 0 || r.exp_pen !== 0),
  );
  if (scope.some((r) => !r.uwp_row_id)) throw new Error("uwp_row_id 누락 행 존재 — 생성 중단");

  const N = scope.length;
  const SA = scope.reduce((s, r) => s + r.exp_a, 0);
  const SADV = scope.reduce((s, r) => s + r.exp_adv, 0);
  const SPEN = scope.reduce((s, r) => s + r.exp_pen, 0);
  const USERS = new Set(scope.map((r) => r.user_id)).size;

  mkdirSync("db/migrations", { recursive: true });

  // ── 00. 기준선 백업 ──────────────────────────────────────────────
  const baseline = `-- 2026-07-26 uwp 포인트 복구 — STEP 00: 독립 검증 기준선 동결 (읽기 원천 보호)
--
-- ⚠ 가장 먼저 실행할 것. pre-wipe 캐시는 화면 접근/스냅샷 재계산 때마다 덮여 사라진다.
--   실측(2026-07-26 05:40): cluster4_weekly_card_snapshots 730행 중 pre-wipe 잔존 648,
--   cluster4_roster_card_stats 732행 중 pre-wipe 잔존 565. 이미 각각 75/167행이 소실됐다.
--   이 표들은 §2 이전의 주차별·누적 A/B/C 를 담은 **유일한 독립 증거**다.
--
-- 안전 계약(검토 완료):
--   · 운영 원본에 UPDATE/DELETE 없음 — CREATE TABLE AS + SELECT 만.
--   · 별도 백업 테이블만 생성.
--   · 기존 백업이 있으면 덮어쓰지 않음 — 전부 \`if not exists\`.
--   · 재실행해도 중복 백업 없음 — \`if not exists\` 가 no-op 이 되고, manifest 도 중복 방지.
--   · 행 수 · 사용자 수 · A/raw advantage/penalty 합계를 manifest 테이블에 기록.
--   · 원본 updated_at · checks_migrated · 사용자/주차 식별자를 \`select *\` 로 전 컬럼 보존.
--   · 실패 시 트랜잭션 전체 취소 — 원본 무영향.
--
-- ⚠ 파일 기반 동결은 이미 완료돼 있다(backups/uwp-baseline-freeze-*, DB write 0).
--   이 스크립트는 DB 안에도 사본을 두고 싶을 때 실행한다.

begin;

-- ── 1) 원본 사본 (전 컬럼 — updated_at·checks_migrated·식별자 포함) ────
create table if not exists public.${BACKUP}_user_weekly_points as
select *, now() as frozen_at from public.user_weekly_points;

create table if not exists public.${BACKUP}_process_point_awards as
select *, now() as frozen_at from public.process_point_awards;

create table if not exists public.${BACKUP}_weekly_card_snapshots as
select *, now() as frozen_at from public.cluster4_weekly_card_snapshots;

create table if not exists public.${BACKUP}_roster_card_stats as
select *, now() as frozen_at from public.cluster4_roster_card_stats;

create table if not exists public.${BACKUP}_user_cumulative_points as
select *, now() as frozen_at from public.user_cumulative_points;

-- ── 2) manifest — 행 수 · 사용자 수 · 합계 기록 ─────────────────────────
create table if not exists public.${BACKUP}_manifest (
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

insert into public.${BACKUP}_manifest (source_table, row_count, user_count, sum_a, sum_raw_advantage, sum_penalty, note)
select 'user_weekly_points', count(*), count(distinct user_id),
       sum(points), sum(advantages), sum(penalty),
       'checks_migrated=true ' || count(*) filter (where checks_migrated)
         || ' / wiped(' || '${WIPE_TS}' || ') ' || count(*) filter (where updated_at = timestamptz '${WIPE_TS}')
  from public.${BACKUP}_user_weekly_points
 where not exists (select 1 from public.${BACKUP}_manifest m where m.source_table = 'user_weekly_points')
union all
select 'process_point_awards', count(*), count(distinct user_id),
       sum(point_check) filter (where cancelled_at is null),
       sum(point_advantage) filter (where cancelled_at is null),
       sum(abs(point_penalty)) filter (where cancelled_at is null),
       'active ' || count(*) filter (where cancelled_at is null) || ' / cancelled ' || count(*) filter (where cancelled_at is not null)
  from public.${BACKUP}_process_point_awards
 where not exists (select 1 from public.${BACKUP}_manifest m where m.source_table = 'process_point_awards')
union all
select 'cluster4_roster_card_stats', count(*), count(distinct user_id),
       sum(po_a) filter (where updated_at < timestamptz '${WIPE_TS}'),
       sum(po_b) filter (where updated_at < timestamptz '${WIPE_TS}'),
       sum(po_c) filter (where updated_at < timestamptz '${WIPE_TS}'),
       'pre-wipe ' || count(*) filter (where updated_at < timestamptz '${WIPE_TS}') || ' (po_b = raw advantage)'
  from public.${BACKUP}_roster_card_stats
 where not exists (select 1 from public.${BACKUP}_manifest m where m.source_table = 'cluster4_roster_card_stats')
union all
select 'cluster4_weekly_card_snapshots', count(*), count(distinct user_id), null, null, null,
       'pre-wipe ' || count(*) filter (where computed_at < timestamptz '${WIPE_TS}')
  from public.${BACKUP}_weekly_card_snapshots
 where not exists (select 1 from public.${BACKUP}_manifest m where m.source_table = 'cluster4_weekly_card_snapshots')
union all
select 'user_cumulative_points', count(*), count(distinct user_id), null, null, null, null
  from public.${BACKUP}_user_cumulative_points
 where not exists (select 1 from public.${BACKUP}_manifest m where m.source_table = 'user_cumulative_points');

-- ── 3) 결과 출력 ────────────────────────────────────────────────────────
select * from public.${BACKUP}_manifest order by source_table;

commit;
`;
  writeFileSync("db/migrations/2026-07-26_uwp_point_recovery_00_baseline_backup.sql", baseline, "utf8");

  // ── 01. 본 복구 ──────────────────────────────────────────────────
  const CHUNK = 500;
  const inserts: string[] = [];
  for (let i = 0; i < scope.length; i += CHUNK) {
    const vals = scope.slice(i, i + CHUNK)
      .map((r) => `('${r.uwp_row_id}','${r.user_id}','${r.week_start_date}',${r.exp_a},${r.exp_adv},${r.exp_pen},${r.cur_a},${r.cur_adv},${r.cur_pen})`)
      .join(",\n ");
    inserts.push(`insert into public.${PLAN_TBL} (uwp_id,user_id,week_start_date,points,advantages,penalty,pre_points,pre_advantages,pre_penalty) values\n ${vals};`);
  }

  const apply = `-- 2026-07-26 uwp 포인트 복구 — STEP 01: 본 복구 (⛔ 검토 승인 전 실행 금지)
--
-- 원인: db/migrations/2026-07-25_point_resolver_sot.sql §2 가 2026-07-25T04:52:05.480492Z 에
--   운영 DB 에서 실행되어, checks_migrated=true 이면서 대응하는 활성 process_point_awards 가
--   없는 user_weekly_points 행을 전부 points=0/advantages=0/penalty=0 으로 덮었다.
--   checks_migrated 는 "awards 발" 플래그가 아니라 "PMS 이관 완료 = 체크 게이트 enforce"
--   플래그이므로, PMS·레거시 이관 포인트가 통째로 소멸했다.
--
-- 복구 원천: public.legacy_point_ledger (206,051행 / POINTLOG 203,110 · POINTLOG_VOIDED 2,312
--   · MIGRATION_ADJUSTMENT 629). 재구성 규칙은 apply-pms-{pilot-5,source-batch,olympus-batch}.ts
--   / promote-restusers.ts / apply-held3-migration.ts / apply-jeonhyeonseong-migration.ts /
--   lib/pmsPointlogsSync.ts 와 동일:
--     · points  += star                (IsDeleted 무관 — POINTLOG_VOIDED 도 star 는 합산)
--     · 활동시작 14일 이내 음수 star → 0  (usersinfo.StartDate + 14d, StartDate<2020 이면 미적용)
--     · shield 는 IsDeleted=0(POINTLOG) 만: >0 → advantages, <0 → penalty(양수 크기)
--     · 주차 귀속 = legacy_point_ledger.week_id → weeks.start_date
--     · MIGRATION_ADJUSTMENT(week_id NULL) 은 1900-01-01 sentinel 행 전용 → 복구 대상 제외
--
-- 스코프 (아래 4조건 전부 만족하는 행만):
--     ① §2 피해행 — 동결 스냅샷(backups/uwp-baseline-freeze-*)의 updated_at=${WIPE_TS} 마커로 식별
--        (라이브 updated_at 은 2026-07-26 legacy 백필 트리거로 덮여 더 이상 마커가 아니다)
--     ② checks_migrated = true
--     ③ 대응 (user,year,week) 에 활성 process_point_awards 없음   ← awards SoT 행 미접촉
--     ④ 현재 points/advantages/penalty 가 전부 0 이고 원장 재구성값이 비영
--   ⇒ ${N}행 / ${USERS}명 / ΣA ${SA} · Σadvantage ${SADV} · Σpenalty ${SPEN}
--
-- 미포함(의도적):
--   · process_point_awards 활성 키 205행 — recomputeWeeklyPoints() 가 소유하는 라이브 원장.
--   · 테스트 계정 QA 시드 1,035행(83명) — legacy_point_ledger 미보유라 이 원천으로 복구 불가.
--   · year=1900 sentinel 629행 — checks_migrated=false 라 §2 미대상(무손상).
--
-- ⚠ 선행 조건 2: db/migrations/2026-07-26_uwp_legacy_baseline_columns.sql (계층 분리) 적용.
--   미적용 상태로 복구하면 복원된 449,474 A 가 다시 "award 1건에 소멸" 상태로 노출된다
--   (구산식 재발 위험 실측: 현재도 1,199행/23,349 A 가 그 상태다).
--   이 스크립트는 복구값을 points 와 legacy_* 양쪽에 동시에 써서 계층 불변식을 유지한다
--   (스코프 행은 정의상 활성 award 가 없으므로 legacy == 최종값).
--
-- 갱신 컬럼: points · advantages · penalty · legacy_points · legacy_advantages · legacy_penalty ·
--   updated_at 뿐. checks_migrated·year·week_number·week_start_date·created_at·id 는 불변.
--   행 삭제/삽입 0.
--
-- 멱등: 가산이 아니라 계획값으로 **교체(SET)** 하며, 이미 계획값인 행은 UPDATE 대상에서 빠진다.
--   재실행 시 갱신 0행이고 사후 검증은 그대로 통과한다.
--
-- ⚠ 선행 조건: STEP 00(기준선 백업)을 먼저 실행할 것.

begin;

-- ── 0) 선행 조건: 계층 분리 컬럼이 적용돼 있어야 한다 ────────────────────
do $$
begin
  if to_regclass('public.user_weekly_points') is null then
    raise exception 'user_weekly_points 부재';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'user_weekly_points'
       and column_name in ('legacy_points', 'legacy_advantages', 'legacy_penalty')
     having count(*) = 3
  ) then
    raise exception '계층 분리 컬럼(legacy_*) 미적용 — db/migrations/2026-07-26_uwp_legacy_baseline_columns.sql 먼저 적용할 것';
  end if;
end $$;

-- ── 1) 복구 대상 스냅샷 백업 (전체 uwp 복사 — 롤백 원천) ────────────────
create table if not exists public.${BACKUP} as
select *, now() as backed_up_at from public.user_weekly_points;

do $$
declare n bigint;
begin
  select count(*) into n from public.${BACKUP};
  raise notice '[backup] ${BACKUP} rows=%', n;
  if n = 0 then raise exception '백업 표가 비어 있다 — 중단'; end if;
end $$;

-- ── 2) 복구 계획 적재 ──────────────────────────────────────────────
drop table if exists public.${PLAN_TBL};
create table public.${PLAN_TBL} (
  uwp_id          uuid primary key,
  user_id         uuid not null,
  week_start_date date not null,
  points          integer not null,   -- 복구 목표값
  advantages      integer not null,
  penalty         integer not null,
  pre_points      integer not null,   -- dry-run 시점의 현재값(=§2 피해 상태). 대상 정합 검증용
  pre_advantages  integer not null,
  pre_penalty     integer not null
);

${inserts.join("\n\n")}

-- ── 3) 계획 자체 검증 (dry-run 산출물과 바이트 단위 일치) ──────────────
do $$
declare n bigint; sa bigint; sadv bigint; spen bigint; nu bigint;
begin
  select count(*), sum(points), sum(advantages), sum(penalty), count(distinct user_id)
    into n, sa, sadv, spen, nu from public.${PLAN_TBL};
  raise notice '[plan] rows=% users=% ΣA=% Σadv=% Σpen=%', n, nu, sa, sadv, spen;
  if n    <> ${N}    then raise exception '계획 행수 % (기대 ${N})', n; end if;
  if nu   <> ${USERS} then raise exception '계획 사용자수 % (기대 ${USERS})', nu; end if;
  if sa   <> ${SA}   then raise exception '계획 ΣA % (기대 ${SA})', sa; end if;
  if sadv <> ${SADV} then raise exception '계획 Σadvantage % (기대 ${SADV})', sadv; end if;
  if spen <> ${SPEN} then raise exception '계획 Σpenalty % (기대 ${SPEN})', spen; end if;
  if exists (select 1 from public.${PLAN_TBL} where penalty < 0) then
    raise exception 'penalty 음수 계획값 존재 — C 는 항상 양수 크기여야 한다';
  end if;
  -- 스코프 정의상 dry-run 시점 값은 전부 0/0/0 이어야 한다.
  if exists (select 1 from public.${PLAN_TBL} where pre_points <> 0 or pre_advantages <> 0 or pre_penalty <> 0) then
    raise exception '계획의 pre_* 가 0 이 아닌 행 존재 — 스코프 정의 위반';
  end if;
end $$;

-- ── 4) 대상 정합 검증 (dry-run 시점 이후 DB 가 변했으면 즉시 중단) ──────
do $$
declare bad bigint;
begin
  select count(*) into bad
    from public.${PLAN_TBL} p left join public.user_weekly_points u on u.id = p.uwp_id
   where u.id is null;
  if bad > 0 then raise exception 'uwp 행 부재 %건 — dry-run 재실행 필요', bad; end if;

  select count(*) into bad
    from public.${PLAN_TBL} p join public.user_weekly_points u on u.id = p.uwp_id
   where u.user_id <> p.user_id or u.week_start_date <> p.week_start_date;
  if bad > 0 then raise exception '행 키(user_id/week_start_date) 불일치 %건 — 중단', bad; end if;

  -- 아직 §2 피해 상태(dry-run 시점 값 그대로 · cm=true)이거나, 이미 계획값으로 복구된 상태여야 한다.
  --
  -- ⚠ updated_at 창(§2 실행 시각)은 더 이상 판별에 쓸 수 없다. user_weekly_points 에는
  --   updated_at 자동 갱신 트리거가 있고, 2026-07-26 06:39 의 legacy baseline 백필 UPDATE 가
  --   전 14,581행의 updated_at 을 덮어 §2 마커(2026-07-25T04:52:05.480492+00)가 소실됐다.
  --   포인트 값은 무손상이며(동결본 대조: points/advantages/penalty 변경 0행), §2 피해행 식별은
  --   동결 스냅샷(backups/uwp-baseline-freeze-*)의 마커로 수행해 pre_* 로 고정했다.
  --   여기서는 "행의 현재 값이 dry-run 시점 값과 같은가" 로 더 강하게 검증한다.
  select count(*) into bad
    from public.${PLAN_TBL} p join public.user_weekly_points u on u.id = p.uwp_id
   where not (
        (u.points = p.pre_points and u.advantages = p.pre_advantages and u.penalty = p.pre_penalty
         and u.checks_migrated)
     or (u.points = p.points and u.advantages = p.advantages and u.penalty = p.penalty)
   );
  if bad > 0 then raise exception '대상 상태가 dry-run 과 다름 %건 — 덮어쓰기 금지, dry-run 재실행 필요', bad; end if;

  -- 계층 분리 정합: 아직 복구 전이면 legacy 도 pre_* 와 같아야 한다(백필이 legacy=값−award 였으므로).
  select count(*) into bad
    from public.${PLAN_TBL} p join public.user_weekly_points u on u.id = p.uwp_id
   where u.points = p.pre_points and u.advantages = p.pre_advantages and u.penalty = p.pre_penalty
     and (u.legacy_points is distinct from p.pre_points
       or u.legacy_advantages is distinct from p.pre_advantages
       or u.legacy_penalty is distinct from p.pre_penalty);
  if bad > 0 then raise exception '복구 전 legacy 층이 예상과 다름 %건 — 중단', bad; end if;

  -- 활성 award 가 새로 생긴 키가 계획에 섞이면 이중 원장이 된다 → 중단.
  select count(*) into bad
    from public.${PLAN_TBL} p
    join public.user_weekly_points u on u.id = p.uwp_id
   where exists (
     select 1 from public.process_point_awards a
      where a.user_id = u.user_id and a.year = u.year and a.week_number = u.week_number
        and a.cancelled_at is null);
  if bad > 0 then raise exception '활성 process_point_awards 키 %건 포함 — 스코프 재계산 필요', bad; end if;
end $$;

-- ── 5) 복구 실행 (SET · 가산 아님) ──────────────────────────────────
do $$
declare
  n_upd bigint;
  a0 bigint; adv0 bigint; pen0 bigint;
  a1 bigint; adv1 bigint; pen1 bigint;
begin
  select sum(points), sum(advantages), sum(penalty) into a0, adv0, pen0 from public.user_weekly_points;
  raise notice '[before] uwp 전체 ΣA=% Σadv=% Σpen=%', a0, adv0, pen0;

  -- 스코프 행은 활성 award 가 없으므로 legacy(기준층) == 최종값. 두 층을 함께 써서
  -- "points = legacy + Σ활성award" 불변식을 유지한다.
  update public.user_weekly_points u
     set points            = p.points,
         advantages        = p.advantages,
         penalty           = p.penalty,
         legacy_points     = p.points,
         legacy_advantages = p.advantages,
         legacy_penalty    = p.penalty,
         updated_at        = now()
    from public.${PLAN_TBL} p
   where u.id = p.uwp_id
     and (u.points <> p.points or u.advantages <> p.advantages or u.penalty <> p.penalty
       or u.legacy_points is distinct from p.points
       or u.legacy_advantages is distinct from p.advantages
       or u.legacy_penalty is distinct from p.penalty);
  get diagnostics n_upd = row_count;
  raise notice '[update] 갱신 %행 (초회 기대 ${N} · 재실행 기대 0)', n_upd;

  if n_upd <> ${N} and n_upd <> 0 then
    raise exception '갱신 행수 % 가 기대(${N} 또는 0)와 다름 — ROLLBACK', n_upd;
  end if;

  select sum(points), sum(advantages), sum(penalty) into a1, adv1, pen1 from public.user_weekly_points;
  raise notice '[after]  uwp 전체 ΣA=% Σadv=% Σpen=%', a1, adv1, pen1;
  raise notice '[delta]  ΔA=% Δadv=% Δpen=% (초회 기대 ${SA}/${SADV}/${SPEN})', a1 - a0, adv1 - adv0, pen1 - pen0;

  if n_upd = ${N} and (a1 - a0 <> ${SA} or adv1 - adv0 <> ${SADV} or pen1 - pen0 <> ${SPEN}) then
    raise exception '증분 합계 불일치 (ΔA=% Δadv=% Δpen=%) — ROLLBACK', a1 - a0, adv1 - adv0, pen1 - pen0;
  end if;
end $$;

-- ── 6) 사후 검증: 계획 전량이 실제 값과 일치해야 한다 ────────────────────
do $$
declare bad bigint; touched bigint; backup_fresh boolean;
begin
  select count(*) into bad
    from public.${PLAN_TBL} p join public.user_weekly_points u on u.id = p.uwp_id
   where u.points <> p.points or u.advantages <> p.advantages or u.penalty <> p.penalty;
  if bad > 0 then raise exception '사후 불일치 %건 — ROLLBACK', bad; end if;

  -- 계층 불변식: points = legacy + Σ활성 award (복구 행 전량)
  select count(*) into bad
    from public.${PLAN_TBL} p
    join public.user_weekly_points u on u.id = p.uwp_id
    left join (
      select user_id, year, week_number,
             coalesce(sum(point_check), 0)::integer       as a,
             coalesce(sum(point_advantage), 0)::integer   as adv,
             coalesce(sum(abs(point_penalty)), 0)::integer as pen
        from public.process_point_awards where cancelled_at is null
       group by user_id, year, week_number) aa
      on aa.user_id = u.user_id and aa.year = u.year and aa.week_number = u.week_number
   where u.points     <> u.legacy_points     + coalesce(aa.a, 0)
      or u.advantages <> u.legacy_advantages + coalesce(aa.adv, 0)
      or u.penalty    <> u.legacy_penalty    + coalesce(aa.pen, 0);
  if bad > 0 then raise exception '계층 불변식 위반 %건 (points ≠ legacy + award) — ROLLBACK', bad; end if;

  -- 계획 밖 행 미접촉 검증은 "이 트랜잭션이 백업을 방금 떴을 때"만 엄격 적용한다.
  --   재실행(2회차)에서는 백업이 1회차 시점이라 그 사이의 정상 적립까지 차이로 잡히므로
  --   경고만 남긴다(이번 실행은 어차피 갱신 0행이라 아무것도 건드리지 않았다).
  select max(backed_up_at) > now() - interval '10 minutes' into backup_fresh from public.${BACKUP};

  select count(*) into touched
    from public.user_weekly_points u
    join public.${BACKUP} b on b.id = u.id
   where not exists (select 1 from public.${PLAN_TBL} p where p.uwp_id = u.id)
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
    if backup_fresh then
      raise exception '계획 밖 %행이 변경됨 — ROLLBACK', touched;
    else
      raise warning '계획 밖 %행이 백업 시점과 다름 — 재실행이라 이번 트랜잭션의 변경은 아님(갱신 0행). 확인 요망', touched;
    end if;
  end if;

  -- 행 삭제/삽입이 없어야 한다(초회 실행에 한해 엄격 — 재실행 시 정상 신규 행이 있을 수 있다)
  if backup_fresh and (select count(*) from public.user_weekly_points) <> (select count(*) from public.${BACKUP}) then
    raise exception 'uwp 행수 변동 — ROLLBACK';
  end if;

  raise notice '[verify] 통과 — 계획 ${N}행 일치 · 계획 밖 변경 % · 백업 신선도 %', touched, backup_fresh;
end $$;

-- 검증이 전부 통과했을 때만 여기 도달한다. 하나라도 raise 되면 트랜잭션 전체가 취소된다.
commit;

-- 실행 후 확인용(별도 실행):
--   select count(*) filter (where points<>0 or advantages<>0 or penalty<>0) as nonzero_rows,
--          sum(points) a, sum(advantages) raw_adv, sum(penalty) c
--     from public.user_weekly_points;
--   → 기대: ΣA ≈ ${SA} + (복구 전 ΣA), Σadv ≈ ${SADV} + (복구 전), Σpen ≈ ${SPEN} + (복구 전)
`;
  writeFileSync("db/migrations/2026-07-26_uwp_point_recovery_01_apply.sql", apply, "utf8");

  // ── 99. 롤백 ────────────────────────────────────────────────────
  const rollback = `-- 2026-07-26 uwp 포인트 복구 — STEP 99: 롤백 (STEP 01 이후 문제가 발견됐을 때만)
--
-- ${BACKUP} 는 STEP 01 이 복구 직전에 뜬 user_weekly_points 전량 사본이다.
-- 이 스크립트는 복구 대상 ${N}행의 points/advantages/penalty 를 그 사본 값으로 되돌린다.
-- (=§2 피해 상태인 0/0/0 로 회귀한다. "복구 이전"으로 되돌릴 뿐 데이터가 좋아지지 않는다.)

begin;

do $$
declare n_upd bigint;
begin
  if to_regclass('public.${BACKUP}') is null then
    raise exception '백업 표 ${BACKUP} 부재 — 롤백 불가';
  end if;

  update public.user_weekly_points u
     set points            = b.points,
         advantages        = b.advantages,
         penalty           = b.penalty,
         legacy_points     = b.legacy_points,
         legacy_advantages = b.legacy_advantages,
         legacy_penalty    = b.legacy_penalty,
         updated_at        = b.updated_at
    from public.${BACKUP} b
   where u.id = b.id
     and exists (select 1 from public.${PLAN_TBL} p where p.uwp_id = u.id)
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
`;
  writeFileSync("db/migrations/2026-07-26_uwp_point_recovery_99_rollback.sql", rollback, "utf8");

  console.log(`dry-run source : ${file}`);
  console.log(`복구 스코프    : ${N}행 / ${USERS}명 / ΣA ${SA} · Σadv ${SADV} · Σpen ${SPEN}`);
  console.log("생성:");
  console.log("  db/migrations/2026-07-26_uwp_point_recovery_00_baseline_backup.sql");
  console.log("  db/migrations/2026-07-26_uwp_point_recovery_01_apply.sql");
  console.log("  db/migrations/2026-07-26_uwp_point_recovery_99_rollback.sql");
  console.log("※ 어느 것도 실행되지 않았다. DB write 0.");
}

main();

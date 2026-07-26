/**
 * READ-ONLY 생성기 — dry-run 결과로부터 **실행하지 않는** 복구 SQL 세트를 파일로 출력한다.
 *   npx tsx --env-file=.env.local scripts/recover-uwp-emit-sql.ts
 * DB write 0 (파일 쓰기만).
 *
 * Supabase SQL Editor 의 쿼리 크기 제한("Query is too large to be run via the SQL Editor")을
 * 우회하기 위해 **staging 적재 → 검증 → 소형 apply** 3단 구조로 나눈다.
 * VALUES 목록을 임의로 잘라 여러 UPDATE 로 분산 실행하지 않는다 — 실제 UPDATE 는
 * 마지막 _40 한 파일이 **단일 트랜잭션**으로 한 번에 수행한다.
 *
 * 산출물(db/migrations/):
 *   2026-07-26_uwp_point_recovery_00_baseline_backup.sql   캐시/원본 사본 + manifest (선택)
 *   2026-07-26_uwp_recovery_10_create_staging.sql          staging + chunk manifest 생성
 *   2026-07-26_uwp_recovery_20_load_chunk_001..NNN.sql     계획 적재(ON CONFLICT 멱등)
 *   2026-07-26_uwp_recovery_30_verify_staging.sql          적재 완전성·정합 전수 검증
 *   2026-07-26_uwp_recovery_40_apply.sql                   단일 트랜잭션 실제 UPDATE
 *   2026-07-26_uwp_recovery_99_rollback.sql                백업표에서 역복원
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, statSync } from "fs";

type Row = {
  user_id: string; display_name: string; org: string; is_test: boolean; week_start_date: string; week_kind: string;
  year: number | null; week_number: number | null;
  cur_a: number; exp_a: number; cur_adv: number; exp_adv: number; cur_pen: number; exp_pen: number;
  checks_migrated: boolean; wiped: boolean; has_award: boolean; uwp_row_id: string | null;
};

const WIPE_TS = "2026-07-25 04:52:05.480492+00";
const BACKUP = "uwp_point_recovery_backup_20260726";
const STAGING = "uwp_recovery_staging_20260726";
const CHUNKMAN = "uwp_recovery_chunk_manifest_20260726";
const PREFIX = "db/migrations/2026-07-26_uwp_recovery_";
/** 청크당 행 수 — 파일당 ~170KB (SQL Editor 제한 대비 충분한 여유). */
const CHUNK = 1500;

function main() {
  const file = "claudedocs/" + readdirSync("claudedocs").filter((x) => x.startsWith("recover-uwp-dryrun-") && x.endsWith(".json")).sort().pop()!;
  const { rows } = JSON.parse(readFileSync(file, "utf8")) as { rows: Row[] };

  const scope = rows.filter(
    (r) => r.wiped && r.checks_migrated && !r.has_award && r.cur_a === 0 && r.cur_adv === 0 && r.cur_pen === 0 &&
      (r.exp_a !== 0 || r.exp_adv !== 0 || r.exp_pen !== 0),
  );
  if (scope.some((r) => !r.uwp_row_id)) throw new Error("uwp_row_id 누락 행 존재 — 생성 중단");
  if (scope.some((r) => r.cur_a !== 0 || r.cur_adv !== 0 || r.cur_pen !== 0)) throw new Error("pre 값이 0 이 아닌 행 존재 — 생성 중단");

  const N = scope.length;
  const SA = scope.reduce((s, r) => s + r.exp_a, 0);
  const SADV = scope.reduce((s, r) => s + r.exp_adv, 0);
  const SPEN = scope.reduce((s, r) => s + r.exp_pen, 0);
  const USERS = new Set(scope.map((r) => r.user_id)).size;

  mkdirSync("db/migrations", { recursive: true });

  // ── 청크 분할 ────────────────────────────────────────────────────
  const chunks: Row[][] = [];
  for (let i = 0; i < scope.length; i += CHUNK) chunks.push(scope.slice(i, i + CHUNK));
  const chunkStats = chunks.map((c, i) => ({
    no: i + 1,
    rows: c.length,
    a: c.reduce((s, r) => s + r.exp_a, 0),
    adv: c.reduce((s, r) => s + r.exp_adv, 0),
    pen: c.reduce((s, r) => s + r.exp_pen, 0),
  }));
  const NC = chunks.length;

  const HDR = (title: string, step: string) => `-- 2026-07-26 user_weekly_points 포인트 복구 — ${title}
--
-- 원인: db/migrations/2026-07-25_point_resolver_sot.sql §2 가 2026-07-25T04:52:05.480492Z 에
--   운영 DB 에서 실행되어, checks_migrated=true 이면서 활성 process_point_awards 가 없는
--   user_weekly_points 행을 전부 0 으로 덮었다(PMS·레거시 이관 포인트 소멸).
-- 복구 원천: public.legacy_point_ledger 재구성 — ${N}행 / ${USERS}명 / ΣA ${SA} · Σadv ${SADV} · Σpen ${SPEN}
--
-- ⚠ 실행 순서: 10 → 20(001~${String(NC).padStart(3, "0")}) → 30 → 40.  롤백은 99.
-- ⚠ 현재 단계: ${step}
`;

  // ── _10 staging 생성 ─────────────────────────────────────────────
  const s10 = `${HDR("STEP 10: staging + chunk manifest 생성", "10 (구조만 생성 · user_weekly_points 무접촉)")}
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

create table if not exists public.${STAGING} (
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

create index if not exists ${STAGING}_user_idx on public.${STAGING} (user_id);

-- 청크 적재 완전성 검증용 기대치(생성기가 dry-run 에서 산출).
create table if not exists public.${CHUNKMAN} (
  chunk_no         smallint primary key,
  expected_rows    integer not null,
  expected_sum_a   bigint  not null,
  expected_sum_adv bigint  not null,
  expected_sum_pen bigint  not null
);

insert into public.${CHUNKMAN} (chunk_no, expected_rows, expected_sum_a, expected_sum_adv, expected_sum_pen) values
${chunkStats.map((c) => ` (${c.no},${c.rows},${c.a},${c.adv},${c.pen})`).join(",\n")}
on conflict (chunk_no) do update
   set expected_rows = excluded.expected_rows,
       expected_sum_a = excluded.expected_sum_a,
       expected_sum_adv = excluded.expected_sum_adv,
       expected_sum_pen = excluded.expected_sum_pen;

do $$
declare n int; s_r bigint; s_a bigint;
begin
  select count(*), sum(expected_rows), sum(expected_sum_a) into n, s_r, s_a from public.${CHUNKMAN};
  raise notice '[staging] 표 생성 완료 · chunk manifest % 청크 · 기대 총행 % · 기대 ΣA %', n, s_r, s_a;
  if n <> ${NC} then raise exception 'chunk manifest 청크 수 % (기대 ${NC})', n; end if;
  if s_r <> ${N} then raise exception 'chunk manifest 총 행수 % (기대 ${N})', s_r; end if;
  if s_a <> ${SA} then raise exception 'chunk manifest ΣA % (기대 ${SA})', s_a; end if;
end $$;

commit;

-- 확인: [staging] 표 생성 완료 · chunk manifest ${NC} 청크 · 기대 총행 ${N} · 기대 ΣA ${SA}
`;
  writeFileSync(`${PREFIX}10_create_staging.sql`, s10, "utf8");

  // ── _20 청크 적재 ────────────────────────────────────────────────
  const chunkFiles: string[] = [];
  for (const [i, c] of chunks.entries()) {
    const no = i + 1;
    const st = chunkStats[i];
    const vals = c
      .map((r) => ` ('${r.uwp_row_id}','${r.user_id}','${r.week_start_date}',${r.exp_a},${r.exp_adv},${r.exp_pen},${r.cur_a},${r.cur_adv},${r.cur_pen},${no})`)
      .join(",\n");
    const body = `${HDR(`STEP 20: 복구 계획 적재 — 청크 ${no}/${NC}`, `20-${String(no).padStart(3, "0")} (staging 적재만 · user_weekly_points 무접촉)`)}
-- 이 청크: ${st.rows}행 · ΣA ${st.a} · Σadv ${st.adv} · Σpen ${st.pen}
-- 멱등: PK(uwp_id) ON CONFLICT DO UPDATE — 같은 청크를 몇 번 실행해도 행이 늘지 않고 값도 동일하다.
-- 순서 무관: 청크는 어떤 순서로 실행해도 되며, 전부 적재된 뒤 STEP 30 이 완전성을 검증한다.

begin;

insert into public.${STAGING}
  (uwp_id, user_id, week_start_date, points, advantages, penalty, pre_points, pre_advantages, pre_penalty, chunk_no) values
${vals}
on conflict (uwp_id) do update
   set user_id = excluded.user_id,
       week_start_date = excluded.week_start_date,
       points = excluded.points,
       advantages = excluded.advantages,
       penalty = excluded.penalty,
       pre_points = excluded.pre_points,
       pre_advantages = excluded.pre_advantages,
       pre_penalty = excluded.pre_penalty,
       chunk_no = excluded.chunk_no,
       loaded_at = now();

do $$
declare n int; s_a bigint; s_adv bigint; s_pen bigint; tot int;
begin
  select count(*), sum(points), sum(advantages), sum(penalty)
    into n, s_a, s_adv, s_pen from public.${STAGING} where chunk_no = ${no};
  select count(*) into tot from public.${STAGING};
  raise notice '[chunk ${no}/${NC}] 적재 %행 · ΣA % · Σadv % · Σpen % | staging 누적 %/${N}행', n, s_a, s_adv, s_pen, tot;
  if n     <> ${st.rows} then raise exception '청크 ${no} 행수 % (기대 ${st.rows})', n; end if;
  if s_a   <> ${st.a}    then raise exception '청크 ${no} ΣA % (기대 ${st.a})', s_a; end if;
  if s_adv <> ${st.adv}  then raise exception '청크 ${no} Σadv % (기대 ${st.adv})', s_adv; end if;
  if s_pen <> ${st.pen}  then raise exception '청크 ${no} Σpen % (기대 ${st.pen})', s_pen; end if;
end $$;

commit;

-- 확인: [chunk ${no}/${NC}] 적재 ${st.rows}행 · ΣA ${st.a} · Σadv ${st.adv} · Σpen ${st.pen}
`;
    const path = `${PREFIX}20_load_chunk_${String(no).padStart(3, "0")}.sql`;
    writeFileSync(path, body, "utf8");
    chunkFiles.push(path);
  }

  // ── _30 검증 ─────────────────────────────────────────────────────
  const s30 = `${HDR("STEP 30: staging 적재 완전성·정합 검증", "30 (읽기 전용 · 쓰기 0)")}
-- 이 파일은 SELECT 와 RAISE 만 수행한다. 어떤 표도 수정하지 않는다.
-- 하나라도 실패하면 exception 으로 중단되며, STEP 40 을 실행해서는 안 된다.

do $$
declare
  n bigint; nu bigint; s_a bigint; s_adv bigint; s_pen bigint;
  dup bigint; miss bigint; keybad bigint; prebad bigint; awardhit bigint;
  legbad bigint; chunkbad bigint; nochunk bigint;
begin
  -- ① 총 행수 / 사용자 수 / 합계
  select count(*), count(distinct user_id), sum(points), sum(advantages), sum(penalty)
    into n, nu, s_a, s_adv, s_pen from public.${STAGING};
  raise notice '[verify 1/8] staging 행 % · 사용자 % · ΣA % · Σadv % · Σpen %', n, nu, s_a, s_adv, s_pen;
  if n     <> ${N}     then raise exception '행수 % (기대 ${N}) — 청크 누락 의심', n; end if;
  if nu    <> ${USERS} then raise exception '사용자수 % (기대 ${USERS})', nu; end if;
  if s_a   <> ${SA}    then raise exception 'ΣA % (기대 ${SA})', s_a; end if;
  if s_adv <> ${SADV}  then raise exception 'Σadvantage % (기대 ${SADV})', s_adv; end if;
  if s_pen <> ${SPEN}  then raise exception 'Σpenalty % (기대 ${SPEN})', s_pen; end if;

  -- ② 청크 완전성(어느 청크가 빠졌는지 정확히 지목)
  select count(*) into nochunk
    from public.${CHUNKMAN} m
   where not exists (select 1 from public.${STAGING} s where s.chunk_no = m.chunk_no);
  if nochunk > 0 then
    raise exception '적재되지 않은 청크 %개 — 누락 청크: %', nochunk,
      (select string_agg(m.chunk_no::text, ', ' order by m.chunk_no) from public.${CHUNKMAN} m
        where not exists (select 1 from public.${STAGING} s where s.chunk_no = m.chunk_no));
  end if;
  select count(*) into chunkbad
    from public.${CHUNKMAN} m
    join (select chunk_no, count(*) r, sum(points) a, sum(advantages) adv, sum(penalty) p
            from public.${STAGING} group by chunk_no) s on s.chunk_no = m.chunk_no
   where s.r <> m.expected_rows or s.a <> m.expected_sum_a
      or s.adv <> m.expected_sum_adv or s.p <> m.expected_sum_pen;
  if chunkbad > 0 then raise exception '청크별 수치 불일치 %개 청크', chunkbad; end if;
  raise notice '[verify 2/8] 청크 완전성 OK — ${NC}개 청크 전부 적재·수치 일치';

  -- ③ 중복 PK
  select count(*) - count(distinct uwp_id) into dup from public.${STAGING};
  if dup <> 0 then raise exception '중복 uwp_id %건', dup; end if;
  raise notice '[verify 3/8] 중복 PK 0 OK';

  -- ④ 대상 행 실재 + 키 일치(행 뒤바뀜 차단)
  select count(*) into miss
    from public.${STAGING} s left join public.user_weekly_points u on u.id = s.uwp_id
   where u.id is null;
  if miss > 0 then raise exception 'user_weekly_points 에 없는 uwp_id %건', miss; end if;
  select count(*) into keybad
    from public.${STAGING} s join public.user_weekly_points u on u.id = s.uwp_id
   where u.user_id <> s.user_id or u.week_start_date <> s.week_start_date;
  if keybad > 0 then raise exception '행 키(user_id/week_start_date) 불일치 %건', keybad; end if;
  raise notice '[verify 4/8] 대상 행 실재·키 일치 OK';

  -- ⑤ pre 값 일치(현재 DB 가 dry-run 시점과 같은가) 또는 이미 복구된 상태
  select count(*) into prebad
    from public.${STAGING} s join public.user_weekly_points u on u.id = s.uwp_id
   where not (
        (u.points = s.pre_points and u.advantages = s.pre_advantages and u.penalty = s.pre_penalty and u.checks_migrated)
     or (u.points = s.points and u.advantages = s.advantages and u.penalty = s.penalty)
   );
  if prebad > 0 then raise exception 'pre 값 불일치 %건 — DB 가 dry-run 이후 변경됨. dry-run 재생성 필요', prebad; end if;
  raise notice '[verify 5/8] pre 값 불일치 0 OK';

  -- ⑥ active award 교집합(이중 원장 방지)
  select count(*) into awardhit
    from public.${STAGING} s join public.user_weekly_points u on u.id = s.uwp_id
   where exists (select 1 from public.process_point_awards a
                  where a.user_id = u.user_id and a.year = u.year and a.week_number = u.week_number
                    and a.cancelled_at is null);
  if awardhit > 0 then raise exception 'active award 교집합 %건 — 스코프 재계산 필요', awardhit; end if;
  raise notice '[verify 6/8] active award 교집합 0 OK';

  -- ⑦ 계층 정합(복구 전이면 legacy 도 pre 와 같아야 한다)
  select count(*) into legbad
    from public.${STAGING} s join public.user_weekly_points u on u.id = s.uwp_id
   where u.points = s.pre_points and u.advantages = s.pre_advantages and u.penalty = s.pre_penalty
     and (u.legacy_points is distinct from s.pre_points
       or u.legacy_advantages is distinct from s.pre_advantages
       or u.legacy_penalty is distinct from s.pre_penalty);
  if legbad > 0 then raise exception '복구 전 legacy 층 불일치 %건', legbad; end if;
  raise notice '[verify 7/8] 계층 정합 OK';

  -- ⑧ 값 위생
  if exists (select 1 from public.${STAGING} where penalty < 0) then
    raise exception 'penalty 음수 계획값 존재 — C 는 항상 양수 크기여야 한다';
  end if;
  if exists (select 1 from public.${STAGING} where pre_points <> 0 or pre_advantages <> 0 or pre_penalty <> 0) then
    raise exception 'pre_* 가 0 이 아닌 행 존재 — 스코프 정의 위반';
  end if;
  raise notice '[verify 8/8] 값 위생 OK';

  raise notice '[verify] ✅ 전 항목 통과 — STEP 40 실행 가능';
end $$;

-- 참고 출력(수동 확인용)
select
  (select count(*)              from public.${STAGING})                      as staging_rows,
  (select count(distinct user_id) from public.${STAGING})                    as staging_users,
  (select sum(points)           from public.${STAGING})                      as sum_a,
  (select sum(advantages)       from public.${STAGING})                      as sum_raw_advantage,
  (select sum(penalty)          from public.${STAGING})                      as sum_penalty,
  (select sum(points)           from public.user_weekly_points)              as uwp_sum_a_now,
  (select sum(advantages)       from public.user_weekly_points)              as uwp_sum_adv_now,
  (select sum(penalty)          from public.user_weekly_points)              as uwp_sum_pen_now;

-- 기대: staging_rows=${N} · staging_users=${USERS} · sum_a=${SA} · sum_raw_advantage=${SADV} · sum_penalty=${SPEN}
--       uwp_sum_a_now/adv/pen = 복구 전 값 (STEP 40 실행 후 각각 +${SA}/+${SADV}/+${SPEN})
`;
  writeFileSync(`${PREFIX}30_verify_staging.sql`, s30, "utf8");

  // ── _40 apply ────────────────────────────────────────────────────
  const s40 = `${HDR("STEP 40: 본 복구 (단일 트랜잭션)", "40 (실제 UPDATE — 되돌리려면 99)")}
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
  if to_regclass('public.${STAGING}') is null then
    raise exception 'staging 표 부재 — STEP 10/20 먼저 실행할 것';
  end if;
  if (select count(*) from information_schema.columns
       where table_schema='public' and table_name='user_weekly_points'
         and column_name in ('legacy_points','legacy_advantages','legacy_penalty')) <> 3 then
    raise exception '계층 분리 컬럼(legacy_*) 미적용 — 2026-07-26_uwp_legacy_baseline_columns.sql 먼저 적용할 것';
  end if;
end $$;

-- ── 1) 백업 (전체 uwp 사본 — 롤백 원천. 이미 있으면 보존) ─────────────
create table if not exists public.${BACKUP} as
select *, now() as backed_up_at from public.user_weekly_points;

do $$
declare n bigint;
begin
  select count(*) into n from public.${BACKUP};
  raise notice '[backup] ${BACKUP} rows=%', n;
  if n = 0 then raise exception '백업 표가 비어 있다 — 중단'; end if;
end $$;

-- ── 2) 계획·대상 재검증 (STEP 30 과 동일 게이트) ──────────────────────
do $$
declare n bigint; nu bigint; s_a bigint; s_adv bigint; s_pen bigint; bad bigint; nochunk bigint;
begin
  select count(*), count(distinct user_id), sum(points), sum(advantages), sum(penalty)
    into n, nu, s_a, s_adv, s_pen from public.${STAGING};
  raise notice '[plan] rows=% users=% ΣA=% Σadv=% Σpen=%', n, nu, s_a, s_adv, s_pen;
  if n     <> ${N}     then raise exception '계획 행수 % (기대 ${N})', n; end if;
  if nu    <> ${USERS} then raise exception '계획 사용자수 % (기대 ${USERS})', nu; end if;
  if s_a   <> ${SA}    then raise exception '계획 ΣA % (기대 ${SA})', s_a; end if;
  if s_adv <> ${SADV}  then raise exception '계획 Σadvantage % (기대 ${SADV})', s_adv; end if;
  if s_pen <> ${SPEN}  then raise exception '계획 Σpenalty % (기대 ${SPEN})', s_pen; end if;

  select count(*) into nochunk from public.${CHUNKMAN} m
   where not exists (select 1 from public.${STAGING} s where s.chunk_no = m.chunk_no);
  if nochunk > 0 then raise exception '미적재 청크 %개 — STEP 20 미완료', nochunk; end if;

  if exists (select 1 from public.${STAGING} where penalty < 0) then
    raise exception 'penalty 음수 계획값 존재'; end if;
  if exists (select 1 from public.${STAGING} where pre_points <> 0 or pre_advantages <> 0 or pre_penalty <> 0) then
    raise exception 'pre_* 가 0 이 아닌 행 존재'; end if;

  select count(*) into bad from public.${STAGING} s
    left join public.user_weekly_points u on u.id = s.uwp_id where u.id is null;
  if bad > 0 then raise exception 'uwp 행 부재 %건', bad; end if;

  select count(*) into bad from public.${STAGING} s
    join public.user_weekly_points u on u.id = s.uwp_id
   where u.user_id <> s.user_id or u.week_start_date <> s.week_start_date;
  if bad > 0 then raise exception '행 키 불일치 %건', bad; end if;

  select count(*) into bad from public.${STAGING} s
    join public.user_weekly_points u on u.id = s.uwp_id
   where not (
        (u.points = s.pre_points and u.advantages = s.pre_advantages and u.penalty = s.pre_penalty and u.checks_migrated)
     or (u.points = s.points and u.advantages = s.advantages and u.penalty = s.penalty));
  if bad > 0 then raise exception '대상 상태가 dry-run 과 다름 %건 — 덮어쓰기 금지', bad; end if;

  select count(*) into bad from public.${STAGING} s
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
    from public.${STAGING} s
   where u.id = s.uwp_id
     and (u.points <> s.points or u.advantages <> s.advantages or u.penalty <> s.penalty
       or u.legacy_points is distinct from s.points
       or u.legacy_advantages is distinct from s.advantages
       or u.legacy_penalty is distinct from s.penalty);
  get diagnostics n_upd = row_count;
  raise notice '[update] 갱신 %행 (초회 기대 ${N} · 재실행 기대 0)', n_upd;
  if n_upd <> ${N} and n_upd <> 0 then
    raise exception '갱신 행수 % 가 기대(${N} 또는 0)와 다름 — ROLLBACK', n_upd;
  end if;

  select sum(points), sum(advantages), sum(penalty) into a1, adv1, pen1 from public.user_weekly_points;
  raise notice '[after]  uwp 전체 ΣA=% Σadv=% Σpen=%', a1, adv1, pen1;
  raise notice '[delta]  ΔA=% Δadv=% Δpen=% (초회 기대 ${SA}/${SADV}/${SPEN})', a1-a0, adv1-adv0, pen1-pen0;
  if n_upd = ${N} and (a1-a0 <> ${SA} or adv1-adv0 <> ${SADV} or pen1-pen0 <> ${SPEN}) then
    raise exception '증분 합계 불일치 (ΔA=% Δadv=% Δpen=%) — ROLLBACK', a1-a0, adv1-adv0, pen1-pen0;
  end if;
end $$;

-- ── 4) 사후 검증 ────────────────────────────────────────────────────
do $$
declare bad bigint; touched bigint; backup_fresh boolean;
begin
  select count(*) into bad
    from public.${STAGING} s join public.user_weekly_points u on u.id = s.uwp_id
   where u.points <> s.points or u.advantages <> s.advantages or u.penalty <> s.penalty;
  if bad > 0 then raise exception '사후 불일치 %건 — ROLLBACK', bad; end if;

  -- 계층 불변식: points = legacy + Σ활성 award
  select count(*) into bad
    from public.${STAGING} s
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
  select max(backed_up_at) > now() - interval '10 minutes' into backup_fresh from public.${BACKUP};
  select count(*) into touched
    from public.user_weekly_points u join public.${BACKUP} b on b.id = u.id
   where not exists (select 1 from public.${STAGING} s where s.uwp_id = u.id)
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

  if backup_fresh and (select count(*) from public.user_weekly_points) <> (select count(*) from public.${BACKUP}) then
    raise exception 'uwp 행수 변동 — ROLLBACK';
  end if;

  raise notice '[verify] 통과 — 계획 ${N}행 일치 · 계층 불변식 OK · 계획 밖 변경 %', touched;
end $$;

commit;

-- 기대 최종값(별도 실행으로 확인):
--   select count(*) rows, sum(points) a, sum(advantages) raw_adv, sum(penalty) c from public.user_weekly_points;
--   → rows 14581 · a 474277 · raw_adv 39766 · c 22525
`;
  writeFileSync(`${PREFIX}40_apply.sql`, s40, "utf8");

  // ── _99 rollback ─────────────────────────────────────────────────
  const s99 = `${HDR("STEP 99: 롤백", "99 (STEP 40 이후 문제 발견 시에만)")}
-- ${BACKUP} 는 STEP 40 이 복구 직전에 뜬 user_weekly_points 전량 사본이다.
-- staging 에 등재된 ${N}행의 points/advantages/penalty/legacy_* 를 그 사본 값으로 되돌린다.
-- (= §2 피해 상태인 0/0/0 으로 회귀한다. "복구 이전" 으로 되돌릴 뿐 데이터가 좋아지지 않는다.)

begin;

do $$
declare n_upd bigint;
begin
  if to_regclass('public.${BACKUP}') is null then
    raise exception '백업 표 ${BACKUP} 부재 — 롤백 불가'; end if;
  if to_regclass('public.${STAGING}') is null then
    raise exception 'staging 표 부재 — 롤백 대상 특정 불가'; end if;

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
     and exists (select 1 from public.${STAGING} s where s.uwp_id = u.id)
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
--   drop table if exists public.${STAGING};
--   drop table if exists public.${CHUNKMAN};
--   drop table if exists public.${BACKUP};
`;
  writeFileSync(`${PREFIX}99_rollback.sql`, s99, "utf8");

  // 구 단일 파일 제거(초대형 · SQL Editor 실행 불가)
  for (const old of [
    "db/migrations/2026-07-26_uwp_point_recovery_01_apply.sql",
    "db/migrations/2026-07-26_uwp_point_recovery_99_rollback.sql",
  ]) if (existsSync(old)) unlinkSync(old);

  // ── 리포트 ───────────────────────────────────────────────────────
  const emitted = [`${PREFIX}10_create_staging.sql`, ...chunkFiles, `${PREFIX}30_verify_staging.sql`, `${PREFIX}40_apply.sql`, `${PREFIX}99_rollback.sql`];
  console.log(`dry-run source : ${file}`);
  console.log(`복구 스코프    : ${N}행 / ${USERS}명 / ΣA ${SA} · Σadv ${SADV} · Σpen ${SPEN}`);
  console.log(`청크           : ${NC}개 × 최대 ${CHUNK}행\n`);
  let max = 0;
  for (const f of emitted) {
    const kb = statSync(f).size / 1024;
    max = Math.max(max, kb);
    console.log(`  ${kb.toFixed(1).padStart(8)} KB  ${f}`);
  }
  console.log(`\n최대 파일 크기 : ${max.toFixed(1)} KB ${max < 500 ? "✅ SQL Editor 실행 가능" : "⚠ 재분할 필요"}`);
  console.log("※ 어느 것도 실행되지 않았다. DB write 0.");
}

main();

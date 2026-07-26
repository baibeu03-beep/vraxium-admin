-- 2026-07-26 user_weekly_points 포인트 복구 — STEP 30: staging 적재 완전성·정합 검증
--
-- 원인: db/migrations/2026-07-25_point_resolver_sot.sql §2 가 2026-07-25T04:52:05.480492Z 에
--   운영 DB 에서 실행되어, checks_migrated=true 이면서 활성 process_point_awards 가 없는
--   user_weekly_points 행을 전부 0 으로 덮었다(PMS·레거시 이관 포인트 소멸).
-- 복구 원천: public.legacy_point_ledger 재구성 — 11508행 / 629명 / ΣA 449474 · Σadv 30810 · Σpen 18891
--
-- ⚠ 실행 순서: 10 → 20(001~008) → 30 → 40.  롤백은 99.
-- ⚠ 현재 단계: 30 (읽기 전용 · 쓰기 0)

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
    into n, nu, s_a, s_adv, s_pen from public.uwp_recovery_staging_20260726;
  raise notice '[verify 1/8] staging 행 % · 사용자 % · ΣA % · Σadv % · Σpen %', n, nu, s_a, s_adv, s_pen;
  if n     <> 11508     then raise exception '행수 % (기대 11508) — 청크 누락 의심', n; end if;
  if nu    <> 629 then raise exception '사용자수 % (기대 629)', nu; end if;
  if s_a   <> 449474    then raise exception 'ΣA % (기대 449474)', s_a; end if;
  if s_adv <> 30810  then raise exception 'Σadvantage % (기대 30810)', s_adv; end if;
  if s_pen <> 18891  then raise exception 'Σpenalty % (기대 18891)', s_pen; end if;

  -- ② 청크 완전성(어느 청크가 빠졌는지 정확히 지목)
  select count(*) into nochunk
    from public.uwp_recovery_chunk_manifest_20260726 m
   where not exists (select 1 from public.uwp_recovery_staging_20260726 s where s.chunk_no = m.chunk_no);
  if nochunk > 0 then
    raise exception '적재되지 않은 청크 %개 — 누락 청크: %', nochunk,
      (select string_agg(m.chunk_no::text, ', ' order by m.chunk_no) from public.uwp_recovery_chunk_manifest_20260726 m
        where not exists (select 1 from public.uwp_recovery_staging_20260726 s where s.chunk_no = m.chunk_no));
  end if;
  select count(*) into chunkbad
    from public.uwp_recovery_chunk_manifest_20260726 m
    join (select chunk_no, count(*) r, sum(points) a, sum(advantages) adv, sum(penalty) p
            from public.uwp_recovery_staging_20260726 group by chunk_no) s on s.chunk_no = m.chunk_no
   where s.r <> m.expected_rows or s.a <> m.expected_sum_a
      or s.adv <> m.expected_sum_adv or s.p <> m.expected_sum_pen;
  if chunkbad > 0 then raise exception '청크별 수치 불일치 %개 청크', chunkbad; end if;
  raise notice '[verify 2/8] 청크 완전성 OK — 8개 청크 전부 적재·수치 일치';

  -- ③ 중복 PK
  select count(*) - count(distinct uwp_id) into dup from public.uwp_recovery_staging_20260726;
  if dup <> 0 then raise exception '중복 uwp_id %건', dup; end if;
  raise notice '[verify 3/8] 중복 PK 0 OK';

  -- ④ 대상 행 실재 + 키 일치(행 뒤바뀜 차단)
  select count(*) into miss
    from public.uwp_recovery_staging_20260726 s left join public.user_weekly_points u on u.id = s.uwp_id
   where u.id is null;
  if miss > 0 then raise exception 'user_weekly_points 에 없는 uwp_id %건', miss; end if;
  select count(*) into keybad
    from public.uwp_recovery_staging_20260726 s join public.user_weekly_points u on u.id = s.uwp_id
   where u.user_id <> s.user_id or u.week_start_date <> s.week_start_date;
  if keybad > 0 then raise exception '행 키(user_id/week_start_date) 불일치 %건', keybad; end if;
  raise notice '[verify 4/8] 대상 행 실재·키 일치 OK';

  -- ⑤ pre 값 일치(현재 DB 가 dry-run 시점과 같은가) 또는 이미 복구된 상태
  select count(*) into prebad
    from public.uwp_recovery_staging_20260726 s join public.user_weekly_points u on u.id = s.uwp_id
   where not (
        (u.points = s.pre_points and u.advantages = s.pre_advantages and u.penalty = s.pre_penalty and u.checks_migrated)
     or (u.points = s.points and u.advantages = s.advantages and u.penalty = s.penalty)
   );
  if prebad > 0 then raise exception 'pre 값 불일치 %건 — DB 가 dry-run 이후 변경됨. dry-run 재생성 필요', prebad; end if;
  raise notice '[verify 5/8] pre 값 불일치 0 OK';

  -- ⑥ active award 교집합(이중 원장 방지)
  select count(*) into awardhit
    from public.uwp_recovery_staging_20260726 s join public.user_weekly_points u on u.id = s.uwp_id
   where exists (select 1 from public.process_point_awards a
                  where a.user_id = u.user_id and a.year = u.year and a.week_number = u.week_number
                    and a.cancelled_at is null);
  if awardhit > 0 then raise exception 'active award 교집합 %건 — 스코프 재계산 필요', awardhit; end if;
  raise notice '[verify 6/8] active award 교집합 0 OK';

  -- ⑦ 계층 정합(복구 전이면 legacy 도 pre 와 같아야 한다)
  select count(*) into legbad
    from public.uwp_recovery_staging_20260726 s join public.user_weekly_points u on u.id = s.uwp_id
   where u.points = s.pre_points and u.advantages = s.pre_advantages and u.penalty = s.pre_penalty
     and (u.legacy_points is distinct from s.pre_points
       or u.legacy_advantages is distinct from s.pre_advantages
       or u.legacy_penalty is distinct from s.pre_penalty);
  if legbad > 0 then raise exception '복구 전 legacy 층 불일치 %건', legbad; end if;
  raise notice '[verify 7/8] 계층 정합 OK';

  -- ⑧ 값 위생
  if exists (select 1 from public.uwp_recovery_staging_20260726 where penalty < 0) then
    raise exception 'penalty 음수 계획값 존재 — C 는 항상 양수 크기여야 한다';
  end if;
  if exists (select 1 from public.uwp_recovery_staging_20260726 where pre_points <> 0 or pre_advantages <> 0 or pre_penalty <> 0) then
    raise exception 'pre_* 가 0 이 아닌 행 존재 — 스코프 정의 위반';
  end if;
  raise notice '[verify 8/8] 값 위생 OK';

  raise notice '[verify] ✅ 전 항목 통과 — STEP 40 실행 가능';
end $$;

-- 참고 출력(수동 확인용)
select
  (select count(*)              from public.uwp_recovery_staging_20260726)                      as staging_rows,
  (select count(distinct user_id) from public.uwp_recovery_staging_20260726)                    as staging_users,
  (select sum(points)           from public.uwp_recovery_staging_20260726)                      as sum_a,
  (select sum(advantages)       from public.uwp_recovery_staging_20260726)                      as sum_raw_advantage,
  (select sum(penalty)          from public.uwp_recovery_staging_20260726)                      as sum_penalty,
  (select sum(points)           from public.user_weekly_points)              as uwp_sum_a_now,
  (select sum(advantages)       from public.user_weekly_points)              as uwp_sum_adv_now,
  (select sum(penalty)          from public.user_weekly_points)              as uwp_sum_pen_now;

-- 기대: staging_rows=11508 · staging_users=629 · sum_a=449474 · sum_raw_advantage=30810 · sum_penalty=18891
--       uwp_sum_a_now/adv/pen = 복구 전 값 (STEP 40 실행 후 각각 +449474/+30810/+18891)

-- 2026-06-25_members_info_stats_aggregate.sql
-- 멤버 관리 > 크루 정보 탭 [섹션.1] 주차별 집계 — DB측 jsonb unnest·투영 함수(성능).
--
-- 배경: loadMembersInfoStats 가 cluster4_weekly_card_snapshots.cards(fat jsonb, ~600크루 ×
--   수십KB ≈ 30MB)를 전수 서버로 전송해 통합 탭이 38~49초였다(대역폭 병목). 집계에 필요한
--   스칼라(주차ID·주차상태·강화분모·주차성장률·별점)만 DB에서 unnest·투영해 전송량을 ~1MB로 줄인다.
--
-- ⚠ snapshot-only: 두 함수 모두 읽기 전용(STABLE). snapshot 재계산/생성/변경 없음 — cards 원본 무접촉.
-- ⚠ 동작 불변: 앱은 동일 스칼라 행을 받아 기존과 똑같은 JS 집계 루프를 돈다(값·DTO 동일).
--   SQL 에서 합계/정렬/콜레이션을 하지 않으므로(투영만) 부동소수/한글정렬 parity 위험이 없다.
-- ⚠ PostgREST max-rows(1000) 때문에 card_rows 는 앱에서 .range() 페이지네이션으로 전 행을 읽는다.
--
-- Supabase SQL Editor 에서 그대로 실행. CREATE OR REPLACE — 재실행 안전(idempotent).

-- 1) 주차 카드 스칼라 행 — (대상 사용자 × 표시 주차)의 카드별 1행, 집계에 필요한 필드만.
--   ⚠ 성능: 대상 사용자를 "먼저" 필터(picked CTE, user_id 유니크 인덱스)한 뒤 그 행만 unnest 해야
--     한다. unnest 를 먼저 하면(plan B) 매 호출마다 전체 snapshot 의 fat cards(전 사용자)를 풀어
--     읽어 statement timeout 이 난다. AS MATERIALIZED 로 필터-먼저(plan A)를 고정한다.
create or replace function public.members_info_stats_card_rows(
  p_user_ids uuid[],
  p_week_ids text[]
)
returns table (
  user_id uuid,
  week_id text,
  user_week_status text,
  growth_denominator numeric,
  weekly_growth_rate numeric,
  -- 포인트 종류별 합계용(Po.A/B/C). points 객체를 그대로 투영(snapshot SoT):
  --   star=A포인트(points) · shield=advantage−penalty(net) · lightning=−penalty.
  --   앱이 poA=Σstar · poB=Σshield−Σlightning(=Σadvantage) · poC=−Σlightning(=Σpenalty) 로 합산.
  star numeric,
  shield numeric,
  lightning numeric
)
language sql
stable
as $$
  with picked as materialized (
    select s.user_id, s.cards
    from public.cluster4_weekly_card_snapshots s
    where s.user_id = any(p_user_ids)
      and jsonb_typeof(s.cards) = 'array'
  )
  select
    p.user_id,
    (card.value ->> 'weekId')                                as week_id,
    (card.value ->> 'userWeekStatus')                        as user_week_status,
    nullif(card.value ->> 'growthDenominator', '')::numeric  as growth_denominator,
    nullif(card.value ->> 'weeklyGrowthRate', '')::numeric   as weekly_growth_rate,
    nullif(card.value #>> '{points,star}', '')::numeric      as star,
    nullif(card.value #>> '{points,shield}', '')::numeric    as shield,
    nullif(card.value #>> '{points,lightning}', '')::numeric as lightning
  from picked p
  cross join lateral jsonb_array_elements(p.cards) as card(value)
  where p_week_ids is null
    or array_length(p_week_ids, 1) is null
    or (card.value ->> 'weekId') = any(p_week_ids);
$$;

-- 2) 유효 snapshot 보유자(cards 가 배열인 행 — 빈 배열 포함). 앱이 snapshotUnavailable 산정에 사용.
--    (cards 미보유/비배열 = 미반환 → 호출부에서 "snapshot 미조회"로 집계.)
create or replace function public.members_info_stats_valid_users(
  p_user_ids uuid[]
)
returns table (user_id uuid)
language sql
stable
as $$
  select s.user_id
  from public.cluster4_weekly_card_snapshots s
  where s.user_id = any(p_user_ids)
    and jsonb_typeof(s.cards) = 'array';
$$;

-- ⚠ 함수 생성/변경 직후 PostgREST 스키마 캐시를 갱신해야 RPC 가 즉시 resolve 된다.
--   (캐시가 stale 이면 PGRST202 "could not find the function ... in the schema cache" 로 fat 폴백 →
--    fat cards 전수 read 가 statement timeout/부분조회를 일으킨다. 2026-06-25 실측·정정.)
notify pgrst, 'reload schema';

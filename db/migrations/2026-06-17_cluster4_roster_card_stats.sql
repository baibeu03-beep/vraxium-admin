-- /admin/members 크루 목록 전용 slim 캐시 — weekly-cards snapshot 에서 파생되는 스칼라만 저장.
-- ─────────────────────────────────────────────────────────────────────
-- 목적: roster 조회 시 사용자별 fat cards jsonb(수십 KB×N)를 읽지 않고, 필요한 값만 .in() 로
--   가볍게 읽어 응답 속도를 낮춘다. 값은 전적으로 weekly-cards snapshot(고객 SoT)에서 파생된다.
--   (lib/rosterCardStats.deriveRosterCardStats — getGrowthRosterBatch/computeActivityCompletion 동일 산식)
--
-- 채움(SoT 동기):
--   - 쓰기: recomputeAndStoreWeeklyCardsSnapshot 이 카드 생성 직후 이 표를 함께 upsert
--           (snapshot_computed_at = 그 snapshot 의 computed_at — drift 가드).
--   - 백필: scripts/backfill-roster-card-stats.ts (기존 snapshot 카드에서 파생, snapshot 무변경).
--   - 읽기: getGrowthRosterBatchFast 가 (dto_version 일치 AND snapshot_computed_at 일치) 인 행만 신뢰,
--           아니면 그 사용자만 fat 경로로 폴백 → 값 정합 보장(슬림이 stale/누락이어도 정확).
--
-- ⚠ 수동 적용: Supabase SQL Editor 에서 실행(프로젝트 관례 — exec_sql/직접연결 부재).
-- ⚠ 적용 후 1회 backfill 권장. 미적용/미백필이어도 코드는 fat 경로로 정상 동작(무중단).
-- ⚠ user_id 단일 키 — org/mode/demo 무관(값은 사용자 내재 지표). 스코프 분기는 호출부(listAdminCrewDtos)에서.

create table if not exists public.cluster4_roster_card_stats (
  user_id              uuid primary key,
  dto_version          smallint    not null,
  snapshot_computed_at timestamptz not null,
  success_weeks        smallint    not null default 0,
  growable_weeks       smallint    not null default 0,
  elapsed_weeks        smallint    not null default 0,
  activity_available   smallint    not null default 0,
  activity_completed   smallint    not null default 0,
  updated_at           timestamptz not null default now()
);

-- 서비스 롤 전용(고객/anon 차단) — 기존 cluster4_* 파생 캐시와 동일 정책.
alter table public.cluster4_roster_card_stats enable row level security;

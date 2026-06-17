-- /admin/members 크루 목록 slim 캐시 확장 — 일정 신뢰도 + 누적 포인트(Po.A/B/C)를 함께 저장.
-- ─────────────────────────────────────────────────────────────────────
-- 배경: 2026-06-17_cluster4_roster_card_stats.sql 가 성장(a/e/h)·활동완료율 스칼라를 slim 으로
--   내렸지만, roster 읽기 경로엔 여전히 (1) 일정 신뢰도(user_week_statuses 스캔) (2) Po.A/B/C
--   (user_weekly_points 합산) 두 live 배치가 남아 9초 병목의 주원인이었다. 이 둘을 같은
--   weekly-cards snapshot 재계산 시점에 같은 SoT 에서 함께 파생·저장해 읽기 경로에서 제거한다.
--
-- 값 정의(라이브와 1:1 동일 — drift 가드로 보장):
--   schedule_rate : 일정 신뢰도(%) 정수. = lib/scheduleReliabilityCore (getScheduleReliabilityRateBatch
--                   동일 산식). activity_started_at 부재 등 산정 불가 = NULL(표 "—").
--   po_a/po_b/po_c: 전체기간 누적 SUM(points/advantages/penalty) = adminMembersData.sumPointsForUsers
--                   동일 기준(check/advantage/penalty 원시 합). 미참여 = 0.
--
-- 채움(SoT 동기):
--   - 쓰기: recomputeAndStoreWeeklyCardsSnapshot → writeRosterCardStats 가 카드 저장 직후 함께 upsert
--           (snapshot_computed_at = 그 snapshot 의 computed_at — 기존 drift 가드 재사용).
--   - 백필: scripts/backfill-roster-card-stats.ts (schedule/points 도 함께 파생).
--   - 읽기: adminMembersData.getRosterPointsScheduleFast 가 (dto_version 일치 AND snapshot_computed_at
--           일치) 인 행만 신뢰, 아니면 그 사용자만 live(getScheduleReliabilityRateBatch/sumPointsForUsers)
--           로 폴백 → 값 정합 보장(슬림 stale/누락/미적용이어도 정확).
--
-- ⚠ 수동 적용: Supabase SQL Editor 에서 실행(프로젝트 관례).
-- ⚠ 적용 후 1회 backfill 권장. 미적용/미백필이어도 코드는 live 폴백으로 정상 동작(무중단·정합).
-- ⚠ 컬럼 부재 시: 읽기 reader 가 try/catch 로 전체 live 폴백(성장 slim 읽기와 분리되어 회귀 없음).

alter table public.cluster4_roster_card_stats
  add column if not exists schedule_rate smallint,            -- 일정 신뢰도(%) · NULL=산정 불가
  add column if not exists po_a          integer not null default 0,  -- SUM(points)
  add column if not exists po_b          integer not null default 0,  -- SUM(advantages)
  add column if not exists po_c          integer not null default 0;  -- SUM(penalty)

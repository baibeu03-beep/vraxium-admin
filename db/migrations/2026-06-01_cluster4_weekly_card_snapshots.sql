-- 2026-06-01_cluster4_weekly_card_snapshots.sql
-- 주차 카드 사전 계산 결과 저장(snapshot) 테이블.
--
-- 배경:
--   /api/cluster4/weekly-cards 가 요청마다 getWeeklyGrowth/computeWeeklyCards/
--   fetchLineDetailsByWeek 등 ~37개 live 쿼리 + in-memory 계산을 실시간 수행 → Vercel 504.
--   화면 조회 API는 "사전 계산된 카드 배열만 SELECT" 하도록 전환하고, 계산은 관리자 저장/sync/
--   cron 시점에만 수행한다. 본 테이블이 그 저장소다.
--
-- 구조:
--   - user_id 1행 = 그 사용자의 Cluster4WeeklyCardDto[] 전체(누적·시즌율 baked-in)를 JSONB 로 보관.
--     (API 가 사용자당 카드 배열 전체를 반환하므로 per-user 단일 행이 읽기 패턴과 1:1.)
--   - cards: lib/cluster4WeeklyCardsData.ts 가 만드는 DTO 배열을 그대로 직렬화.
--   - dto_version: DTO 스키마가 바뀌면 코드 상수(WEEKLY_CARDS_DTO_VERSION)를 올려 구버전 snapshot 을
--     자동 무효화(miss 처리 → 재계산)한다.
--   - is_stale: 입력(라인/제출/평가/주차상태) 변경 또는 현재주 시간경과로 재계산이 필요함을 표시.
--     읽기 경로는 stale 여도 "기존 값 계속 노출"(정책) 하되 로그만 남기고, cron/훅이 재계산한다.
--   - computed_at: 마지막 재계산 시각(stale 판단/모니터링용).
--
-- 비범위(다음 단계):
--   - 관리자 저장/sync 훅에서의 즉시 재계산, Vercel Cron 주기 재계산은 별도 단계.
--     본 migration 은 그 구조(컬럼)만 열어둔다.
--
-- 재실행 안전: CREATE TABLE/INDEX IF NOT EXISTS, DROP TRIGGER IF EXISTS.

BEGIN;

CREATE TABLE IF NOT EXISTS public.cluster4_weekly_card_snapshots (
  user_id      uuid        PRIMARY KEY
               REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  cards        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  card_count   integer     NOT NULL DEFAULT 0,
  dto_version  integer     NOT NULL DEFAULT 1,
  is_stale     boolean     NOT NULL DEFAULT false,
  computed_at  timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cluster4_weekly_card_snapshots_cards_is_array_chk
    CHECK (jsonb_typeof(cards) = 'array')
);

-- cron/배치가 "재계산 대상(stale 또는 오래된)" 을 빠르게 스캔하기 위한 보조 인덱스.
CREATE INDEX IF NOT EXISTS cluster4_weekly_card_snapshots_stale_idx
  ON public.cluster4_weekly_card_snapshots (is_stale);
CREATE INDEX IF NOT EXISTS cluster4_weekly_card_snapshots_computed_at_idx
  ON public.cluster4_weekly_card_snapshots (computed_at);

DROP TRIGGER IF EXISTS cluster4_weekly_card_snapshots_set_updated_at
  ON public.cluster4_weekly_card_snapshots;

CREATE TRIGGER cluster4_weekly_card_snapshots_set_updated_at
BEFORE UPDATE ON public.cluster4_weekly_card_snapshots
FOR EACH ROW
EXECUTE FUNCTION public.touch_cluster4_updated_at();

-- ⚠ 접근 제어(의도적으로 service_role 전용):
--   본 테이블은 "전체 사용자"의 주차 카드(팀/포인트/성장 등)를 user 당 1행으로 모아 보관한다.
--   /api/cluster4/weekly-cards 는 service_role(supabaseAdmin)로 읽으므로 anon/authenticated 에
--   SELECT 를 줄 필요가 없다. 공개 anon 키로 전체 사용자 데이터가 노출되는 것을 막기 위해
--   anon/authenticated GRANT 를 부여하지 않고, RLS 를 켜서 기본 거부로 둔다.
--   (service_role 은 RLS 를 우회하므로 API/백필/Cron 은 정상 동작. 형제 테이블이 anon SELECT 를
--    부여한 것과 의도적으로 다르다 — 집계 테이블의 cross-user 노출 위험 때문.)
ALTER TABLE public.cluster4_weekly_card_snapshots ENABLE ROW LEVEL SECURITY;
-- 정책을 만들지 않는다 → anon/authenticated 는 행을 전혀 볼 수 없다(deny-by-default).
REVOKE ALL ON public.cluster4_weekly_card_snapshots FROM anon, authenticated;

COMMENT ON TABLE public.cluster4_weekly_card_snapshots
  IS '주차 카드 사전 계산 결과(snapshot). user_id 1행 = Cluster4WeeklyCardDto[] 전체. 화면 조회 API는 이 테이블만 SELECT, 계산은 관리자 저장/sync/cron 시점에만.';
COMMENT ON COLUMN public.cluster4_weekly_card_snapshots.cards
  IS 'Cluster4WeeklyCardDto[] 직렬화(JSONB). 누적/시즌율 baked-in.';
COMMENT ON COLUMN public.cluster4_weekly_card_snapshots.dto_version
  IS 'DTO 스키마 버전. 코드 WEEKLY_CARDS_DTO_VERSION 과 불일치 시 읽기에서 miss 처리(재계산).';
COMMENT ON COLUMN public.cluster4_weekly_card_snapshots.is_stale
  IS '재계산 필요 표시. 읽기는 stale 여도 노출(로그만), cron/훅이 재계산.';
COMMENT ON COLUMN public.cluster4_weekly_card_snapshots.computed_at
  IS '마지막 재계산 시각. stale 판단/모니터링용.';

COMMIT;

-- ============================================================
-- ROLLBACK (필요 시)
-- ============================================================
/*
BEGIN;
DROP TABLE IF EXISTS public.cluster4_weekly_card_snapshots;
COMMIT;
*/

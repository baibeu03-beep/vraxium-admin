-- 프로세스 체크 포인트 적립 원장(ledger) — 멱등 적립의 SoT.
-- ─────────────────────────────────────────────────────────────────────
-- 정규/비정규 프로세스 체크가 completed 되면, 대상자(process_check_review_recipients)별로
-- 한 행씩 적립을 기록한다. user_weekly_points 는 이 원장의 (user, year, week) 합으로 재계산한다
-- (증분 금지 — 재계산만 → worker 재실행/재완료/재검수 멱등). 취소/삭제 = 원장 행 제거 후 재계산.
--
-- 매핑:
--   정규  ref_id = process_check_statuses.id, 포인트 = process_acts(point_check/advantage/penalty)
--   비정규 ref_id = process_irregular_acts.id,  포인트 = point_a/b/c
--   point_check→user_weekly_points.points / point_advantage→advantages / point_penalty→penalty
--   year/week_number = weeks.iso_year/iso_week (user_weekly_points 키와 동일 축)
--
-- era 경계(코드 lib/processPointAccrual.ts isAccrualAllowed):
--   operating : 2026-summer W1(CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM) 이후 주차만
--   test      : 위 + 2026-spring W13 예외(검증용)
--   → 그 외(레거시/PMS 주차)는 원장 생성 자체를 막아 과거 데이터 무접촉.
--
-- ⚠ 수동 적용: Supabase SQL Editor 에서 실행(프로젝트 관례 — exec_sql/직접연결 부재).
-- ⚠ user_weekly_points/snapshot 재계산은 코드(processPointAccrual)가 담당 — 본 테이블은 원장만.

create table if not exists public.process_point_awards (
  id                uuid primary key default gen_random_uuid(),
  source            text not null check (source in ('regular','irregular')),
  ref_id            uuid not null,
  user_id           uuid not null,
  year              smallint not null,
  week_number       smallint not null,
  point_check       smallint not null default 0 check (point_check     between 0 and 20),
  point_advantage   smallint not null default 0 check (point_advantage between 0 and 20),
  point_penalty     smallint not null default 0 check (point_penalty   between 0 and 20),
  organization_slug text,
  scope_mode        text not null default 'operating',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (source, ref_id, user_id)
);

create index if not exists idx_ppa_user_week on public.process_point_awards (user_id, year, week_number);
create index if not exists idx_ppa_ref        on public.process_point_awards (source, ref_id);

-- 서비스 롤 전용(고객/anon 접근 차단) — 기존 process_* 테이블과 동일 정책.
alter table public.process_point_awards enable row level security;

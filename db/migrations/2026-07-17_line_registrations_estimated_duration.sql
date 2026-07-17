-- db/migrations/2026-07-17_line_registrations_estimated_duration.sql
-- 라인 마스터(line_registrations)에 예상 소요 시간을 분 단위 정수로 추가한다.
--
-- 값 도메인: 30(0.5h) · 60(1h) · 90(1.5h) · 120(2h) · NULL(미설정)
--   - 부동소수점 시간(0.5/1.5)이 아니라 분 단위 smallint 로 저장한다 — 반올림 오차 없음,
--     CHECK 로 열거 강제 가능, 표시 포맷은 lib/adminLineRegistrationsTypes.formatLineDuration 단일 SoT.
--
-- NULL 정책: 기존 행은 근거 없이 60(1h) 등으로 일괄 채우지 않고 NULL(미설정)로 보존한다.
--   화면에서는 '-' 로 표시된다. 그래서 컬럼은 NOT NULL 로 올리지 않는다(레거시 보존과 양립 불가).
--   신규 등록의 "필수 선택" 강제는 API 파서(parseLineRegistrationCreateBody)가 담당한다 —
--   DB 는 "허용 값 이외 거부"만 책임진다(두 계층 모두에서 45/0/180 등을 차단).
--
-- 소요 시간은 라인 "마스터"의 속성이다. 개설된 개별 라인(cluster4_lines)/대상자
--   (cluster4_line_targets)/snapshot 에는 복제 저장하지 않는다 — 필요 시 브리지 조인으로 표시한다.

alter table public.line_registrations
  add column if not exists estimated_duration_minutes smallint;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.line_registrations'::regclass
      and conname = 'line_registrations_estimated_duration_minutes_check'
  ) then
    alter table public.line_registrations
      add constraint line_registrations_estimated_duration_minutes_check
      check (
        estimated_duration_minutes is null
        or estimated_duration_minutes in (30, 60, 90, 120)
      );
  end if;
end $$;

comment on column public.line_registrations.estimated_duration_minutes is
  '라인 예상 소요 시간(분). 30|60|90|120 만 허용. NULL = 미설정(레거시 행 · 화면 표시 "-"). 신규 등록 필수 강제는 API 파서.';

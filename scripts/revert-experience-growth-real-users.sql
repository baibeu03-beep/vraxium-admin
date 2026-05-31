-- 실사용자 오적용 원복 (2026-05-30)
--
-- 사유: 테스트 단계에서 실무경험 성장 sync 가 "전체 사용자"로 실행되어,
--       테스트 사용자(display_name 에 'T' 포함) 외 실사용자에게도 성장(실패)가 잘못 적용됨.
--       → 실사용자 오적용분만 success 로 원복한다 (단방향 정책의 예외적 복구, 이번 건 한정).
--
-- 대상: 오늘(2026-05-30) sync 로 success→fail 된 행
--         = status='fail' AND updated_at >= '2026-05-30T00:00:00Z'
--       중 실사용자(user_profiles.display_name NOT ILIKE '%T%').
--
-- 안전장치:
--   - status='fail' 필터 → personal_rest / official_rest 는 물리적으로 제외 (절대 미변경).
--   - updated_at >= 오늘 → seed/과거의 정상 fail 은 제외 (이번 sync 가 만든 fail 만).
--   - display_name NOT ILIKE '%T%' → 테스트 사용자(성장 실패 유지 대상)는 제외.
--   - 성장 실패 판정 정책/로직은 변경하지 않음 (sync 대상 범위 오류만 정정).

BEGIN;

-- 원복 전 대상 확인 (실행 후 동일 조건이 0건이어야 함)
-- SELECT up.display_name, up.organization_slug, uws.year, uws.week_number, uws.status, uws.updated_at
--   FROM public.user_week_statuses uws
--   JOIN public.user_profiles up ON up.user_id = uws.user_id
--  WHERE uws.status = 'fail'
--    AND uws.updated_at >= '2026-05-30T00:00:00Z'
--    AND up.display_name NOT ILIKE '%T%'
--  ORDER BY up.display_name;

UPDATE public.user_week_statuses uws
   SET status = 'success', updated_at = now()
  FROM public.user_profiles up
 WHERE uws.user_id = up.user_id
   AND uws.status = 'fail'
   AND uws.updated_at >= '2026-05-30T00:00:00Z'
   AND up.display_name NOT ILIKE '%T%';

COMMIT;

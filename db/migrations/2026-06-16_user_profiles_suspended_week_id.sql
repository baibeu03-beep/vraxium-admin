-- 2026-06-16 성장 중단(suspended) 적용 주차 SoT 도입.
--
-- 배경: 고객 4허브 주차 카드 목록에서 "성장 중단" 배지를 "성장 중단이 적용된 주차" 카드 1장에만
--   표시하려면, 어느 주차에서 중단됐는지 식별할 SoT 가 필요하다. 기존엔 컬럼이 없어
--   (status 는 전원 'active', activity_ended_at 도 NULL) front /api/profile 의 endWeekInfo 가
--   항상 null 이었다 → 카드별 stop 배지가 켜질 수 없었다.
--
-- 본 마이그레이션: user_profiles 에 suspended_week_id(weeks.id 참조)를 추가한다.
--   - 운영진이 /admin/members 멤버 수정에서 growth_status='suspended' 지정 시 함께 stop 주차를 고른다.
--   - front /api/profile 은 growth_status='suspended' && suspended_week_id 일 때 endWeekInfo 를 채운다.
--   - front 카드 목록은 endWeekInfo 와 (연도·시즌·주차) 일치 카드 1장에만 '성장 중단' 배지를 적용한다.
--   - paused 는 대상 아님(컬럼 NULL 유지) — 상단/프로필 배지만 성장 중단.
--
-- 비고: ON DELETE SET NULL — weeks 행이 삭제돼도 프로필은 보존, stop 주차만 해제(배지 미표시로 안전 폴백).
--   nullable·기본 NULL 이므로 기존 행 영향 없음(전원 NULL = 기존 동작 불변).

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS suspended_week_id uuid
  REFERENCES public.weeks(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.user_profiles.suspended_week_id IS
  '성장 중단(growth_status=suspended)이 적용된 주차(weeks.id). 카드 목록에서 이 주차 카드 1장에만 "성장 중단" 배지 표시. paused/그 외는 NULL.';

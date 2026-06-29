-- weeks.result_reviewed_at — 주차 결과 "검수 완료" 시각(관리자 "검수 완료" 버튼).
--   NULL = 미검수. /weekly-ranking 카드 상태:
--     공표(result_published_at) + 미검수(result_reviewed_at NULL) → '공표 중'
--     공표 + 검수(result_reviewed_at)                            → '검수 완료'
--   개인 weekly-cards / cluster4_weekly_card_snapshots 와 무관 — /weekly-ranking 집계
--   라벨 신호일 뿐이므로 스냅샷 재계산 불필요. append-only, CHECK/트리거 없음.
--   (admin /admin/week-recognitions 의 "검수 완료" 버튼이 markWeekResultReviewed 로 세팅)
ALTER TABLE public.weeks
  ADD COLUMN IF NOT EXISTS result_reviewed_at timestamptz NULL;

COMMENT ON COLUMN public.weeks.result_reviewed_at IS
  '주차 결과 검수 완료 시각(관리자 검수 완료 버튼). NULL=미검수. /weekly-ranking: 공표+검수 → 검수 완료.';

-- 백필: 기존에 이미 공표(확정)된 주차는 검수까지 완료된 것으로 간주한다.
--   Phase 1 에서 시간 기반 휴리스틱(N+1 목 12:01)으로 표시되던 "검수 완료"를, 명시적 신호 기준으로
--   복원하는 1회성 백필. reviewed_at := published_at (당시 확정 시점). 이미 채워진 행은 건드리지 않음(idempotent).
--   → "기존 공표 완료 시즌이 모두 검수 완료로 정상 표시" 요구사항 충족.
UPDATE public.weeks
   SET result_reviewed_at = result_published_at
 WHERE result_published_at IS NOT NULL
   AND result_reviewed_at IS NULL;

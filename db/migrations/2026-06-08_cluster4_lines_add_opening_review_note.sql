-- 실무 정보 라인 개설 [섹션 0] 개설/검수 기록 컬럼.
--
-- cluster4_lines 에 어드민 전용 자유 텍스트 메모 컬럼을 추가한다.
-- 이 값은 어드민 메타데이터로, 고객 weekly-cards DTO 나 스냅샷 계산에 일절 참여하지 않는다.
-- (LINE_SELECT 에는 포함하지 않으며, 전용 엔드포인트로만 읽고 쓴다 — snapshot 무효화 미트리거.)
--
-- 적용: 운영 DB(Supabase SQL Editor)에서 수동 실행. 코드 배포 전/후 어느 시점이든 안전
-- (IF NOT EXISTS, 기존 라인 목록/계산 경로는 이 컬럼을 참조하지 않음).

BEGIN;

ALTER TABLE public.cluster4_lines
  ADD COLUMN IF NOT EXISTS opening_review_note text NULL;

COMMENT ON COLUMN public.cluster4_lines.opening_review_note IS
  '실무 정보 라인 개설 섹션0 개설/검수 기록(어드민 메타 — 고객 weekly-cards DTO/스냅샷 무관). NULL=기본 문구 표시.';

COMMIT;

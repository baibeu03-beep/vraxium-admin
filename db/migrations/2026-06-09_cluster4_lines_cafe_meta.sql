-- 라인 개설 크루 — 카페 검수 메타데이터(선택) 보존 컬럼.
--
-- 라인 개설 시 사용한 네이버 카페 게시물 링크와 검수 카운트를 라인 행에 함께 남긴다(감사/추적용).
-- 고객 weekly-cards 스냅샷 계산과 무관(파생값 아님 — 스냅샷 재계산 불필요).
--
-- 적용: 운영 DB(Supabase SQL Editor)에서 수동 1회. 코드는 컬럼 미존재 시 해당 값 저장을 생략하는
--   graceful fallback(42703 감지 후 재시도)이라 배포 전/후 어느 시점에 적용해도 안전하다.

ALTER TABLE public.cluster4_lines
  ADD COLUMN IF NOT EXISTS cafe_url          text   NULL,
  ADD COLUMN IF NOT EXISTS matched_crew_count integer NULL,
  ADD COLUMN IF NOT EXISTS raw_comment_count  integer NULL;

COMMENT ON COLUMN public.cluster4_lines.cafe_url IS
  '라인 개설 크루 검수에 사용한 네이버 카페 게시물 URL(감사용). 스냅샷 무관.';
COMMENT ON COLUMN public.cluster4_lines.matched_crew_count IS
  '카페 검수에서 자동/수동 매칭된 크루 수(개설 시점 스냅샷). 스냅샷 무관.';
COMMENT ON COLUMN public.cluster4_lines.raw_comment_count IS
  '카페 검수 원본 댓글 수(개설 시점 스냅샷). 스냅샷 무관.';

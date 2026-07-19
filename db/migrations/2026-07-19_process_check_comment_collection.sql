-- 2026-07-19_process_check_comment_collection.sql
-- 프로세스 체크 자동 검수 — "댓글 수집 상태"와 "사용자 매칭 결과" 분리 저장. ADDITIVE — 기존 스키마 보존.
--
-- 배경(문제):
--   자동 검수(sweep)는 카페 링크에서 댓글을 크롤링해 크루를 매칭한 뒤 status='completed' 로 만든다.
--   그런데 크롤러가 반환하는 "원본 댓글 총수(totalComments)" 를 폐기하고 매칭/미매칭 "닉네임" 만 저장해서,
--     · 실제 게시물에 댓글이 0개라 완료된 경우           (정상 0)
--     · 크롤이 ok 를 냈지만 파싱이 조용히 0을 낸 경우      (오류 0)
--   를 조회 시점에 구분할 수 없었다. 둘 다 checked_crew_count=0 으로만 보여 운영자가 "정상 0명" 으로 오인한다.
--
-- 해결(이 마이그레이션):
--   크롤 결과의 "원본 댓글 수" 와 "수집 상태(성공/오류)·오류 코드" 를 명시 컬럼으로 저장해서,
--   조회 시점에 count===0 만으로 임의 판정하지 않고 아래를 결정적으로 구분한다.
--     · comment_collection_status='success' + raw_comment_count=0            → "댓글 없음"(정상)
--     · comment_collection_status='success' + raw_comment_count>0 + 매칭0     → "매칭 사용자 없음"(경고)
--     · comment_collection_status='error'                                    → "일시 오류"(다시 수집)
--     · 컬럼 NULL(레거시 완료 행) + 매칭0                                     → "상태 확인 불가"(안전)
--
--   ⚠ user_weekly_points · 주차 성장 계산 · snapshot · checkGate · demoUserId · 고객앱 무접촉.
--     매칭 사용자 수(matchedUserCount)는 기존 process_check_review_recipients(match_type='matched')에서
--     그대로 파생하며 스키마 변경이 없다. 여기서는 "수집 상태" 3개 컬럼만 추가한다.
-- Idempotent — 재실행 안전. Supabase SQL Editor 에서 수동 실행.

-- ── 정규(process_check_statuses) / 변동(process_irregular_acts) 공용 3컬럼 ────────────
--   raw_comment_count          : 크롤러 totalComments(원본 댓글 총수). NULL=미기록(레거시/미수집).
--   comment_collection_status  : 마지막 수집 결과. 'success'|'error'. NULL=아직 수집 안 함/레거시.
--   comment_collection_error_code : 오류 시 크롤러 error code(invalid_url/login_required/…). 성공=NULL.
ALTER TABLE public.process_check_statuses
  ADD COLUMN IF NOT EXISTS raw_comment_count             integer NULL,
  ADD COLUMN IF NOT EXISTS comment_collection_status     text NULL
    CHECK (comment_collection_status IN ('success', 'error')),
  ADD COLUMN IF NOT EXISTS comment_collection_error_code text NULL;

ALTER TABLE public.process_irregular_acts
  ADD COLUMN IF NOT EXISTS raw_comment_count             integer NULL,
  ADD COLUMN IF NOT EXISTS comment_collection_status     text NULL
    CHECK (comment_collection_status IN ('success', 'error')),
  ADD COLUMN IF NOT EXISTS comment_collection_error_code text NULL;

COMMENT ON COLUMN public.process_check_statuses.raw_comment_count IS
  '자동 검수 크롤 원본 댓글 총수(totalComments). NULL=미수집/레거시. 정상 0 vs 오류 0 구분의 SoT.';
COMMENT ON COLUMN public.process_check_statuses.comment_collection_status IS
  '마지막 댓글 수집 결과: success=크롤 정상 완료 / error=크롤·파싱 일시 오류. NULL=미수집/레거시.';
COMMENT ON COLUMN public.process_check_statuses.comment_collection_error_code IS
  '수집 오류 시 크롤러 error code(invalid_url/login_required/article_not_accessible/crawl_failed). 성공=NULL.';

-- PostgREST 스키마 캐시 즉시 리로드(신규 컬럼이 REST 로 바로 보이도록).
NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════
-- 검증 (참고용)
-- ═══════════════════════════════════════════════════════════════════════
/*
SELECT column_name FROM information_schema.columns
 WHERE table_name='process_check_statuses'
   AND column_name IN ('raw_comment_count','comment_collection_status','comment_collection_error_code');
SELECT comment_collection_status, count(*) FROM public.process_check_statuses GROUP BY 1 ORDER BY 1;
*/

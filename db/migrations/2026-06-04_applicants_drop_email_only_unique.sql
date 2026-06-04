-- 2026-06-04_applicants_drop_email_only_unique.sql
-- applicants 의 email 단독 unique(idx_applicants_email) 제거.
--
-- 근거: 2026-05-11_applicants_email_provider_unique.sql 이 (lower(email), provider)
-- 복합 unique 를 도입해 "프로바이더별 신청 row 공존"이 설계 의도였으나, 구 email 단독
-- unique 가 남아 있어 사실상 무력화돼 있었다. Google provider 확장(같은 email 이라도
-- kakao/google 신청을 병합하지 않는 정책)에는 email 단독 unique 가 직접 충돌한다.
-- 중복 방어는 아래 두 키가 계속 담당한다:
--   * (lower(email), provider)            — applicants_email_provider_unique_idx
--   * (provider, provider_user_id) 부분   — applicants_provider_uid_unique_idx

-- constraint 형태/index 형태 어느 쪽으로 존재하든 안전하게 제거
ALTER TABLE public.applicants DROP CONSTRAINT IF EXISTS idx_applicants_email;
DROP INDEX IF EXISTS public.idx_applicants_email;

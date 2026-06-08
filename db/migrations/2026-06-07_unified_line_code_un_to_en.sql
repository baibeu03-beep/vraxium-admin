-- 2026-06-07_unified_line_code_un_to_en.sql
-- ⚠ PREVIEW — 아직 미적용. [통합] 주차 활동 내역 line_code 접두어 정정: EXBS-UN → EXBS-EN.
--
-- 의도: 단순 코드명 정정 — 데이터 구조/SoT 변경 아님. week_id·master·target·snapshot
--   DTO 구조·판정 로직 무변경.
--
-- 안전성 (2026-06-07 read-only 조사):
--   - org 노출 판정(lib/cluster4LineOrg.ts)은 contains 토큰 BS>EC>OK>PX, BS 최우선 —
--     'EXBS-EN…' 도 BS 포함이라 common 판정 동일 (EC 토큰은 'EN'과 불일치 — 오인 없음).
--   - 레거시 판정(fetchLegacyUnifiedMasterId)은 line_name "[통합] 주차 활동 내역" 기반 —
--     line_code 비의존.
--   - front(Cluster4CardContent)의 lineCode 매칭은 동일 카드 DTO 내부 값끼리 비교 —
--     하드코딩 없음(EXBS 검색 1건=주석) → rename 무영향.
--   - 충돌: 기존 EXBS-EN% 행 0 (실측).
--   - 부수효과: snapshot cards[].lines[].lineCode 에 구값(EXBS-UN…)이 121/122 사용자에
--     잔존 — 표시/식별 필드 stale (판정 무영향). 후속 일괄 재계산 또는 자연 갱신 대상.
--
-- 대상 (실측 2026-06-07):
--   cluster4_lines                  EXBS-UN%  31행 (테스터 시드 주차별 라인)
--   cluster4_experience_line_masters EXBS-UN0000 1행 (통합 마스터)
--   line_registrations              EXBS-UN%  1행 (마스터 bridged sync 복제본 — 동반 정정)
--
-- Idempotent (재실행 시 대상 0행). Supabase SQL Editor 수동 실행.

UPDATE public.cluster4_lines
   SET line_code = replace(line_code, 'EXBS-UN', 'EXBS-EN'),
       updated_at = now()
 WHERE line_code LIKE 'EXBS-UN%';

UPDATE public.cluster4_experience_line_masters
   SET line_code = replace(line_code, 'EXBS-UN', 'EXBS-EN'),
       updated_at = now()
 WHERE line_code LIKE 'EXBS-UN%';

UPDATE public.line_registrations
   SET line_code = replace(line_code, 'EXBS-UN', 'EXBS-EN'),
       updated_at = now()
 WHERE line_code LIKE 'EXBS-UN%';

-- 검증 (적용 후):
--   SELECT count(*) FROM public.cluster4_lines WHERE line_code LIKE 'EXBS-UN%';            -- 기대 0
--   SELECT count(*) FROM public.cluster4_lines WHERE line_code LIKE 'EXBS-EN%';            -- 기대 31(+pilot ensure 후 42)
--   SELECT line_code FROM public.cluster4_experience_line_masters WHERE line_name='[통합] 주차 활동 내역'; -- EXBS-EN0000
--
-- rollback: 동일 UPDATE 의 EN→UN 역치환.

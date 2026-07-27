-- 실무 경험 평점 Point A 적립 — process_point_awards.source 에 'line_rating' 추가.
-- ─────────────────────────────────────────────────────────────────────
-- 정책(2026-07-27): "강화 시 포인트"와 "평점"은 서로 다른 개념이며, 평점은 강화 시 포인트를
--   대체하지 않고 **추가로** Point A 에 적립된다.
--     최종 Point A = 기존 강화 시 포인트(source='line') + 실제 평점(source='line_rating')
--
-- 원장 키 분리 이유:
--   process_point_awards 는 UNIQUE (source, ref_id, user_id) 이고 ref_id 는 uuid 다.
--   강화 지급은 이미 ('line', line_id, user_id) 를 점유하므로, 같은 라인에 평점 지급을 얹으려면
--   **별도 source** 가 필요하다(ref_id 를 'line_id:rating' 같은 합성 문자열로 만들 수 없다 — uuid 타입).
--   ⇒ ('line_rating', line_id, user_id) 로 1행. 두 원장은 키 네임스페이스가 겹치지 않아
--     이중 지급/충돌이 구조적으로 불가능하며, 각각 독립적으로 upsert·회수된다.
--
-- 값 범위: point_check = rating(0~10) → 기존 CHECK (point_check between 0 and 20) 안에 든다.
--   point_advantage / point_penalty 는 항상 0 (평점은 Point B·C 로 지급하지 않는다).
--
-- 지급/회수 규칙(코드 SoT = lib/processPointAccrual.ts reconcileLineResultAwardForUser):
--   지급 = 대상자(cluster4_line_targets.target_mode='user') && 강화 성공 && experience 라인 &&
--          config_key ∈ (derive, analysis, research, management) && evaluated_by IS NOT NULL &&
--          rating >= 4.  그 외(미평가 placeholder·평가행 부재·rating<=3·확장·비대상) → 회수.
--   회수 = soft-cancel(cancelled_at) 우선, 컬럼 미적용 시 hard delete — source='line' 과 동일.
--
-- ⚠ 수동 적용: Supabase SQL Editor 에서 실행(프로젝트 관례 — exec_sql/직접연결 부재).
-- ⚠ 배포 순서: 이 마이그레이션 먼저 → 코드 배포. 미적용 상태로 코드가 뜨면 평점 원장 upsert 가
--    23514(check violation)로 실패한다. 코드는 이 실패를 격리(경고 로그)해 기존 지급은 보존한다.
-- ⚠ 재실행 안전: DROP IF EXISTS + ADD.

ALTER TABLE public.process_point_awards
  DROP CONSTRAINT IF EXISTS process_point_awards_source_check;

ALTER TABLE public.process_point_awards
  ADD CONSTRAINT process_point_awards_source_check
  CHECK (source IN ('regular', 'irregular', 'line', 'line_rating'));

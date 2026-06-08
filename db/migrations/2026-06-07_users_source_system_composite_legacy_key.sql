-- 2026-06-07_users_source_system_composite_legacy_key.sql
-- ⚠ PREVIEW — 아직 미적용. 적용 전 코드 수정(단독 키 경로 4곳) 선행 여부를 §순서 에서 확인.
--
-- B안 (2026-06-07 정책 확정): legacy_user_id = PMS 원본 UserId 그대로 보존,
--   동일인 브리지 식별 = (source_system, legacy_user_id) 복합키.
--   - organization_slug 는 가변(관리자 수정 가능) → 식별자 사용 금지.
--   - users.source_system = 불변 provenance ('oranke'|'hrdb'|'olympus'|NULL).
--     NULL = 비이관 행(synthetic 채번·테스터·이관 전 기존 행).
--   - 동일인 판단은 변함없이 3중 키(이름+생년월일+연락처) — legacy_user_id 숫자
--     단독 판단 금지 (FALSE_BRIDGE_NOTE, lib/pmsMigration.ts).
--
-- 사전 확인 (적용 직전 SQL Editor 에서 read-only 재단언):
--   -- (a) 단일 UNIQUE 제약 존재 (2026-06-07 확인됨: users_legacy_user_id_key)
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'public.users'::regclass;
--   -- (b) legacy_user_id 중복 0 (현재 128행 전수 고유 — 실측 2026-06-07)
--   SELECT legacy_user_id, COUNT(*) FROM public.users
--    WHERE legacy_user_id IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1;
--
-- 적용 순서가 중요: 신규 인덱스 2개를 먼저 만들고(기존 제약과 공존 가능 — 현 데이터가
-- 양쪽 모두 만족), 마지막에 단일 UNIQUE 를 제거한다 — 보호 공백 0.

-- ── 1) source_system 컬럼 (불변 provenance) ──────────────────────────
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS source_system text
  CHECK (source_system IN ('oranke', 'hrdb', 'olympus'));

COMMENT ON COLUMN public.users.source_system IS
  '이관 provenance (불변). (source_system, legacy_user_id) 복합으로 PMS 원본 UserId 를 식별. NULL=비이관 행. organization_slug 는 가변이라 식별자 미사용 — 동일인 판단은 3중 키(이름+생년월일+연락처).';

-- 불변성 강제: 한 번 set 된 source_system 변경 금지 + source 보유 행의 legacy_user_id 변경 금지.
-- (NULL → 값 은 허용 — olympus 이관이 기존 28명 행에 최초 기록하는 경로)
CREATE OR REPLACE FUNCTION public.tg_users_source_system_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.source_system IS NOT NULL
     AND NEW.source_system IS DISTINCT FROM OLD.source_system THEN
    RAISE EXCEPTION 'users.source_system is immutable once set (user %, % -> %)',
      OLD.id, OLD.source_system, NEW.source_system;
  END IF;
  IF OLD.source_system IS NOT NULL
     AND NEW.legacy_user_id IS DISTINCT FROM OLD.legacy_user_id THEN
    RAISE EXCEPTION 'users.legacy_user_id is immutable for sourced rows (user %, % -> %)',
      OLD.id, OLD.legacy_user_id, NEW.legacy_user_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_source_system_immutable ON public.users;
CREATE TRIGGER users_source_system_immutable
BEFORE UPDATE ON public.users
FOR EACH ROW
EXECUTE FUNCTION public.tg_users_source_system_immutable();

-- ── 2) 복합 UNIQUE — 이관 행 (source_system 보유) ─────────────────────
--   (oranke,248)·(hrdb,248)·(olympus,248) 를 서로 다른 사용자로 허용하는 핵심.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_source_legacy
  ON public.users (source_system, legacy_user_id)
  WHERE source_system IS NOT NULL AND legacy_user_id IS NOT NULL;

-- ── 3) 비이관 행 보호 UNIQUE — source_system IS NULL ─────────────────
--   기존 의미론 보존: synthetic sequence(≥1억)·테스터(900031~900120)·이관 전 기존 행은
--   여전히 숫자 단독 유일 (구 단일 제약과 동일한 보호를 NULL-source 부분집합에 한정 유지).
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_legacy_no_source
  ON public.users (legacy_user_id)
  WHERE source_system IS NULL AND legacy_user_id IS NOT NULL;

-- ── 4) 단일 UNIQUE 제거 (신규 인덱스 2개 생성 성공 후 마지막에) ───────
ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_legacy_user_id_key;

-- ═══════════════════════════════════════════════════════════════════
-- §순서 (DDL 자체는 위 1→4 한 번에 실행 가능. 단, 운영 절차 순서):
--   ① 본 DDL 적용 → ② 코드 수정 배포 (단독 키 경로 4곳: crews POST lookup ·
--      resolveGrowthUserId 숫자 fallback · adminCrewData users↔legacy_crew_import join
--      scope · pmsMigration 멱등 계약) → ③ 그 다음에야 oranke 사용자 이관.
--   숫자 중복(예: oranke 248 vs 기존 phalanx 248)은 ③에서 처음 발생하므로
--   ②가 ③보다 선행하면 운영 중 모호 조회/오연결 윈도우가 없다.
--
-- §28명 처리 (olympus/phalanx 실사용자, legacy 248~303 — false-bridge-34-census):
--   - **무변경.** source_system NULL 인 채 유지 → uq_users_legacy_no_source 가 보호.
--   - 사전 수동 백필 금지 (이관 기록 행만 신뢰 규약). olympus 이관이 3중 키 매칭으로
--     기존 행을 식별하고 source_system='olympus' 를 최초 기록(NULL→값, 트리거 허용)
--     하는 순간 (olympus, 248~303) 복합키 점유로 정규 브리지 승격. NULL 처리 불필요.
--
-- §빈 stub 6명 (legacy 304~309 — 3개 PMS 전부 부재, legacy_crew_import 에 이름 보유):
--   - **무변경 + 매칭 제외 확정.** B안에서는 어떤 소스의 304~309 가 이관돼도
--     (source, 304) 복합키라 비충돌. 행 삭제/정리는 운영 별도 결정 (이관 비차단).
--
-- §신규 이관 충돌 검증 계획 (적용 후 dry-run, write 0):
--   1. 소스별 (source, UserId) 전수 ↔ users (source_system, legacy_user_id) 점유 = 0 확인.
--   2. NULL-source 행과의 "숫자 겹침"(oranke 248~309 ↔ 기존 phalanx 28명 등)은
--      충돌 아님 — 정보성 카운트로만 리포트.
--   3. 코드 ①~③ 수정 후: 같은 숫자 2행 공존 상태를 시뮬레이션해 crews POST lookup ·
--      resolver · crews 화면 join 이 source/org scope 로 정확히 분리 조회되는지 검증.
--   4. snapshot-only·DTO/API·demoUserId·direct/HTTP — 식별 체계가 전부 user_id(UUID)
--      기반이므로 영향 0 (2026-06-07 전수 조사 실증). users 조회 코드는 명시 컬럼
--      select 라 컬럼 추가 무영향. 회귀 확인으로 verify-org-week-thresholds --http 재실행.
--
-- §rollback:
--   DROP TRIGGER IF EXISTS users_source_system_immutable ON public.users;
--   DROP FUNCTION IF EXISTS public.tg_users_source_system_immutable();
--   DROP INDEX IF EXISTS public.uq_users_source_legacy;
--   DROP INDEX IF EXISTS public.uq_users_legacy_no_source;
--   ALTER TABLE public.users DROP COLUMN IF EXISTS source_system;
--   ALTER TABLE public.users ADD CONSTRAINT users_legacy_user_id_key UNIQUE (legacy_user_id);
--   ⚠ 마지막 줄(단일 UNIQUE 복원)은 **숫자 중복이 생기기 전(=이관 전)에만 가능.**
--     이관으로 (oranke,248) 등이 들어온 뒤에는 중복 제거 없이 복원 불가 —
--     rollback 가능 시한 = 첫 사용자 이관 전까지. 이관 후엔 forward-fix 만.

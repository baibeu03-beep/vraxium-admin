-- 2026-06-26_cluster4_team_halves.sql
-- 반기별 팀 SoT — /admin/team-parts/info [섹션.1] "해당 반기가 끝난 시점에 존재하는 팀" 조회용.
--
-- 배경:
--   cluster4_teams 는 "현재 팀" 마스터(시점/시즌 차원 없음, is_active 이진 토글)라
--   "2025 하반기에 라이프팀이 있었나?" 같은 반기 시점 질의를 표현할 수 없다.
--   기존엔 user_memberships / user_position_histories 를 역산해야 했으나, 본 테이블을
--   명시적 SoT 로 두어 역산을 제거한다.
--
-- 설계:
--   · UI 는 '반기'(상/하반기)를 선택하지만, 조회 기준 SoT 는 그 반기의 "마지막 시즌"이다.
--       {YYYY} 상반기 → {YYYY}-spring   (H1 의 마지막 시즌)
--       {YYYY} 하반기 → {YYYY}-autumn   (H2 의 마지막 시즌)
--     반기 중간에 잠시 존재했다 사라진 팀(겨울·여름 블록)은 여기 표시하지 않는다
--     (그 생성/변경/삭제 이력은 후속 [섹션.2] 에서 다룸).
--   · half_key 포맷: '{YYYY}-H1' | '{YYYY}-H2'. 마지막 시즌 매핑은 코드(lib/teamHalf.ts)에서만 수행.
--   · team_name 은 불변 스냅샷(과거 반기 데이터는 이후 변경되어도 불변). team_id 는
--     현재 cluster4_teams 에 동일(org, name) 행이 있으면 soft-link, 없으면 NULL.
--     → cluster4_teams 에 신규 행을 만들지 않는다(listTeams 등 운영 흐름 무접촉).
--
-- 무영향: snapshot / user_weekly_points / weekly-cards / demoUserId 경로 미접촉(신규 read 테이블).
-- Idempotent. Supabase SQL Editor 에서 수동 실행.

-- ═══════════════════════════════════════════════════════════════════════
-- PART 1: 테이블
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.cluster4_team_halves (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  organization_slug  text NOT NULL,                       -- encre / oranke / phalanx
  half_key           text NOT NULL                        -- '2026-H1' / '2025-H2' ...
                     CHECK (half_key ~ '^[0-9]{4}-H[12]$'),

  team_id            uuid NULL                            -- 현재 마스터 soft-link (없으면 NULL)
                     REFERENCES public.cluster4_teams(id) ON DELETE SET NULL,
  team_name          text NOT NULL,                       -- 불변 스냅샷(표시 SoT)

  display_order      integer NOT NULL DEFAULT 0,          -- 반기 내 노출 순서(1-base)
  is_active          boolean NOT NULL DEFAULT true,       -- 반기 내 소프트 삭제 토글

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- (조직, 반기) 내 팀명 유일.
  CONSTRAINT uq_team_half UNIQUE (organization_slug, half_key, team_name)
);

CREATE INDEX IF NOT EXISTS idx_team_halves_org_half
  ON public.cluster4_team_halves (organization_slug, half_key);

CREATE INDEX IF NOT EXISTS idx_team_halves_team
  ON public.cluster4_team_halves (team_id);

GRANT SELECT ON public.cluster4_team_halves TO anon, authenticated;

-- updated_at 자동 갱신 트리거(기존 컨벤션 재사용 패턴).
CREATE OR REPLACE FUNCTION public.touch_cluster4_team_halves_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cluster4_team_halves_set_updated_at
  ON public.cluster4_team_halves;

CREATE TRIGGER cluster4_team_halves_set_updated_at
BEFORE UPDATE ON public.cluster4_team_halves
FOR EACH ROW
EXECUTE FUNCTION public.touch_cluster4_team_halves_updated_at();

-- ═══════════════════════════════════════════════════════════════════════
-- PART 2: 시드 (반기 마지막 시즌 = spring / autumn 블록만)
-- ═══════════════════════════════════════════════════════════════════════
-- display_order = VALUES 나열 순서(1-base). team_id 는 cluster4_teams (org, name) LEFT JOIN.
-- ON CONFLICT DO NOTHING — 재실행 안전(현재 반기 편집분을 덮어쓰지 않음).

INSERT INTO public.cluster4_team_halves
  (organization_slug, half_key, team_name, display_order, team_id)
SELECT
  v.organization_slug,
  v.half_key,
  v.team_name,
  v.display_order,
  t.id
FROM (
  VALUES
    -- ── 엥크레 (encre) ──────────────────────────────────────────────
    -- 2026 상반기 (26 봄)
    ('encre', '2026-H1', '프로듀싱', 1),
    ('encre', '2026-H1', 'A&R', 2),
    ('encre', '2026-H1', '갤러리', 3),
    ('encre', '2026-H1', '팬마케팅', 4),
    ('encre', '2026-H1', '비주얼', 5),
    -- 2025 하반기 (25 가을)
    ('encre', '2025-H2', 'A&R', 1),
    ('encre', '2025-H2', '아이돌', 2),
    ('encre', '2025-H2', '프로듀싱', 3),
    ('encre', '2025-H2', '콘텐츠', 4),
    ('encre', '2025-H2', '비주얼', 5),
    ('encre', '2025-H2', '에디터', 6),
    ('encre', '2025-H2', '갤러리', 7),
    -- 2025 상반기 (25 봄)
    ('encre', '2025-H1', '셀럽', 1),
    ('encre', '2025-H1', '프로듀싱', 2),
    ('encre', '2025-H1', '콘텐츠', 3),
    ('encre', '2025-H1', 'A&R', 4),
    ('encre', '2025-H1', '아카이빙', 5),
    ('encre', '2025-H1', '미디어', 6),
    ('encre', '2025-H1', '리포터', 7),
    ('encre', '2025-H1', '비주얼', 8),
    ('encre', '2025-H1', 'K-POP', 9),
    -- 2024 하반기 (24 가을)
    ('encre', '2024-H2', '비주얼', 1),
    ('encre', '2024-H2', '프로듀싱', 2),
    ('encre', '2024-H2', '글로벌', 3),
    ('encre', '2024-H2', '콘텐츠', 4),
    ('encre', '2024-H2', 'A&R', 5),
    ('encre', '2024-H2', '미디어', 6),
    ('encre', '2024-H2', 'K-POP', 7),
    ('encre', '2024-H2', '리포터', 8),
    ('encre', '2024-H2', '갤러리', 9),
    -- 2024 상반기 (24 봄)
    ('encre', '2024-H1', '비주얼', 1),
    ('encre', '2024-H1', 'K-POP', 2),
    ('encre', '2024-H1', '글로벌', 3),
    ('encre', '2024-H1', '갤러리', 4),
    ('encre', '2024-H1', '콘텐츠', 5),
    ('encre', '2024-H1', '미디어', 6),
    ('encre', '2024-H1', '프로듀싱', 7),
    ('encre', '2024-H1', 'A&R', 8),
    ('encre', '2024-H1', '리포터', 9),

    -- ── 오랑캐 (oranke) ─────────────────────────────────────────────
    -- 2026 상반기 (26 봄)
    ('oranke', '2026-H1', 'F&B', 1),
    ('oranke', '2026-H1', '콘텐츠', 2),
    ('oranke', '2026-H1', '커머스', 3),
    ('oranke', '2026-H1', '스타일', 4),
    ('oranke', '2026-H1', '엔터테인먼트', 5),
    -- 2025 하반기 (25 가을)
    ('oranke', '2025-H2', '엔터테인먼트', 1),
    ('oranke', '2025-H2', 'F&B', 2),
    ('oranke', '2025-H2', '미디어', 3),
    ('oranke', '2025-H2', '콘텐츠', 4),
    ('oranke', '2025-H2', '브랜드', 5),
    ('oranke', '2025-H2', '커머스', 6),
    ('oranke', '2025-H2', '패션', 7),
    ('oranke', '2025-H2', '뷰티', 8),
    -- 2025 상반기 (25 봄)
    ('oranke', '2025-H1', '포스트', 1),
    ('oranke', '2025-H1', '레저', 2),
    ('oranke', '2025-H1', '헬스케어', 3),
    ('oranke', '2025-H1', '디렉팅', 4),
    ('oranke', '2025-H1', '뷰티', 5),
    ('oranke', '2025-H1', '패션', 6),
    ('oranke', '2025-H1', '푸드', 7),
    ('oranke', '2025-H1', '라이프', 8),
    -- 2024 하반기 (24 가을)
    ('oranke', '2024-H2', '헬스케어', 1),
    ('oranke', '2024-H2', '레저', 2),
    ('oranke', '2024-H2', '라이프', 3),
    ('oranke', '2024-H2', '푸드', 4),
    ('oranke', '2024-H2', '뷰티', 5),
    ('oranke', '2024-H2', '패션', 6),
    ('oranke', '2024-H2', '스포츠', 7),
    ('oranke', '2024-H2', '미디어', 8),
    -- 2024 상반기 (24 봄)
    ('oranke', '2024-H1', '헬스케어', 1),
    ('oranke', '2024-H1', 'IT온라인', 2),
    ('oranke', '2024-H1', '뷰티', 3),
    ('oranke', '2024-H1', '하드웨어', 4),
    ('oranke', '2024-H1', '스포츠', 5),
    ('oranke', '2024-H1', '레저', 6),
    ('oranke', '2024-H1', '푸드', 7),
    ('oranke', '2024-H1', '라이프', 8),
    ('oranke', '2024-H1', '패션', 9),
    ('oranke', '2024-H1', '미디어', 10),

    -- ── 팔랑크스 (phalanx) — 모든 반기 동일(브랜딩·IT·서비스) ───────────
    ('phalanx', '2026-H1', '브랜딩', 1),
    ('phalanx', '2026-H1', 'IT', 2),
    ('phalanx', '2026-H1', '서비스', 3),
    ('phalanx', '2025-H2', '브랜딩', 1),
    ('phalanx', '2025-H2', 'IT', 2),
    ('phalanx', '2025-H2', '서비스', 3),
    ('phalanx', '2025-H1', '브랜딩', 1),
    ('phalanx', '2025-H1', 'IT', 2),
    ('phalanx', '2025-H1', '서비스', 3),
    ('phalanx', '2024-H2', '브랜딩', 1),
    ('phalanx', '2024-H2', 'IT', 2),
    ('phalanx', '2024-H2', '서비스', 3),
    ('phalanx', '2024-H1', '브랜딩', 1),
    ('phalanx', '2024-H1', 'IT', 2),
    ('phalanx', '2024-H1', '서비스', 3)
) AS v(organization_slug, half_key, team_name, display_order)
LEFT JOIN public.cluster4_teams t
  ON t.organization_slug = v.organization_slug
 AND t.team_name = v.team_name
ON CONFLICT (organization_slug, half_key, team_name) DO NOTHING;

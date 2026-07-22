-- ============================================================================
-- 주차 결과(크루) — 팀 활동 결과 공표 snapshot (수동 적용 대상)
--   적용: Supabase SQL Editor (project oksnumlerbaybxlmgdux). exec_sql RPC 부재로 코드 적용 불가.
--
-- 배경:
--   고객 앱 Team Battle(buildTeamBattles)은 순수 함수지만 입력이 전부 live 다 —
--   팀 카탈로그(cluster4_team_halves) · 팀장/학교/전공(user_educations) · 파트 배정 ·
--   심화/정규(levelOf) · 시즌휴식 집합. 따라서 공표 후 원천이 바뀌면 팀 숫자가 함께 변한다.
--   크루 결과만 snapshot 이고 팀 결과가 live 면
--       크루 = 고정 / 팀 = 변동
--   으로 갈려 같은 주차의 값이 서로 어긋난다. → 팀 결과도 공표 당시 값으로 보존한다.
--
-- 동명 팀 실측(2026-07-22):
--   · 팀 카탈로그 125행 중 (organization_slug, half_key, team_name) 중복 **0건**
--   · 조직 간 동명은 4건(디렉팅·콘텐츠·미디어·테스트(T)) 이나, run 은 (week, org, scope) 스코프라
--     한 run 안에서는 org 가 고정되어 충돌하지 않는다.
--   · buildTeamBattles 는 teamName 문자열로 버킷팅하므로 한 run 안의 동명 팀은 구조적으로 1개다.
--   → UNIQUE(run_id, team_name) 로도 안전하지만, 미등록 팀(team_id NULL)·향후 정규화 변경에 대비해
--     **team_snapshot_key** 를 안정 키로 함께 둔다(등록팀=team_id 문자열 · 미등록팀=정규화 팀명).
--
-- 정렬 정책(결정 2026-07-22):
--   · 저장 : display_order 를 함께 보존한다.
--   · 고객 앱 렌더 : display_order asc (기존 순서 재현)
--   · 어드민 표 렌더 : team_name.localeCompare(…, "ko-KR") 가나다순
--   두 화면의 **순서는 달라도 되고, 값은 같아야 한다.**
--
-- 성장 휴식(결정 2026-07-22):
--   · 화면(어드민 표) = rest_crew (= season + personal 합계, 고객 앱과 동일)
--   · 저장 = season_rest_crew / personal_rest_crew 를 각각 보존(감사·세부 분리 대비)
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.cluster4_week_finalize_run_team_results (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              uuid        NOT NULL
                        REFERENCES public.cluster4_week_finalize_runs(id) ON DELETE CASCADE,

  -- 팀 식별 — team_id 는 카탈로그 미등록 팀에서 NULL 이 될 수 있어 키로 쓰지 않는다.
  team_id             uuid        NULL,
  team_name           text        NOT NULL,
  /* 안정 키: 등록팀 = team_id::text · 미등록팀 = 'name:' || 정규화(team_name).
     동명 팀이 생기더라도 저장이 막히지 않도록 UNIQUE 는 이 키로 건다. */
  team_snapshot_key   text        NOT NULL,
  -- 고객 앱 정렬 재현용(카탈로그 미매칭은 9999). 어드민은 이 값을 쓰지 않고 팀명 정렬한다.
  display_order       integer     NULL,

  -- 대전 결과 — 고객 앱 BattleResult 와 동일 3값. 'pending' 은 도메인에 없다(추가 금지).
  battle_result       text        NOT NULL
                        CHECK (battle_result IN ('win','lose','draw')),

  -- 팀장 — 공표 당시 값 복사(이후 개명·소속 이동에 불변). 표시 항목은 이름/학교/전공뿐.
  leader_user_id      uuid        NULL,
  leader_display_name text        NULL,
  leader_school_name  text        NULL,
  leader_major_name   text        NULL,

  part_count          integer     NULL CHECK (part_count      IS NULL OR part_count      >= 0),
  total_crew          integer     NULL CHECK (total_crew      IS NULL OR total_crew      >= 0),
  advanced_crew       integer     NULL CHECK (advanced_crew   IS NULL OR advanced_crew   >= 0),
  regular_crew        integer     NULL CHECK (regular_crew    IS NULL OR regular_crew    >= 0),
  challenge_crew      integer     NULL CHECK (challenge_crew  IS NULL OR challenge_crew  >= 0),
  rest_crew           integer     NULL CHECK (rest_crew       IS NULL OR rest_crew       >= 0),
  season_rest_crew    integer     NULL CHECK (season_rest_crew   IS NULL OR season_rest_crew   >= 0),
  personal_rest_crew  integer     NULL CHECK (personal_rest_crew IS NULL OR personal_rest_crew >= 0),
  success_crew        integer     NULL CHECK (success_crew    IS NULL OR success_crew    >= 0),
  fail_crew           integer     NULL CHECK (fail_crew       IS NULL OR fail_crew       >= 0),

  match_count         integer     NULL CHECK (match_count     IS NULL OR match_count     >= 0),
  win_count           integer     NULL CHECK (win_count       IS NULL OR win_count       >= 0),
  loss_count          integer     NULL CHECK (loss_count      IS NULL OR loss_count      >= 0),
  win_rate_percent    integer     NULL
                        CHECK (win_rate_percent IS NULL OR win_rate_percent BETWEEN 0 AND 100),

  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uniq_finalize_run_team UNIQUE (run_id, team_snapshot_key),

  -- ── buildTeamBattles 의 불변식을 DB 로 고정 ──────────────────────────────
  --   신규 테이블이라 legacy 예외가 없어 CHECK 로 강제할 수 있다(NULL 은 통과 — 미집계 허용).
  --   ⚠ 이 제약이 깨지면 공표가 실패한다 = 계산 버그를 조용히 저장하지 않는다는 뜻(의도).
  CONSTRAINT chk_team_total_split_level CHECK (
    total_crew IS NULL OR advanced_crew IS NULL OR regular_crew IS NULL
    OR total_crew = advanced_crew + regular_crew
  ),
  CONSTRAINT chk_team_total_split_activity CHECK (
    total_crew IS NULL OR challenge_crew IS NULL OR rest_crew IS NULL
    OR total_crew = challenge_crew + rest_crew
  ),
  CONSTRAINT chk_team_rest_split CHECK (
    rest_crew IS NULL OR season_rest_crew IS NULL OR personal_rest_crew IS NULL
    OR rest_crew = season_rest_crew + personal_rest_crew
  ),
  CONSTRAINT chk_team_challenge_split CHECK (
    challenge_crew IS NULL OR success_crew IS NULL OR fail_crew IS NULL
    OR challenge_crew = success_crew + fail_crew
  ),
  -- matchCount = challengeCrew · winCount = successCrew · loseCount = failCrew (고객 앱 정의)
  CONSTRAINT chk_team_match_split CHECK (
    match_count IS NULL OR win_count IS NULL OR loss_count IS NULL
    OR match_count = win_count + loss_count
  ),
  -- battle_result 는 승/패 수와 일치해야 한다(승률만 보고 재판정하지 않는다는 계약의 DB 표현).
  CONSTRAINT chk_team_result_matches_counts CHECK (
    win_count IS NULL OR loss_count IS NULL
    OR (battle_result = 'win'  AND win_count >  loss_count)
    OR (battle_result = 'lose' AND win_count <  loss_count)
    OR (battle_result = 'draw' AND win_count =  loss_count)
  )
);

CREATE INDEX IF NOT EXISTS idx_finalize_run_team_results_run
  ON public.cluster4_week_finalize_run_team_results (run_id);
CREATE INDEX IF NOT EXISTS idx_finalize_run_team_results_team
  ON public.cluster4_week_finalize_run_team_results (team_id);

COMMENT ON TABLE public.cluster4_week_finalize_run_team_results IS
  '공표(finalize run) 당시의 팀별 결과 snapshot. 고객 앱 buildTeamBattles 와 동일 값을 고정 보존한다.';
COMMENT ON COLUMN public.cluster4_week_finalize_run_team_results.team_snapshot_key IS
  '안정 키: 등록팀=team_id::text · 미등록팀=''name:''||정규화 팀명. 동명 팀 저장 충돌 방지.';
COMMENT ON COLUMN public.cluster4_week_finalize_run_team_results.display_order IS
  '고객 앱 정렬(display_order asc) 재현용. 어드민 표는 team_name ko-KR 가나다순으로 별도 정렬한다.';
COMMENT ON COLUMN public.cluster4_week_finalize_run_team_results.rest_crew IS
  '성장 휴식(화면 표시값) = season_rest_crew + personal_rest_crew. 분해값도 각각 보존한다.';

-- ⚠ RLS: 부모(cluster4_week_finalize_runs)와 동일하게 ROW LEVEL SECURITY 를 켜지 않는다
--   — supabaseAdmin(서비스롤) 쓰기가 정책에 막혀 깨진다.

COMMIT;

-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- BEGIN;
--   DROP TABLE IF EXISTS public.cluster4_week_finalize_run_team_results;
-- COMMIT;
--   ⚠ 부모 run 테이블과 크루 결과 테이블은 이 마이그레이션이 건드리지 않는다(무영향).

-- ============================================================================
-- 적용 후 확인
-- ============================================================================
-- SELECT to_regclass('public.cluster4_week_finalize_run_team_results') AS team_table;
--   -- 기대: NOT NULL
-- SELECT conname FROM pg_constraint
--  WHERE conrelid = 'public.cluster4_week_finalize_run_team_results'::regclass
--    AND contype = 'c' ORDER BY conname;
--   -- 기대: chk_team_* 6종 + 각 count >= 0 + win_rate 범위

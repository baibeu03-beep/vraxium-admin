// ═══════════════════════════════════════════════════════════════════════════
// 팀 생명주기(existence + leader) 단일 resolver — 2026-08-08 확장(effectiveTo 추가).
//
// "이 팀이 그 주차에 존재했는가 · 그 주차의 팀장은 누구였는가"를 한 번에 답한다. 화면마다
// cluster4_team_halves.is_active/leader_user_id 를 직접 읽고 재구현하지 않는다.
//
//   exists(W) = (effectiveFrom == null || W >= effectiveFrom)
//            && (effectiveTo   == null || W <  effectiveTo)
//
// ── effectiveFrom 의 원천 ────────────────────────────────────────────────────
//   cluster4_team_halves 는 반기(half, ~26주) 단위 카탈로그라 주차 단위 컬럼이 없다. 새 컬럼/
//   테이블 없이, 팀 생성이 항상 팀장 승격과 같은 요청 안에서 일어난다는 사실(registerTeamHalf →
//   promoteTeamLeader → cluster4_team_week_position_overrides 에 현재 주차로 기록)을 이용해
//   "이 팀 이름으로 처음 기록된 팀장 배정 이력의 주차"를 생성 주차로 역산한다
//   ([[project_team-week-position-override-common-sot]] 확장, teamWeekPositionOverride.ts).
//   이 lifecycle 이전에 시드/생성된 레거시 팀은 이력이 없어 effectiveFrom=null(제한 없음, 무회귀).
//
// ── effectiveTo 의 원천(신규) ─────────────────────────────────────────────────
//   cluster4_team_halves 에 종료 시각 컬럼이 없다. markTeamHalfDeletionPending 이 하는 유일한
//   쓰기는 `is_active=false` UPDATE 뿐이지만, 이 UPDATE 는 트리거(touch_..._updated_at)로
//   updated_at 을 정확히 그 시각으로 갱신한다. 이 컬럼이 "삭제와 무관한 이유"로도 갱신되는지
//   확인했다: updateTeamHalf(수정)는 target.is_active 가 true 인 행만 허용하고, registerTeamHalf
//   의 재활성 분기는 is_active 를 다시 true 로 돌리므로, **is_active=false 인 행의 updated_at 을
//   건드리는 다른 쓰기 경로가 없다** — 즉 "is_active=false AND updated_at" 조합이 삭제 시각의
//   신뢰 가능한 근사치다. 삭제 즉시 그 시각이 속한 주차를 종료 주차로 역산한다.
//
// ⚠ 알려진 한계(2026-08-08 확인, 데이터 모델 갭 — 이번 라운드 미해결):
//   같은 (org, half, team_name)으로 삭제 후 재등록하면 registerTeamHalf 가 **같은 행을 재활성화**
//   한다(신규 insert 아님) — is_active/updated_at/leader_user_id 가 덮어써져 "1차 lifecycle 종료
//   ~ 2차 lifecycle 시작" 사이의 공백을 표현할 수 없다(단일 행에 시작/끝 각 1개뿐이라 lifecycle
//   세그먼트가 여러 개면 구조적으로 표현 불가). 해결하려면 재등록을 새 행 INSERT 로 바꾸고
//   UNIQUE(organization_slug, half_key, team_name) 를 `WHERE is_active` 부분 인덱스로 완화해야
//   한다(마이그레이션 필요, 이번 라운드 범위 밖 — 완료 보고에 위험으로 명시).
// ═══════════════════════════════════════════════════════════════════════════

import {
  loadTeamLeaderAssignmentHistory,
  resolveCurrentWeekStartDate,
  resolveTeamExistenceFromWeek,
  resolveTeamLeaderAtWeek,
  type TeamLeaderHistoryEntry,
} from "@/lib/teamWeekPositionOverride";

export type TeamHalfLifecycleInput = {
  teamName: string;
  isActive: boolean;
  /** cluster4_team_halves.updated_at. is_active=false 일 때만 종료 시각 후보로 쓰인다. */
  updatedAt: string | null;
  /** 카탈로그 현재값(레거시 폴백 — 이력이 전혀 없는 팀만 이 값을 그대로 쓴다). */
  currentLeaderUserId: string | null;
};

export type TeamLifecycleAtWeek = {
  exists: boolean;
  /** 생성 주차(week_start_date). null=레거시(제한 없음). */
  effectiveFrom: string | null;
  /** 종료 주차(week_start_date, 그 주차부터 미존재). null=아직 종료 안 됨(또는 근거 없음). */
  effectiveTo: string | null;
  /** exists=false 면 항상 null. */
  leaderUserId: string | null;
};

// timestamptz 배열 → (date-only → 그 날짜가 속한 주차 week_start_date) 벌크. 삭제 건수는 보통
//   작아(팀 삭제는 드문 액션) N+1 부담이 크지 않지만, 같은 날짜는 1회만 조회한다.
async function resolveWeekStartsForDates(datesOnly: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = Array.from(new Set(datesOnly));
  for (const d of uniq) {
    const ws = await resolveCurrentWeekStartDate(d);
    if (ws) out.set(d, ws);
  }
  return out;
}

/** 팀 하나의 effectiveFrom/effectiveTo만 계산(특정 주차 판정 없이) — 여러 주차를 순수 비교로 필터링
 *   해야 하는 호출부(예: 선택 가능 주차 드롭다운)가 주차마다 재쿼리하지 않도록 한다. */
export async function resolveTeamLifecycleBounds(opts: {
  organization: string;
  row: Pick<TeamHalfLifecycleInput, "teamName" | "isActive" | "updatedAt">;
}): Promise<{ effectiveFrom: string | null; effectiveTo: string | null }> {
  const history = await loadTeamLeaderAssignmentHistory(opts.organization, [opts.row.teamName]);
  const effectiveFrom = resolveTeamExistenceFromWeek(history.get(opts.row.teamName));
  const effectiveTo =
    !opts.row.isActive && opts.row.updatedAt
      ? await resolveCurrentWeekStartDate(String(opts.row.updatedAt).slice(0, 10))
      : null;
  return { effectiveFrom, effectiveTo };
}

/**
 * 여러 팀의 특정 주차 시점 생명주기를 한 번에 계산한다. 팀 카탈로그(cluster4_team_halves) select
 * 자체는 호출부가 이미 하고 있으므로(예: loadCrewWeekTeamContext), 여기선 override 이력 배치 조회 +
 * is_active/updated_at 기반 종료 판정만 담당한다.
 */
export async function resolveTeamLifecyclesAtWeek(opts: {
  organization: string;
  rows: TeamHalfLifecycleInput[];
  weekStartDate: string;
}): Promise<Map<string, TeamLifecycleAtWeek>> {
  const out = new Map<string, TeamLifecycleAtWeek>();
  const teamNames = opts.rows.map((r) => r.teamName);
  const history = await loadTeamLeaderAssignmentHistory(opts.organization, teamNames);

  const endedDates = opts.rows
    .filter((r) => !r.isActive && r.updatedAt)
    .map((r) => String(r.updatedAt).slice(0, 10));
  const weekStartByDate = await resolveWeekStartsForDates(endedDates);

  for (const row of opts.rows) {
    const h = history.get(row.teamName);
    const effectiveFrom = resolveTeamExistenceFromWeek(h);
    const effectiveTo =
      !row.isActive && row.updatedAt
        ? (weekStartByDate.get(String(row.updatedAt).slice(0, 10)) ?? null)
        : null;
    const exists =
      (effectiveFrom == null || opts.weekStartDate >= effectiveFrom) &&
      (effectiveTo == null || opts.weekStartDate < effectiveTo);
    out.set(row.teamName, {
      exists,
      effectiveFrom,
      effectiveTo,
      leaderUserId: exists
        ? resolveTeamLeaderAtWeek(h, opts.weekStartDate, row.currentLeaderUserId)
        : null,
    });
  }
  return out;
}

/** 단건 편의 wrapper. 목록 화면에서는 반드시 배치(resolveTeamLifecyclesAtWeek)를 쓸 것(N+1 금지). */
export async function resolveTeamLifecycleAtWeek(opts: {
  organization: string;
  row: TeamHalfLifecycleInput;
  weekStartDate: string;
}): Promise<TeamLifecycleAtWeek> {
  const m = await resolveTeamLifecyclesAtWeek({
    organization: opts.organization,
    rows: [opts.row],
    weekStartDate: opts.weekStartDate,
  });
  return (
    m.get(opts.row.teamName) ?? {
      exists: false,
      effectiveFrom: null,
      effectiveTo: null,
      leaderUserId: null,
    }
  );
}

export type { TeamLeaderHistoryEntry };

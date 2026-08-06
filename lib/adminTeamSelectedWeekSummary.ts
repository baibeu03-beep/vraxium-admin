import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import { loadSeasonWeeks } from "@/lib/adminSeasonWeeksData";
import { resolveUserScope } from "@/lib/userScope";
import { loadTeamActivityEligibilityBulk, loadEvaluationEligibility } from "@/lib/evaluationEligibility";
import {
  loadWeekOrgResultStates,
  resolveWeekOrgResultState,
  resolveOrgResultScope,
} from "@/lib/weekOrgResultState";
import { seasonKeyToHalfKey, seasonKeyToSeasonLabel } from "@/lib/teamHalf";
import { DEFAULT_PART_NAME, getLeaderBasicsBatch } from "@/lib/adminTeamHalvesData";
import { SUPER_ADMIN_EXCLUDE_OR } from "@/lib/superAdmins";
import { resolvePositionLabels } from "@/lib/adminMembersTypes";
import {
  buildOverrideIndex,
  buildSeasonKeyResolver,
  loadOrgOverrideRowsUpTo,
  resolveOverrideAt,
} from "@/lib/teamWeekPositionOverride";
import { loadWeeklyCrewResults, type WeeklyCrewResult } from "@/lib/teamWeekCrewResults";
import { loadWeekGradeHistory, type WeekGradeHistoryEntry } from "@/lib/userWeekGradeHistory";
import { type PositionCode } from "@/lib/positionHistory";
import type { ScopeMode } from "@/lib/userScopeShared";
import { type OrganizationSlug } from "@/lib/organizations";
import { resolvePositionAtWeeksBulk } from "@/lib/positionResolver";

// ── 팀 상세 [A] — 선택 주차 요약 ─────────────────────────────────────────────
//   특정 (organization, teamName, weekId) 에 대해 그 주차 기준 크루 수·성장 결과·운용 파트를 반환.
//   모든 값은 기존 SoT 를 파생(신규 판정 로직 없음):
//     · 검수 완료 = cluster4_week_org_result_states.status==='published'(org·scope, 레거시 폴백).
//     · 주차 로스터/정규·심화/파트별 크루 수 = user_position_histories(UPH) position_code + raw_part.
//       (UPH 없는 "현재 반기 진행 주차"는 매트릭스와 동일하게 현재 멤버십 폴백 — 운용 판정 SoT 일치.)
//     · 성장 결과 = user_week_statuses.status(success/fail/personal_rest/official_rest); 미확정 나머지는
//       현재 주차=running / 그 외=tallying(shared/growth.contracts 어휘). 억지 실패/휴식 분류 없음.
//   ⚠ 운용 파트 판정 = "그 주차 배정 크루 ≥1"(파트 종류 무관 — '일반'도 예외 없음). 매트릭스 data-pw-cell 과 일치.
//   ⚠ mode(operating/test)/actAs/demo/snapshot 모두 동일 함수·동일 DTO(스코프만 입력값으로 다름).

const stripParen = (s: string): string => s.replace(/\(.*?\)/g, "").trim();
const isCrewPosition = (pc: string | null) =>
  pc === "regular" || pc === "advanced_agent" || pc === "advanced_part_leader";
const isAdvancedPosition = (pc: string | null) =>
  pc === "advanced_agent" || pc === "advanced_part_leader";
// 폴백(현재 멤버십) 라벨 → UPH position_code. 운영진/관리자 등 크루 아님 = null.
// 크루 집계 대상 코드 3종만 통과. 운영진(팀장/앰배서더/클럽장)·관리자는 null(= 크루 아님, 미집계).
//   라벨 문자열을 다시 비교하지 않는다 — 공통 변환기가 준 positionCode 로 판정한다.
const CREW_POSITION_CODES = new Set<string>([
  "regular",
  "advanced_agent",
  "advanced_part_leader",
]);
function crewPositionCodeOrNull(code: string | null): string | null {
  return code && CREW_POSITION_CODES.has(code) ? code : null;
}
// uws.status → [B] 주차 결과 표시 라벨(검수 완료 후에만 호출).
function weekResultLabel(status: string | undefined): string | null {
  switch (status) {
    case "success":
      return "성장 성공";
    case "fail":
      return "성장 실패";
    case "personal_rest":
    case "official_rest":
      // [A] 성장 결과 요약(성장 성공/실패/휴식)과 동일 라벨 — [B] 주차 결과도 '성장 휴식'로 통일.
      return "성장 휴식";
    default:
      return null;
  }
}

export type SelectableWeek = {
  weekId: string;
  label: string; // week_label(예: "4주차") — 그대로 유지(폴백/식별).
  year: number; // 표시용 연도(주차 종료일 기준·resolveCurrentWeekInfo 와 동일 파생). "26년, 여름, 4주차" 조합용.
  weekNumber: number | null;
  seasonLabel: string | null; // 시즌명(예: "여름")
  weekStartDate: string;
  isCurrent: boolean;
};

export type TeamSelectedWeekSummary = {
  // 선택 가능한 주차(현재+과거, 미래 제외). 최신순. 드롭다운 옵션 SoT.
  selectableWeeks: SelectableWeek[];
  week: {
    weekId: string;
    label: string;
    weekNumber: number | null;
    seasonLabel: string | null;
    weekStartDate: string;
    isCurrentWeek: boolean;
    reviewCompleted: boolean; // cluster4_week_org_result_states published
    canEdit: boolean; // !reviewCompleted
  } | null;
  // 전체 크루 = 정규 + 심화(운영진 제외·개인 휴식 포함·userId 고유).
  crew: { total: number; regular: number; advanced: number };
  // 전체 크루 = success + failure + rest + running + tallying (rest = personal + official).
  //   card 는 성공/실패/휴식 3개만 노출하고, running/tallying 은 정합 재구성용.
  growth: {
    success: number;
    failure: number;
    rest: number;
    running: number;
    tallying: number;
  };
  // 그 주차 배정 크루 ≥1 파트(‘일반’ 포함). crewCount = distinct userId. 최신 표시순('일반' 우선).
  operatedParts: Array<{ partName: string; crewCount: number }>;
  // [B] 편집표 행 — "팀 파트 배정 가능" 크루만(crew.total 과 달리 집합②: 시즌휴식·주차휴식·활동중단·
  //   엘리트·바사노스 제외 — 소속은 유지해도 신규 배정 대상은 아니다). 소속 파트(rawPart)·클래스
  //   (positionCode)만 편집 대상, 나머지 조회전용.
  crewRows: CrewRow[];
};

// ── 주차 effective 로스터(팀 상세 [A]/[B]·매트릭스·실무 경험 공용 SoT) ───────────────
//   "그 주차에 이 팀 소속으로 배정된 크루는 누구이고, 각자의 파트/클래스는 무엇인가" 단 하나의 답.
//   운용 파트 판정도, 파트별 크루 목록도 모두 이 결과만 파생한다(후보 풀을 따로 만들지 않는다).
export type TeamWeekRosterMember = {
  userId: string;
  /** 크루 3종(regular/advanced_agent/advanced_part_leader)만. 운영진·관리자는 애초에 미포함. */
  positionCode: string;
  /** 그 주차 effective 소속 파트. 미배정이면 null. */
  rawPart: string | null;
};

export type TeamWeekRoster = {
  /** 대상 주차(선택 가능 목록 내 weekId, 없으면 현재 주차 폴백). 달력이 비면 null. */
  week: {
    weekId: string;
    weekStartDate: string;
    seasonKey: string | null;
    isCurrentWeek: boolean;
  } | null;
  members: TeamWeekRosterMember[];
};

export type CrewRow = {
  userId: string;
  name: string | null;
  gender: string | null;
  birth6: string | null; // YYMMDD (년생 = 앞 2자리)
  school: string | null;
  major: string | null;
  residence: string | null;
  rawPart: string | null; // effective 소속 파트(편집 대상)
  positionCode: PositionCode; // effective 클래스(편집 대상)
  classLabel: string; // positionCode 표시 라벨
  gradeLabel: string | null; // 품계(검수 후만)
  gradeRank: number | null; // 품계 숫자 등급(1=정승…10=정9품, 검수 후만) — [B] 품계 컬럼 정렬 SoT.
  weekResult: string | null; // 주차 결과(검수 후만)
  growthSuccessCount: number | null; // 조회전용(검수 후 SoT 배선 예정) — 현재 null
  lineEnhancementRate: number | null; // 조회전용(동상)
  actCheckRate: number | null; // 조회전용(동상)
};

function emptyBody(): Pick<
  TeamSelectedWeekSummary,
  "crew" | "growth" | "operatedParts" | "crewRows"
> {
  return {
    crew: { total: 0, regular: 0, advanced: 0 },
    growth: { success: 0, failure: 0, rest: 0, running: 0, tallying: 0 },
    operatedParts: [],
    crewRows: [],
  };
}

// 선택 가능 주차 목록 + 대상 주차 해석 — 요약/로스터 공용(같은 폴백 규칙을 두 번 쓰지 않는다).
//   대상 주차 = weekId(선택 가능 목록 내) 또는 현재 주차(없으면 최신). 목록 밖 weekId 는 조용히 폴백.
async function resolveSelectableWeeks(opts: {
  weekId?: string | null;
  halfKey?: string | null;
  today?: string;
}): Promise<{
  selectableWeeks: SelectableWeek[];
  targetRow: Awaited<ReturnType<typeof loadSeasonWeeks>>["rows"][number] | null;
}> {
  const today = opts.today;
  const todayIso = today ?? getCurrentActivityDateIso();

  // 선택 가능 주차 = 현재+과거(week_start_date <= 현재 활동일). 미래 제외 + **0주차(전환 주차) 제외**. 최신순.
  //   ⚠ 이 페이지 전용 UI 필터(공식 week_number 기준) — DB 의 0주차 데이터·다른 페이지(기간 관리 등)엔 영향 없음.
  //   현재 활동일은 월요일 00:01 KST 경계(getCurrentActivityDateIso) — "그 주 월요일 00:01부터 현재 주차 노출".
  const { rows: weekRows } = await loadSeasonWeeks(today);
  const selectable = weekRows
    .filter(
      (w) =>
        w.week_start_date &&
        w.week_start_date <= todayIso &&
        (w.week_number ?? 0) > 0 &&
        (!opts.halfKey ||
          (w.season_key && seasonKeyToHalfKey(w.season_key) === opts.halfKey)),
    )
    .sort((a, b) => (b.week_start_date ?? "").localeCompare(a.week_start_date ?? ""));
  const yearOf = (w: (typeof selectable)[number]): number => {
    // 표시 연도 — 주차 종료일 우선(주 경계 넘김 대비), 없으면 시작/시즌 시작일. resolveCurrentWeekInfo 와 동일.
    const iso = w.week_end_date ?? w.week_start_date ?? w.season_start_date ?? "";
    const y = Number(String(iso).slice(0, 4));
    return Number.isFinite(y) ? y : 0;
  };
  const selectableWeeks: SelectableWeek[] = selectable.map((w) => ({
    weekId: w.week_id,
    label: w.week_label,
    year: yearOf(w),
    weekNumber: w.week_number,
    // 시즌명 = 간결한 "여름/봄/가을/겨울"(seasonKeyToSeasonLabel, 프로젝트 공식 파생). season_label/name 은
    //   "2026년도 여름시즌"이라 연도 중복 → 사용 안 함.
    seasonLabel: w.season_key ? seasonKeyToSeasonLabel(w.season_key) : w.season_name,
    weekStartDate: w.week_start_date as string,
    isCurrent: w.is_current_week,
  }));

  const currentRow = selectable.find((w) => w.is_current_week) ?? selectable[0] ?? null;
  const targetRow =
    (opts.weekId && selectable.find((w) => w.week_id === opts.weekId)) || currentRow;
  return {
    selectableWeeks,
    targetRow: targetRow && targetRow.week_start_date ? targetRow : null,
  };
}

// ── <운용> 파트 판정의 **유일한 계산기** ────────────────────────────────────
//   "그 주차 · 그 팀에 배정된 크루는 누구이고 파트는 무엇인가" 를 여러 팀 × 여러 주차에 대해 한 번에 답한다.
//   화면(주차 요약 [A] · 파트×주차 존재표 · 팀 카드 파트 수/파트명 · 실무 경험 파트 스코프)은 전부
//   이 함수 결과만 판다. **다른 곳에서 UPH/override/멤버십을 다시 조립하지 말 것** — 그렇게 갈라졌던
//   경로들이 2026-07-27 에 "종료된 파트가 매트릭스에만 남는" 불일치를 만들었다.
//
//   규칙(주차마다 동일):
//     후보  = org 프로필(슈퍼 관리자 제외) ∪ 그 주차 UPH 보유자 ∪ 그 주차 override 대상자
//     ∩ 모집단 스코프(mode) ∩ 집합①(시즌 휴식·활동 중단 제외 — lib/evaluationEligibility)
//     소속  = override(**같은 시즌** 안에서 ≤W 최신) → UPH(W) → 현재 멤버십 (lib/positionResolver)
//     크루  = positionCode 3종만(운영진·관리자 미집계)
//   ⚠ override 의 시즌 경계(SEASON BOUNDARY, lib/teamWeekPositionOverride)는 여기서 특례를 두지 않는다 —
//     "그 주차에 실제로 활동 가능한 크루가 그 파트에 배정돼 있을 때만 운용"이 이 함수의 유일한 정의다.
export const teamWeekRosterKey = (teamName: string, weekStartDate: string): string =>
  `${teamName}::${String(weekStartDate).slice(0, 10)}`;

export async function loadTeamWeekRostersBulk(opts: {
  organization: OrganizationSlug;
  teamNames: string[];
  weeks: ReadonlyArray<{ weekStartDate: string; seasonKey: string | null }>;
  mode: ScopeMode;
  today?: string;
}): Promise<Map<string, TeamWeekRosterMember[]>> {
  const { organization, mode } = opts;
  const teamNames = Array.from(new Set(opts.teamNames.filter(Boolean)));
  const weeks: Array<{ weekStartDate: string; seasonKey: string | null }> = [];
  const seenWeek = new Set<string>();
  for (const w of opts.weeks) {
    const ws = String(w.weekStartDate ?? "").slice(0, 10);
    if (!ws || seenWeek.has(ws)) continue;
    seenWeek.add(ws);
    weeks.push({ weekStartDate: ws, seasonKey: w.seasonKey ?? null });
  }

  const out = new Map<string, TeamWeekRosterMember[]>();
  for (const t of teamNames) for (const w of weeks) out.set(teamWeekRosterKey(t, w.weekStartDate), []);
  if (teamNames.length === 0 || weeks.length === 0) return out;

  const weekStarts = weeks.map((w) => w.weekStartDate).sort();
  const maxWeek = weekStarts[weekStarts.length - 1];

  // 모집단 스코프(operating=실사용자·test=테스트 마커). UserScope.includes 는 Set 조회(O(1)).
  const scopeSet = await resolveUserScope(mode, null);

  // 후보 원천 — org 프로필(1패스) · 전 주차 UPH 보유자(1패스) · override 행(≤max, 1패스).
  //   (UPH/override 는 프로필 org 가 바뀐 뒤에도 그 주차 이력을 잃지 않기 위한 합집합 항이다.)
  const [{ data: positionCandidates }, uphUsersByWeek, overrideRows] = await Promise.all([
    supabaseAdmin
      .from("user_profiles")
      .select("user_id")
      .eq("organization_slug", organization)
      .or(SUPER_ADMIN_EXCLUDE_OR),
    (async () => {
      const byWeek = new Map<string, Set<string>>();
      for (const ws of weekStarts) byWeek.set(ws, new Set());
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabaseAdmin
          .from("user_position_histories")
          .select("user_id,week_start_date")
          .eq("organization", organization)
          .in("week_start_date", weekStarts)
          .order("week_start_date", { ascending: true })
          .order("user_id", { ascending: true })
          .range(from, from + 999);
        if (error) throw new Error(error.message);
        const batch = (data ?? []) as Array<{ user_id: string; week_start_date: string }>;
        for (const r of batch)
          byWeek.get(String(r.week_start_date).slice(0, 10))?.add(r.user_id);
        if (batch.length < 1000) break;
      }
      return byWeek;
    })(),
    loadOrgOverrideRowsUpTo(organization, maxWeek),
  ]);

  const orgProfileIds = ((positionCandidates ?? []) as Array<{ user_id: string }>).map(
    (row) => row.user_id,
  );
  // override 대상자(주차별) — (유저×팀) carry-forward 판정. **시즌 경계 적용**(SEASON BOUNDARY):
  //   직전 시즌 override 는 새 시즌으로 상속되지 않으므로 후보 산정에서도 같은 규칙을 쓴다.
  //   ⚠ 여기와 resolvePositionAtWeeksBulk 가 같은 규칙이어야 "후보엔 있는데 소속은 안 잡히는" 유령이 없다.
  const overrideIndex = buildOverrideIndex(overrideRows, (r) => `${r.userId}::${r.rawTeam}`);
  const seasonKeyOf = await buildSeasonKeyResolver([
    ...weekStarts,
    ...overrideRows.map((r) => r.weekStartDate),
  ]);
  const overrideUsersByWeek = new Map<string, Set<string>>();
  for (const ws of weekStarts) {
    const set = new Set<string>();
    for (const arr of overrideIndex.values()) {
      const hit = resolveOverrideAt(arr, ws, seasonKeyOf);
      if (hit) set.add(hit.userId);
    }
    overrideUsersByWeek.set(ws, set);
  }

  const scopedByWeek = new Map<string, string[]>();
  const allScoped = new Set<string>();
  for (const ws of weekStarts) {
    const ids = Array.from(
      new Set([
        ...orgProfileIds,
        ...(uphUsersByWeek.get(ws) ?? new Set<string>()),
        ...(overrideUsersByWeek.get(ws) ?? new Set<string>()),
      ]),
    ).filter((userId) => scopeSet.includes(userId));
    scopedByWeek.set(ws, ids);
    for (const id of ids) allScoped.add(id);
  }

  // 집합 ① 팀·파트 활동 가능 모집단 — 시즌 휴식 + (효력 발생 후) 활동 중단 제외.
  //   ⚠ 엘리트/바사노스는 **여기서 빼지 않는다**(소속·평가자/운영자 역할 유지). 그 둘은 집합 ②(평가) 축이다.
  //   ⚠ 기준 시점은 각 주차다 — 현재 상태를 과거 주차에 소급하지 않는다(lib/evaluationEligibility).
  const allScopedIds = [...allScoped];
  const eligibilityByWeek = await loadTeamActivityEligibilityBulk({
    userIds: allScopedIds,
    weeks,
    today: opts.today,
  });

  const candidateByWeek = new Map<string, string[]>();
  const allCandidates = new Set<string>();
  for (const ws of weekStarts) {
    const el = eligibilityByWeek.get(ws);
    const ids = (scopedByWeek.get(ws) ?? []).filter((userId) => el?.isTeamActive(userId) ?? true);
    candidateByWeek.set(ws, ids);
    for (const id of ids) allCandidates.add(id);
  }

  const positionsByWeek = await resolvePositionAtWeeksBulk({
    userIds: [...allCandidates],
    weekStarts,
    organization,
  });

  for (const ws of weekStarts) {
    const positions = positionsByWeek.get(ws);
    if (!positions) continue;
    for (const uid of candidateByWeek.get(ws) ?? []) {
      const position = positions.get(uid);
      if (!position) continue;
      const code = crewPositionCodeOrNull(position.positionCode);
      if (code === null) continue; // 운영진/관리자 등 = 크루 아님(미집계)
      const resolvedTeam = position.teamName ?? "";
      for (const teamName of teamNames) {
        if (resolvedTeam !== teamName && stripParen(resolvedTeam) !== stripParen(teamName)) continue;
        out
          .get(teamWeekRosterKey(teamName, ws))
          ?.push({ userId: uid, positionCode: code, rawPart: position.partName });
      }
    }
  }
  return out;
}

// 그 주차 · 그 팀의 effective 크루 로스터. 구현은 벌크(팀 1 × 주차 1) 위임 — 규칙을 두 벌 두지 않는다.
async function loadTeamWeekRosterAt(
  organization: OrganizationSlug,
  teamName: string,
  weekStart: string,
  seasonKey: string | null,
  mode: ScopeMode,
  today?: string,
): Promise<TeamWeekRosterMember[]> {
  const byKey = await loadTeamWeekRostersBulk({
    organization,
    teamNames: [teamName],
    weeks: [{ weekStartDate: weekStart, seasonKey }],
    mode,
    today,
  });
  return byKey.get(teamWeekRosterKey(teamName, weekStart)) ?? [];
}

// <운용> 파트 집계 — 로스터에서 파트별 distinct 크루 수. '일반' 우선, 그다음 크루 수 내림차순.
//   [A] 주차 요약도 파트×주차 존재표도 이 함수 하나로 집계한다(정렬·필터 규칙 복제 금지).
export function operatedPartsFromRoster(
  members: ReadonlyArray<{ userId: string; rawPart: string | null }>,
): Array<{ partName: string; crewCount: number }> {
  const partUsers = new Map<string, Set<string>>();
  for (const m of members) {
    const p = (m.rawPart ?? "").trim();
    if (!p) continue; // 파트 미배정(팀장 등) — 어떤 파트에도 넣지 않는다.
    const s = partUsers.get(p) ?? new Set<string>();
    s.add(m.userId);
    partUsers.set(p, s);
  }
  return [...partUsers.entries()]
    .map(([partName, ids]) => ({ partName, crewCount: ids.size }))
    .filter((p) => p.crewCount > 0)
    .sort((a, b) => {
      if (a.partName === DEFAULT_PART_NAME) return -1;
      if (b.partName === DEFAULT_PART_NAME) return 1;
      return b.crewCount - a.crewCount || a.partName.localeCompare(b.partName);
    });
}

// 주차 effective 로스터 공개 진입점 — weekId 미지정/목록 밖이면 현재 주차 폴백(요약과 동일 규칙).
export async function loadTeamWeekEffectiveRoster(opts: {
  organization: OrganizationSlug;
  teamName: string;
  weekId?: string | null;
  halfKey?: string | null;
  mode?: ScopeMode;
  today?: string;
}): Promise<TeamWeekRoster> {
  const { targetRow } = await resolveSelectableWeeks(opts);
  if (!targetRow || !targetRow.week_start_date) return { week: null, members: [] };
  const members = await loadTeamWeekRosterAt(
    opts.organization,
    opts.teamName,
    targetRow.week_start_date,
    targetRow.season_key ?? null,
    opts.mode ?? "operating",
    opts.today,
  );
  return {
    week: {
      weekId: targetRow.week_id,
      weekStartDate: targetRow.week_start_date,
      seasonKey: targetRow.season_key ?? null,
      isCurrentWeek: targetRow.is_current_week,
    },
    members,
  };
}

export async function getTeamSelectedWeekSummary(opts: {
  organization: OrganizationSlug;
  teamName: string;
  weekId?: string | null;
  halfKey?: string | null;
  mode?: ScopeMode;
  today?: string;
}): Promise<TeamSelectedWeekSummary> {
  const { organization, teamName } = opts;
  const mode = opts.mode ?? "operating";

  // 1~2) 선택 가능 주차 + 대상 주차.
  const { selectableWeeks, targetRow } = await resolveSelectableWeeks(opts);
  if (!targetRow || !targetRow.week_start_date) {
    return { selectableWeeks, week: null, ...emptyBody() };
  }
  const weekStart = targetRow.week_start_date;
  const isCurrentWeek = targetRow.is_current_week;

  // 3) 검수 완료(org·scope) — 레거시 주차는 weeks.result_published_at 폴백.
  const scope = resolveOrgResultScope(mode);
  const [states, legacyRow] = await Promise.all([
    loadWeekOrgResultStates([targetRow.week_id], organization, scope),
    supabaseAdmin.from("weeks").select("result_published_at").eq("id", targetRow.week_id).limit(1),
  ]);
  const legacyPublished =
    ((legacyRow.data ?? []) as Array<{ result_published_at: string | null }>)[0]
      ?.result_published_at != null;
  const reviewStatus = resolveWeekOrgResultState(
    states.get(targetRow.week_id),
    weekStart,
    legacyPublished,
  ).status;
  const reviewCompleted = reviewStatus === "published";

  const week = {
    weekId: targetRow.week_id,
    label: targetRow.week_label,
    weekNumber: targetRow.week_number,
    seasonLabel: targetRow.season_label,
    weekStartDate: weekStart,
    isCurrentWeek,
    reviewCompleted,
    canEdit: !reviewCompleted,
  };

  // 4~5) effective 로스터 — 공용 SoT(loadTeamWeekRosterAt) 단일 호출. 파트 카탈로그(운용 파트)·파트별
  //      크루 목록(실무 경험 평가 대상)도 같은 함수를 판다 — 화면별 후보 풀을 다시 만들지 않는다.
  //      그 주차 시즌의 시즌 휴식자는 여기서 이미 빠진다(팀 크루 수·파트 크루 수·<운용> 파트 전부 반영).
  const rosterMembers = await loadTeamWeekRosterAt(
    organization,
    teamName,
    weekStart,
    targetRow.season_key ?? null,
    mode,
    opts.today,
  );
  const effectiveByUser = new Map(
    rosterMembers.map((m) => [m.userId, { positionCode: m.positionCode, rawPart: m.rawPart }] as const),
  );

  // 집계 — 전체 크루(정규+심화·운영진 제외·userId 고유).
  const crewUserIds = new Set<string>();
  let regular = 0;
  let advanced = 0;
  for (const [uid, v] of effectiveByUser) {
    if (isCrewPosition(v.positionCode)) {
      crewUserIds.add(uid);
      if (isAdvancedPosition(v.positionCode)) advanced++;
      else regular++;
    }
  }
  const crew = { total: regular + advanced, regular, advanced };

  // 6) 성장 결과(uws) — 크루 로스터 기준. success/fail/personal_rest/official_rest 확정, 나머지=running/tallying.
  const growth = { success: 0, failure: 0, rest: 0, running: 0, tallying: 0 };
  const crewIds = [...crewUserIds];
  const confirmed = new Set<string>();
  const uwsStatusByUser = new Map<string, string>(); // [B] 주차 결과 표시용(검수 후).
  for (let i = 0; i < crewIds.length; i += 100) {
    const chunk = crewIds.slice(i, i + 100);
    if (chunk.length === 0) break;
    const { data: uws } = await supabaseAdmin
      .from("user_week_statuses")
      .select("user_id,status")
      .eq("week_start_date", weekStart)
      .in("user_id", chunk);
    for (const u of (uws ?? []) as Array<{ user_id: string; status: string | null }>) {
      if (u.status) uwsStatusByUser.set(u.user_id, u.status);
      if (confirmed.has(u.user_id)) continue;
      if (u.status === "success") {
        growth.success++;
        confirmed.add(u.user_id);
      } else if (u.status === "fail") {
        growth.failure++;
        confirmed.add(u.user_id);
      } else if (u.status === "personal_rest" || u.status === "official_rest") {
        growth.rest++;
        confirmed.add(u.user_id);
      }
    }
  }
  const unresolved = crewUserIds.size - confirmed.size;
  if (isCurrentWeek) growth.running = unresolved;
  else growth.tallying = unresolved;

  // 7) 운용 파트(배정 크루 ≥1) — 공용 집계기(파트×주차 존재표와 동일 함수).
  const operatedParts = operatedPartsFromRoster(rosterMembers);

  // 8) [B] 크루 행 — "팀 파트 배정 가능" 크루만(집합②: 시즌휴식·주차휴식·활동중단·엘리트·바사노스 제외).
  //    ⚠ crew.total/growth/operatedParts(위 5~7단계)는 집합①(팀·파트 활동 가능 — 엘리트·바사노스 유지) 그대로다.
  //      [B] 편집표는 "이번 주 누구를 어느 파트에 배정할지 고르는 화면"이라 의미가 다르다 — 졸업·엘리트·
  //      바사노스·활동 중단 크루는 소속은 유지되어도(집합①) **신규 배정 대상은 아니다**(집합②). 두 집합이
  //      우연히 조건이 같아 lib/evaluationEligibility 를 그대로 재사용한다(중복 구현 금지) — 조건이 갈리면
  //      그때 이 화면 전용 함수로 분리할 것. 판정 기준 시점은 **선택 주차의 시즌**(현재 시점 소급 없음),
  //      과거 주차를 조회하면 그 시점엔 활동 중이었던 이력이 그대로 보인다.
  const assignEligibility = crewIds.length
    ? await loadEvaluationEligibility({
        userIds: crewIds,
        weekStartDate: weekStart,
        seasonKey: targetRow.season_key ?? null,
        today: opts.today,
      })
    : null;
  const assignableCrewIds = crewIds.filter((uid) => assignEligibility?.isEvaluable(uid) ?? true);

  //    ⚠ 파트/클래스는 effective(override ?? UPH), 프로필/품계/결과는 기존 SoT. 결과류는 검수 완료 전 null(-).
  const basics = await getLeaderBasicsBatch(assignableCrewIds);
  // 조회 전용 결과류 — 검수 완료 주차만 batch(N+1 없음). 미완료 주차는 호출 자체를 생략 → 전부 null('-').
  //   · 3종(성장 성공·라인 강화율·액트 체크율) = weekly-cards snapshot SoT.
  //   · 품계 = **주차 확정 품계 이력**(user_week_grade_histories) — 현재값(user_grade_stats) fallback 금지.
  //     이력 행 없으면 '-'(지시 #5·#9). 게이트 전(reviewCompleted=false)엔 조회하지 않는다.
  const [weekResults, gradeHistory] =
    reviewCompleted && weekStart
      ? await Promise.all([
          loadWeeklyCrewResults({ userIds: assignableCrewIds, weekStartDate: weekStart }),
          loadWeekGradeHistory({ userIds: assignableCrewIds, weekStartDate: weekStart }),
        ])
      : [new Map<string, WeeklyCrewResult>(), new Map<string, WeekGradeHistoryEntry>()];
  const crewRows: CrewRow[] = assignableCrewIds
    .map((uid) => {
      const eff = effectiveByUser.get(uid);
      const b = basics.get(uid);
      const wr = weekResults.get(uid);
      const gh = gradeHistory.get(uid);
      const code = (eff?.positionCode ?? "regular") as PositionCode;
      return {
        userId: uid,
        name: b?.name ?? null,
        gender: b?.gender ?? null,
        birth6: b?.birth6 ?? null,
        school: b?.school ?? null,
        major: b?.major ?? null,
        residence: b?.residence ?? null,
        rawPart: eff?.rawPart ?? null,
        positionCode: code,
        classLabel: resolvePositionLabels({ positionCode: code }).classLabel,
        // 검수 완료 후에만 결과류 공개(#21). 성장성공수/라인강화율/액트체크율 = snapshot SoT(weekResults).
        //   품계 = 주차 확정 품계 이력(gradeHistory). gradeRank=grade(1=정승…10=정9품, 정렬용).
        //   현재값 fallback 금지 — 이력 없으면 null('-').
        gradeLabel: reviewCompleted ? gh?.gradeLabel ?? null : null,
        gradeRank: reviewCompleted ? gh?.grade ?? null : null,
        weekResult: reviewCompleted ? weekResultLabel(uwsStatusByUser.get(uid)) : null,
        growthSuccessCount: wr?.growthSuccessCount ?? null,
        lineEnhancementRate: wr?.lineEnhancementRate ?? null,
        actCheckRate: wr?.actCheckRate ?? null,
      };
    })
    .sort((a, b) =>
      (a.rawPart ?? "").localeCompare(b.rawPart ?? "") || (a.name ?? "").localeCompare(b.name ?? ""),
    );

  return { selectableWeeks, week, crew, growth, operatedParts, crewRows };
}

// ── 주차 기준 <운용> 파트명 목록 (실무 경험 파트 스코프 공용 SoT) ──────────────────
//   getTeamSelectedWeekSummary.operatedParts(그 주차 배정 크루 ≥1) 파생 — 팀 상세 매트릭스와 동일 판정.
//   '일반'(DEFAULT_PART_NAME)은 실제 파트가 아니므로 제외(experience 파트 드롭다운/확장 규칙과 동일).
//   ⚠ 기준은 현재 시점이 아니라 조회 중인 weekId 다(과거/현재 주차별로 달라짐). weekId 미지정/목록밖이면
//     현재 주차로 폴백(요약과 동일). mode 는 모집단 스코프에만 영향(operating/test 동일 판정 로직·§8).
export async function listOperatedTeamParts(opts: {
  organization: OrganizationSlug;
  teamName: string;
  weekId?: string | null;
  mode?: ScopeMode;
  today?: string;
}): Promise<string[]> {
  const summary = await getTeamSelectedWeekSummary({
    organization: opts.organization,
    teamName: opts.teamName,
    weekId: opts.weekId ?? null,
    mode: opts.mode,
    today: opts.today,
  });
  return summary.operatedParts
    .map((p) => p.partName)
    .filter((p) => p !== DEFAULT_PART_NAME)
    .sort((a, b) => a.localeCompare(b));
}

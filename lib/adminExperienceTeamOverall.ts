// 실무 경험 [팀 총괄] — 데이터 레이어(standalone).
//
// 개설 검수 완료(고객 미반영) · 개설 완료(고객 반영) · 개설 취소(원복) 상태를 다음 3+1 테이블로 관리한다.
//   cluster4_experience_team_overall              (헤더: org+week+team, status)
//   cluster4_experience_team_overall_cells        (팀장 직접 입력: management/extension 셀)
//   cluster4_experience_team_overall_outputs      (카테고리별 아웃풋 링크/설명)
//   cluster4_experience_team_overall_opened_lines (개설 완료로 생성한 cluster4_lines 추적 — 취소 원복용)
//
// 도출/분석/견문 셀은 저장하지 않는다 — 항상 파트 신청(cluster4_experience_part_submissions)에서 라이브로 읽는다.
//
// 고객 반영(개설 완료)은 기존 라인 개설 구조(cluster4_lines · cluster4_line_targets ·
// cluster4_experience_line_evaluations)를 재사용한다. snapshot 은 markWeeklyCardsSnapshotStaleMany
// (저렴) + 기존 lazy recompute 경로에 위임 — 생성/조회 로직 변경 없음.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadCurrentWeekOverrideLabels } from "@/lib/positionResolver";
import { QA_HIDE_REAL_USERS } from "@/lib/qaFixedScope";
import {
  assertUserIdsInScope,
  resolveUserScope,
  type ScopeMode,
} from "@/lib/userScope";
import { invalidateWeeklyCardsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";
import { payLineOpenTargetsOnce } from "@/lib/processPointAccrual";
import { convergeLineChangeForUsers } from "@/lib/lineChangeDerivation";
import { invalidateWeeklyCardsForLineOpen } from "@/lib/adminCluster4LinesData";
import { assertWeekOpenable } from "@/lib/cluster4OfficialRestWeek";
import {
  assertExperienceLineOpenable,
  resolveExperienceLineOpenGate,
  EXPERIENCE_LINE_NOT_OPEN_REASON,
} from "@/lib/experienceLineOpenGate";
import { resolvePositionLabels } from "@/lib/adminMembersTypes";
import { resolveOutputLinks } from "@/lib/cluster4OutputLinks";
import { insertExperienceOpeningLog } from "@/lib/adminExperienceOpeningLogs";
import { getCurrentSeasonRestUserIds } from "@/lib/currentSeasonRest";
import {
  EXPERIENCE_OVERALL_CATEGORIES,
  OVERALL_APPLICATION_INCOMPLETE_MESSAGE,
  OVERALL_NO_TARGET_PARTS_MESSAGE,
  OVERALL_CELL_DEFAULT,
  OVERALL_LEADER_CATEGORIES,
  OVERALL_PART_CATEGORIES,
  canEditOverallManagement,
  resolveOverallApplicationReadiness,
  validateOverallOutputRequirements,
  validatePartLeaderLineRequirements,
  type ExperienceOverallCategory,
  type ExperienceTeamOverallBoard,
  type OverallApplicationReadiness,
  type OverallBoardCrew,
  type OverallBoardPart,
  type OverallCell,
  type OverallLeaderCellDto,
  type OverallLineSelectionDto,
  type OverallOutput,
} from "@/lib/experienceTeamOverallTypes";
import {
  buildLineIdCategoryMap,
  listExperienceOverallLineOptions,
} from "@/lib/adminExperienceLineData";
import { updateOverallPartCellLines } from "@/lib/adminExperiencePartInput";
import { experienceScoreState } from "@/lib/experiencePartInputTypes";

// part_submissions line_type(도출/분석/견문) ↔ overall category 동일 키.
type PartLineType = "derivation" | "analysis" | "evaluation";

const EXCLUDED_PART_NAMES = new Set<string>(["일반"]);

// 팀 총괄 평가 대상 = 일반/에이전트/파트장(팀장·관리자 제외). 상태 라벨 + 파트장 여부 반환.
function overallMemberStatus(
  role: string | null,
  membershipLevel: string | null,
  // 현재 주차 override 의 position_code. 있으면 멤버십 대신 이 값으로 판정한다
  //   — 평가 대상 선별·파트장 여부가 화면 클래스와 갈리지 않게 한다(현재 상태 화면 규칙).
  overridePositionCode?: string | null,
): { label: string; isPartLeader: boolean } | null {
  // ⚠ 라벨 문자열이 아니라 positionCode 로 판정한다(어휘 2종 혼선 원천 차단).
  const code = resolvePositionLabels({
    positionCode: overridePositionCode ?? null,
    role,
    membershipLevel,
  }).positionCode;
  if (code === "regular") return { label: "일반", isPartLeader: false };
  if (code === "advanced_agent") return { label: "에이전트", isPartLeader: false };
  if (code === "advanced_part_leader") return { label: "파트장", isPartLeader: true };
  // 팀장/관리자/앰배서더/크루(등급미상) 등은 평가 대상 아님.
  return null;
}

type OverallMemberRow = {
  userId: string;
  displayName: string;
  partName: string;
  statusLabel: string;
  isPartLeader: boolean;
};

// (org, teamName) 의 활동 멤버(파트장 포함) — user_profiles(role) + user_memberships(현재행).
// adminExperiencePartInput.loadTeamCrewRows 와 동일 소스이나 파트장을 포함한다(팀 총괄 요구).
// 팀 코호트(라인 개설 후보) — 팀장/관리자·휴식·제외 파트를 뺀 크루 목록(statusLabel/isPartLeader 포함).
//   실무 경험 라인칸 "개설 가능 크루" 모수 계산에 재사용(관리 라인 = 심화 크루만).
export async function loadTeamMembersWithLeaders(
  organization: string,
  teamName: string,
  mode: ScopeMode = "operating",
): Promise<OverallMemberRow[]> {
  let profileQuery = supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name,role")
    .order("display_name", { ascending: true });
  if (organization) profileQuery = profileQuery.eq("organization_slug", organization);
  const { data: profiles, error: profileError } = await profileQuery;
  if (profileError) throw new Error(profileError.message);
  const profs = (profiles ?? []) as Array<{
    user_id: string;
    display_name: string | null;
    role: string | null;
  }>;
  if (profs.length === 0) return [];

  const userIds = profs.map((p) => p.user_id);
  const { data: memberships, error: memError } = await supabaseAdmin
    .from("user_memberships")
    .select("user_id,team_name,part_name,membership_level,membership_state,is_current")
    .in("user_id", userIds);
  if (memError) throw new Error(memError.message);

  // 모집단 스코프(operating=실사용자만 / test=테스트 유저만) — userScope resolver(SoT=test_user_markers).
  // org 필터는 위 profileQuery 가 적용하므로 scope.org=null(includes 판정은 org 무관).
  const scope = await resolveUserScope(mode, null);
  // 라인 개설 후보 = 현재 시즌 전체 휴식자 제외(season_key 기준·growth_status 미사용·과거 무소급).
  const restIds = await getCurrentSeasonRestUserIds();

  type MemRow = {
    user_id: string;
    team_name: string | null;
    part_name: string | null;
    membership_level: string | null;
    membership_state: string | null;
    is_current: boolean | null;
  };
  const memMap = new Map<string, MemRow>();
  for (const m of (memberships ?? []) as MemRow[]) {
    const existing = memMap.get(m.user_id);
    if (!existing || (m.is_current && !existing.is_current)) memMap.set(m.user_id, m);
  }

  // 현재 주차 파트/클래스 override — 평가 대상 선별·파트장 판정에 반영(현재 상태 화면 규칙).
  const weekOverrides = await loadCurrentWeekOverrideLabels(profs.map((p) => p.user_id), organization);
  const rows: OverallMemberRow[] = [];
  for (const p of profs) {
    // 모집단 스코프: operating=실사용자만 / test=테스트 유저만.
    if (!scope.includes(p.user_id)) continue;
    if (restIds.has(p.user_id)) continue; // 현재 시즌 전체 휴식자 제외(라인 개설 후보 아님).
    const m = memMap.get(p.user_id);
    if (!m || m.team_name !== teamName) continue;
    if (m.membership_state === "rest") continue; // 휴식 제외(active 만).
    const ovr = weekOverrides.get(p.user_id) ?? null;
    // ⚠ 클래스만 override 를 따르고 파트는 멤버십을 쓰면, 같은 사람이 화면마다 다른 파트로 잡힌다
    //   (실측 2026-07-22: 회원목록 "아트" vs 팀 총괄 "무드"). 파트도 같은 SoT 를 쓴다.
    const part = (ovr ? ovr.rawPart : m.part_name)?.trim() ?? "";
    if (!part || EXCLUDED_PART_NAMES.has(part)) continue;
    const status = overallMemberStatus(p.role, m.membership_level, ovr?.positionCode ?? null);
    if (!status) continue; // 팀장/관리자 등 제외.
    rows.push({
      userId: p.user_id,
      displayName: p.display_name ?? "(이름 없음)",
      partName: part,
      statusLabel: status.label,
      isPartLeader: status.isPartLeader,
    });
  }
  return rows;
}

// ── 파트 신청 셀(도출/분석/견문) 라이브 조회 → crew_user_id::category 맵 ──
async function loadPartSubmissionCells(
  organization: string,
  weekId: string,
  teamId: string,
): Promise<{ cells: Map<string, OverallCell>; submittedParts: Set<string> }> {
  const cells = new Map<string, OverallCell>();
  const submittedParts = new Set<string>();
  const { data: headers } = await supabaseAdmin
    .from("cluster4_experience_part_submissions")
    .select("id,part_name")
    .eq("organization_slug", organization)
    .eq("week_id", weekId)
    .eq("team_id", teamId);
  const headerRows = (headers ?? []) as Array<{ id: string; part_name: string }>;
  if (headerRows.length === 0) return { cells, submittedParts };
  for (const h of headerRows) submittedParts.add(h.part_name);

  const headerIds = headerRows.map((h) => h.id);
  const { data: cellRows } = await supabaseAdmin
    .from("cluster4_experience_part_submission_cells")
    .select("crew_user_id,line_type,checked,score,selected_line_id")
    .in("submission_id", headerIds);
  for (const c of (cellRows ?? []) as Array<{
    crew_user_id: string;
    line_type: PartLineType;
    checked: boolean;
    score: number;
    selected_line_id: string | null;
  }>) {
    cells.set(`${c.crew_user_id}::${c.line_type}`, {
      checked: c.checked,
      score: c.score,
      selectedLineId: c.selected_line_id ?? null,
    });
  }
  return { cells, submittedParts };
}

// ── 총괄 헤더 + 팀장 셀 + 아웃풋 조회 ──
type OverallStored = {
  id: string | null;
  status: "reviewed" | "opened" | null;
  reviewedAt: string | null;
  openedAt: string | null;
  leaderCells: Map<string, OverallCell>; // key = crewUserId::category(management|extension)
  outputs: Map<ExperienceOverallCategory, { link: string; description: string; imageUrl: string; imageDescription: string }>;
};

async function loadOverallStored(
  organization: string,
  weekId: string,
  teamId: string,
): Promise<OverallStored> {
  const empty: OverallStored = {
    id: null,
    status: null,
    reviewedAt: null,
    openedAt: null,
    leaderCells: new Map(),
    outputs: new Map(),
  };
  const { data: header } = await supabaseAdmin
    .from("cluster4_experience_team_overall")
    .select("id,status,reviewed_at,opened_at")
    .eq("organization_slug", organization)
    .eq("week_id", weekId)
    .eq("team_id", teamId)
    .maybeSingle();
  const h = header as
    | { id: string; status: "reviewed" | "opened"; reviewed_at: string | null; opened_at: string | null }
    | null;
  if (!h) return empty;

  const leaderCells = new Map<string, OverallCell>();
  const { data: cellRows } = await supabaseAdmin
    .from("cluster4_experience_team_overall_cells")
    .select("crew_user_id,category,checked,score,selected_line_id")
    .eq("overall_id", h.id);
  for (const c of (cellRows ?? []) as Array<{
    crew_user_id: string;
    category: "management" | "extension";
    checked: boolean;
    score: number;
    selected_line_id: string | null;
  }>) {
    leaderCells.set(`${c.crew_user_id}::${c.category}`, {
      checked: c.checked,
      score: c.score,
      selectedLineId: c.selected_line_id ?? null,
    });
  }

  const outputs = new Map<ExperienceOverallCategory, { link: string; description: string; imageUrl: string; imageDescription: string }>();
  const { data: outRows } = await supabaseAdmin
    .from("cluster4_experience_team_overall_outputs")
    .select("category,output_link,output_description,output_image_url,output_image_description")
    .eq("overall_id", h.id);
  for (const o of (outRows ?? []) as Array<{
    category: ExperienceOverallCategory;
    output_link: string | null;
    output_description: string | null;
    output_image_url: string | null;
    output_image_description: string | null;
  }>) {
    outputs.set(o.category, {
      link: o.output_link ?? "",
      description: o.output_description ?? "",
      imageUrl: o.output_image_url ?? "",
      imageDescription: o.output_image_description ?? "",
    });
  }

  return {
    id: h.id,
    status: h.status,
    reviewedAt: h.reviewed_at,
    openedAt: h.opened_at,
    leaderCells,
    outputs,
  };
}

// ── 확장 주간 판정(상태창 SoT 와 동일 — extension periods 와 대상 주차 [월~일] overlap) ──
async function resolveExtension(
  organization: string,
  weekStart: string,
  weekEnd: string,
): Promise<{ active: boolean; kind: "online" | "offline" | null }> {
  try {
    let q = supabaseAdmin
      .from("cluster4_experience_extension_periods")
      .select("extension_kind,start_date,end_date,organization_slug")
      .eq("is_active", true);
    q = organization
      ? q.or(`organization_slug.is.null,organization_slug.eq.${organization}`)
      : q.is("organization_slug", null);
    const { data, error } = await q;
    if (error) throw error;
    const matched = ((data ?? []) as Array<{
      extension_kind: "online" | "offline";
      start_date: string;
      end_date: string;
    }>).find((p) => p.start_date <= weekEnd && p.end_date >= weekStart);
    if (matched) return { active: true, kind: matched.extension_kind };
  } catch (e) {
    // 테이블 미적용/조회 실패 — fail-closed(확장 비활성).
    console.warn(
      "[experience team-overall] extension lookup skipped:",
      e instanceof Error ? e.message : e,
    );
  }
  return { active: false, kind: null };
}

/** 개설 검수/완료 공통 서버 가드. 어떤 mode/org 요청도 동일한 정책으로 DB write 전에 차단한다. */
async function assertOverallOutputsRequired(input: {
  organization: string;
  weekId: string;
  outputs: OverallOutput[];
}): Promise<void> {
  const weekDates = await loadWeekDates(input.weekId);
  if (!weekDates) {
    throw Object.assign(new Error("주차 정보를 찾을 수 없습니다"), { status: 404 });
  }
  const extension = await resolveExtension(
    input.organization,
    weekDates.startDate,
    weekDates.endDate,
  );
  const issue = validateOverallOutputRequirements(input.outputs, extension.active);
  if (issue) throw Object.assign(new Error(issue.message), { status: 422 });
}

/** 파트장 라인명 필수 서버 가드. mode 별 사용자 스코프는 기존 멤버 조회 SoT를 그대로 사용한다. */
async function assertPartLeaderLinesRequired(input: {
  organization: string;
  teamName: string;
  mode?: ScopeMode;
  lineSelections?: OverallLineSelectionDto[];
}): Promise<void> {
  const members = await loadTeamMembersWithLeaders(
    input.organization,
    input.teamName,
    input.mode ?? "operating",
  );
  const issue = validatePartLeaderLineRequirements(
    input.lineSelections ?? [],
    members.filter((member) => member.isPartLeader).map((member) => member.userId),
  );
  if (issue) throw Object.assign(new Error(issue.message), { status: 422 });
}

async function loadWeekDates(
  weekId: string,
): Promise<{ startDate: string; endDate: string } | null> {
  const { data } = await supabaseAdmin
    .from("weeks")
    .select("start_date,end_date")
    .eq("id", weekId)
    .maybeSingle();
  const w = data as { start_date: string; end_date: string } | null;
  return w ? { startDate: w.start_date, endDate: w.end_date } : null;
}

// ── 실제 배정·개설된 experience 라인(line_targets SoT) → user::category → 배정 라인 id(bridged_master_id) ──
//   팀 총괄 화면 라인명 표시 fallback 원천. 셀의 selected_line_id 가 없어도(구 개설 데이터·미러 누락)
//   실제 개설된 라인명을 트리거에 그대로 노출하기 위한 것. **표시 전용** — 개설/검수 판정엔 쓰지 않는다.
//   · 매핑 = cluster4_line_targets(week, target_user) → cluster4_lines(experience, team) →
//            experience_line_master_id(= line_registrations.bridged_master_id = 옵션 id).
//   · 카테고리(도출/분석/견문/관리/확장)는 옵션 역맵(lineIdCategory)으로 판정 — 옵션에 있는 라인만
//     매핑해 트리거가 반드시 라인명으로 해석되도록 보장(옵션 밖 raw id 노출 방지).
//   · org/mode 무관: (week, team) 스코프 + 대상 crew userId 교집합으로만 좁힌다(대상=이미 스코프 필터됨).
export async function loadOpenedLineMasterByUserCategory(
  weekId: string,
  teamId: string,
  lineIdCategory: Map<string, ExperienceOverallCategory>,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  // 이 팀의 활성 experience 라인 → master id.
  const { data: lineRows } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id,experience_line_master_id")
    .eq("part_type", "experience")
    .eq("team_id", teamId)
    .eq("is_active", true)
    .not("experience_line_master_id", "is", null);
  const lines = (lineRows ?? []) as Array<{ id: string; experience_line_master_id: string }>;
  if (lines.length === 0) return map;
  const masterByLine = new Map(lines.map((l) => [l.id, l.experience_line_master_id]));

  // 대상 주차의 사용자 대상자.
  const { data: targetRows } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("line_id,target_user_id")
    .eq("week_id", weekId)
    .eq("target_mode", "user")
    .in("line_id", Array.from(masterByLine.keys()));
  for (const t of (targetRows ?? []) as Array<{ line_id: string; target_user_id: string | null }>) {
    if (!t.target_user_id) continue;
    const masterId = masterByLine.get(t.line_id);
    if (!masterId) continue;
    // 옵션에 존재하는 라인만(=트리거가 라인명으로 해석 가능) + 카테고리 판정.
    const category = lineIdCategory.get(masterId);
    if (!category) continue;
    map.set(`${t.target_user_id}::${category}`, masterId);
  }
  return map;
}

// 빈 5-카테고리 셀(기본값).
function defaultCells(): Record<ExperienceOverallCategory, OverallCell> {
  const out = {} as Record<ExperienceOverallCategory, OverallCell>;
  for (const c of EXPERIENCE_OVERALL_CATEGORIES) {
    out[c.key] = { ...OVERALL_CELL_DEFAULT };
  }
  return out;
}

// ⑨ 관리(management) 류 라인명은 클래스(파트장/에이전트)에 따라 고정한다 — 사용자가 변경할 수 없다.
//   파트장 → _파트장 라인(line_code …EL0001 / line_name '파트장'), 에이전트 → _에이전트 라인(…EL0002 / '에이전트').
//   일반(비관리직)은 관리 대상이 아니므로 null(관리 셀은 UI 에서도 비활성). 매칭 규칙은 개설 완료 라우팅
//   (isPartLeaderLine/isAgentLine)과 동일하게 line_code 앵커 + 이름 토큰을 쓴다(라인명 변경에 의존하지 않음).
//   반환 = 옵션 id(bridged_master_id) — getTeamOverallBoard 가 관리 셀 selected_line_id 로 강제해
//   화면 표시와 개설 완료(라인 그룹핑)가 동일 라인을 쓰게 한다(사용자 선택 무시).
function resolveFixedManagementLineId(
  options: ReadonlyArray<{ id: string; lineName: string; lineCode: string | null }>,
  crew: { isPartLeader: boolean; statusLabel: string },
): string | null {
  const matchLeader = (o: { lineName: string; lineCode: string | null }) =>
    o.lineName.includes("파트장") || (o.lineCode?.endsWith("EL0001") ?? false);
  const matchAgent = (o: { lineName: string; lineCode: string | null }) =>
    o.lineName.includes("에이전트") || (o.lineCode?.endsWith("EL0002") ?? false);
  if (crew.isPartLeader) return options.find(matchLeader)?.id ?? null;
  if (crew.statusLabel === "에이전트") return options.find(matchAgent)?.id ?? null;
  return null;
}

// ── 팀 총괄 보드 조립(merged crew cells 포함) ──
export async function getTeamOverallBoard(
  organization: string,
  weekId: string,
  teamId: string,
  teamName: string,
  mode: ScopeMode = "operating",
  // 표시 전용 fallback: 셀 selected_line_id 가 없을 때 실제 배정·개설된 라인(line_targets)으로 라인명을
  //   채운다. 개설/검수 판정(openTeamOverall 의 board 재조립)은 저장값만 써야 하므로 기본 false.
  //   화면 조회(GET route)만 true 로 켜 "이미 개설된 실제 라인명"이 트리거에 뜨게 한다(요구 §3·§6).
  resolveAssignedLineFallback = false,
): Promise<ExperienceTeamOverallBoard> {
  const [members, partCellsData, stored, weekDates, lineOptions] = await Promise.all([
    loadTeamMembersWithLeaders(organization, teamName, mode),
    loadPartSubmissionCells(organization, weekId, teamId),
    loadOverallStored(organization, weekId, teamId),
    loadWeekDates(weekId),
    // 라인명 드롭다운 옵션(5카테고리) — 개설 신청과 동일 원천(org+공통 활성 라인).
    listExperienceOverallLineOptions(organization),
  ]);

  const extension = weekDates
    ? await resolveExtension(organization, weekDates.startDate, weekDates.endDate)
    : { active: false, kind: null as "online" | "offline" | null };

  // 표시 전용: 실제 배정·개설된 라인(line_targets) → user::category → 라인 id. 셀에 selected_line_id 가
  //   비어도 "이미 개설된 라인명"을 표시하기 위한 fallback 원천(옵션 역맵으로 카테고리 판정·옵션 라인만).
  const assignedLineByUserCat = resolveAssignedLineFallback
    ? await loadOpenedLineMasterByUserCategory(
        weekId,
        teamId,
        buildLineIdCategoryMap(lineOptions),
      )
    : new Map<string, string>();

  // 셀 selected_line_id 를 우선 보존하고, 없을 때만 실제 배정 라인으로 채운다(요구 §4 — 기존 선택 무시 금지).
  const withAssignedFallback = (
    userId: string,
    category: ExperienceOverallCategory,
    cell: OverallCell,
  ): OverallCell => {
    if (cell.selectedLineId) return cell; // 저장된 선택값 우선.
    const assigned = assignedLineByUserCat.get(`${userId}::${category}`);
    return assigned ? { ...cell, selectedLineId: assigned } : cell;
  };

  // 파트별 그룹.
  const partMap = new Map<string, OverallBoardCrew[]>();
  for (const m of members) {
    const cells = defaultCells();
    // 도출/분석/견문 = 파트 신청 라이브(파트장/미신청은 기본값 유지).
    for (const cat of OVERALL_PART_CATEGORIES) {
      const saved = partCellsData.cells.get(`${m.userId}::${cat}`);
      if (saved) cells[cat] = saved;
      cells[cat] = withAssignedFallback(m.userId, cat, cells[cat]);
    }
    // 관리/확장 = 팀장 저장 셀(없으면 기본값).
    for (const cat of OVERALL_LEADER_CATEGORIES) {
      const saved = stored.leaderCells.get(`${m.userId}::${cat}`);
      if (saved) cells[cat] = saved;
      cells[cat] = withAssignedFallback(m.userId, cat, cells[cat]);
    }
    // ⑨ 관리 라인명 클래스 고정 — 저장/선택/배정값과 무관하게 클래스(파트장/에이전트) 라인으로 강제한다.
    //   화면(읽기전용 표시)과 개설 완료(selected_line_id 기준 라인 그룹핑)가 동일 라인을 쓰게 하는 단일 지점.
    //   일반(비관리직·null)은 그대로 두며(관리 셀은 UI 비활성) 점수/체크는 팀장 입력값을 보존한다.
    {
      const fixedMgmtLineId = resolveFixedManagementLineId(lineOptions.management, {
        isPartLeader: m.isPartLeader,
        statusLabel: m.statusLabel,
      });
      if (fixedMgmtLineId) {
        cells.management = { ...cells.management, selectedLineId: fixedMgmtLineId };
      }
    }
    const crew: OverallBoardCrew = {
      userId: m.userId,
      displayName: m.displayName,
      partName: m.partName,
      statusLabel: m.statusLabel,
      isPartLeader: m.isPartLeader,
      cells,
    };
    const list = partMap.get(m.partName) ?? [];
    list.push(crew);
    partMap.set(m.partName, list);
  }

  const parts: OverallBoardPart[] = Array.from(partMap.entries())
    .map(([partName, crews]) => ({
      partName,
      submitted: partCellsData.submittedParts.has(partName),
      // 파트장을 위로, 그다음 이름순.
      crews: crews.sort((a, b) =>
        a.isPartLeader === b.isPartLeader
          ? a.displayName.localeCompare(b.displayName)
          : a.isPartLeader
            ? -1
            : 1,
      ),
    }))
    .sort((a, b) => a.partName.localeCompare(b.partName));

  const outputs: OverallOutput[] = Array.from(stored.outputs.entries()).map(
    ([category, v]) => ({ category, link: v.link, description: v.description, imageUrl: v.imageUrl, imageDescription: v.imageDescription }),
  );

  // 개설 기간 판정(단일 SoT) — 이 주차·팀이 실무 경험 라인 개설 기간인가. 프론트 버튼 게이팅/차단 패널이
  //   그대로 소비하고, 서버 write 가드(openTeamOverall assertExperienceLineOpenable)와 동일 함수를 쓴다.
  const canOpen = await resolveExperienceLineOpenGate(organization, weekId, teamId);

  return {
    status: stored.status ?? "none",
    canOpen,
    openBlockedReason: canOpen ? null : EXPERIENCE_LINE_NOT_OPEN_REASON,
    extensionActive: extension.active,
    extensionKind: extension.kind,
    parts,
    // 대상 파트 신청 완료 판정 — 프론트가 그대로 소비(버튼 게이팅). 서버 가드와 동일 순수 함수 사용.
    application: resolveOverallApplicationReadiness(parts),
    outputs,
    lineOptions,
    reviewedAt: stored.reviewedAt,
    openedAt: stored.openedAt,
  };
}

// ── [개설 검수] 사전조건(대상 파트 신청 완료) 서버 판정 ──
//   getTeamOverallBoard.parts 와 동일 소스(loadTeamMembersWithLeaders + loadPartSubmissionCells)로
//   대상 파트 집합을 만든 뒤 board 와 같은 순수 함수(resolveOverallApplicationReadiness)로 판정한다.
//   → 프론트(board.application)와 서버 가드가 기준이 갈라지지 않는다.
export async function loadOverallApplicationReadiness(
  organization: string,
  weekId: string,
  teamId: string,
  teamName: string,
  mode: ScopeMode = "operating",
): Promise<OverallApplicationReadiness> {
  const [members, partCellsData] = await Promise.all([
    loadTeamMembersWithLeaders(organization, teamName, mode),
    loadPartSubmissionCells(organization, weekId, teamId),
  ]);
  const partNames = Array.from(new Set(members.map((m) => m.partName))).sort(
    (a, b) => a.localeCompare(b),
  );
  const parts = partNames.map((partName) => ({
    partName,
    submitted: partCellsData.submittedParts.has(partName),
  }));
  return resolveOverallApplicationReadiness(parts);
}

// ── 헤더 upsert + 팀장 셀/아웃풋 저장(replace) ──
async function persistReviewState(input: {
  organization: string;
  weekId: string;
  teamId: string;
  leaderCells: OverallLeaderCellDto[];
  outputs: OverallOutput[];
  status: "reviewed" | "opened";
  adminId: string | null;
}): Promise<string> {
  const now = new Date().toISOString();
  const headerPatch: Record<string, unknown> = {
    organization_slug: input.organization,
    week_id: input.weekId,
    team_id: input.teamId,
    status: input.status,
  };
  if (input.status === "reviewed") {
    headerPatch.reviewed_by = input.adminId;
    headerPatch.reviewed_at = now;
  } else {
    headerPatch.opened_by = input.adminId;
    headerPatch.opened_at = now;
  }
  const { data: header, error: headerError } = await supabaseAdmin
    .from("cluster4_experience_team_overall")
    .upsert(headerPatch, { onConflict: "organization_slug,week_id,team_id" })
    .select("id")
    .single();
  if (headerError || !header) {
    throw new Error(headerError?.message ?? "팀 총괄 헤더 저장 실패");
  }
  const overallId = (header as { id: string }).id;

  // 팀장 셀 replace(관리/확장만).
  const { error: delCellErr } = await supabaseAdmin
    .from("cluster4_experience_team_overall_cells")
    .delete()
    .eq("overall_id", overallId);
  if (delCellErr) throw new Error(delCellErr.message);
  const validCells = input.leaderCells.filter((c) =>
    (OVERALL_LEADER_CATEGORIES as string[]).includes(c.category),
  );
  if (validCells.length > 0) {
    // 관리/확장 라인명 정합성 — 선택 라인 유형은 반드시 셀 카테고리(관리/확장)와 일치(요구사항 §7).
    //   옵션 원천 = 개설 신청/검수/검증 공용 5카테고리 옵션(org+공통).
    const lineIdCategory = buildLineIdCategoryMap(
      await listExperienceOverallLineOptions(input.organization),
    );
    const rows = validCells.map((c) => {
      const score = Math.max(0, Math.min(10, Math.round(c.score)));
      // 보이드 규칙: 미체크/0점 = 강화 실패 → 라인 미선택(null).
      const selectedLineId = c.checked && score >= 1 ? c.selectedLineId ?? null : null;
      if (selectedLineId && lineIdCategory.get(selectedLineId) !== c.category) {
        throw Object.assign(
          new Error(
            "선택한 라인의 유형이 해당 평가 열과 일치하지 않습니다. 잘못된 라인 선택입니다.",
          ),
          { status: 422 },
        );
      }
      return {
        overall_id: overallId,
        crew_user_id: c.crewUserId,
        category: c.category,
        checked: c.checked,
        score,
        selected_line_id: selectedLineId,
      };
    });
    const { error: insCellErr } = await supabaseAdmin
      .from("cluster4_experience_team_overall_cells")
      .insert(rows);
    if (insCellErr) throw new Error(insCellErr.message);
  }

  // 아웃풋 replace(내용 있는 카테고리만).
  const { error: delOutErr } = await supabaseAdmin
    .from("cluster4_experience_team_overall_outputs")
    .delete()
    .eq("overall_id", overallId);
  if (delOutErr) throw new Error(delOutErr.message);
  const validOutputs = input.outputs.filter(
    (o) => o.link.trim() || o.description.trim() || o.imageUrl.trim() || o.imageDescription.trim(),
  );
  if (validOutputs.length > 0) {
    const { error: insOutErr } = await supabaseAdmin
      .from("cluster4_experience_team_overall_outputs")
      .insert(
        validOutputs.map((o) => ({
          overall_id: overallId,
          category: o.category,
          output_link: o.link.trim() || null,
          output_description: o.description.trim() || null,
          output_image_url: o.imageUrl.trim() || null,
          output_image_description: o.imageDescription.trim() || null,
        })),
      );
    if (insOutErr) throw new Error(insOutErr.message);
  }

  return overallId;
}

// 관리(management) 류는 파트장/에이전트 전용 — 일반 크루 관리 셀이 섞이면 fail-closed(422).
//   프론트 disable + payload 제외와 정합. 직접 호출/우회 요청도 여기서 차단(저장 전 검증 → DB write 금지).
//   확장(extension) 셀은 자격 무관 — 검사 대상 아님.
async function assertNoIneligibleManagementCells(
  organization: string,
  teamName: string,
  mode: ScopeMode,
  leaderCells: OverallLeaderCellDto[],
): Promise<void> {
  const mgmtCells = leaderCells.filter((c) => c.category === "management");
  if (mgmtCells.length === 0) return;
  const members = await loadTeamMembersWithLeaders(organization, teamName, mode);
  const byId = new Map(members.map((m) => [m.userId, m]));
  for (const cell of mgmtCells) {
    const m = byId.get(cell.crewUserId);
    // 보드에 없거나(평가 대상 아님) 일반 크루면 자격 부재 — 차단.
    const eligible = m
      ? canEditOverallManagement({
          statusLabel: m.statusLabel,
          isPartLeader: m.isPartLeader,
        })
      : false;
    if (!eligible) {
      throw Object.assign(
        new Error(
          "'관리' 류는 파트장/에이전트 전용입니다. 일반 크루의 관리 항목은 처리할 수 없습니다.",
        ),
        { status: 422 },
      );
    }
  }
}

// ── 파트장 도출/분석/견문 점수·라인 선택 저장(셀 find-or-create/update) ──
// 파트장(심화(파트장))은 파트 신청 그리드에서 구조적으로 제외되어 part_submission_cells 셀이 없다.
//   그래서 팀 총괄 보드에서 파트장 행의 도출/분석/견문 점수·라인명을 골라도
//   updateOverallPartCellLines(기존 셀만 갱신·라인만)가 스킵 → 점수·선택 미저장(완료 후 화면 초기화) →
//   개설 완료 시 대상자(cluster4_line_targets) 미생성 → 강화 실패로 표시되던 버그.
//   → "파트장"에 한해 그 파트의 신청 헤더를 find-or-create 하고 셀을 upsert 해
//     일반 크루와 동일한 단일 SoT(part_submission_cells)로 수렴시킨다. 점수는 payload(sel.score/checked)
//     로 전달된 파트장 선택값을 그대로 반영한다(하드코딩 7 폐지). payload 미지정 시에만 기본값
//     checked=true/score=7 = 보드 파트장 행 기본값(= OVERALL_CELL_DEFAULT)으로 처리 — 파트장 전용
//     임의 기본값을 새로 만들지 않는다. 점수·보이드 규칙은 일반 크루와 동일(experienceScoreState).
//   일반/에이전트는 이미 셀을 가지므로 여기서 손대지 않는다(점수 SoT=개설 신청 셀 · 라인만
//     updateOverallPartCellLines 담당). ⚠ 셀 upsert 로 재검수 시 파트장 점수/체크 변경이 반영된다.
async function materializePartLeaderPartCells(input: {
  organization: string;
  weekId: string;
  teamId: string;
  teamName: string;
  mode: ScopeMode;
  selections: OverallLineSelectionDto[];
}): Promise<void> {
  // 도출/분석/견문 선택 전부(라인 미선택 포함) — 파트장은 점수/체크만 바뀌어도 반영해야 한다.
  const partSelections = input.selections.filter((s) =>
    (OVERALL_PART_CATEGORIES as readonly string[]).includes(s.lineType),
  );
  if (partSelections.length === 0) return;

  // 대상 = 현재 모드 스코프의 파트장만. userId → partName.
  const members = await loadTeamMembersWithLeaders(
    input.organization,
    input.teamName,
    input.mode,
  );
  const leaderPartByUser = new Map<string, string>();
  for (const m of members) if (m.isPartLeader) leaderPartByUser.set(m.userId, m.partName);
  const leaderSelections = partSelections.filter((s) =>
    leaderPartByUser.has(s.crewUserId),
  );
  if (leaderSelections.length === 0) return;

  // 스코프 방어선(셀/헤더 write 전) — 대상 파트장 전원 현재 모드 스코프 부합.
  const scope = await resolveUserScope(input.mode, null);
  assertUserIdsInScope(
    scope,
    leaderSelections.map((s) => s.crewUserId),
  );

  // 유형 정합성(선택 라인 유형 == 셀 line_type) — 개설신청/검수/검증 공용 옵션 원천.
  const lineIdCategory = buildLineIdCategoryMap(
    await listExperienceOverallLineOptions(input.organization),
  );

  // 팀·주차 신청 헤더 + 기존 셀 키(라인 미선택이어도 기존 셀이 있으면 갱신 — 예: 점수 하향/체크 해제).
  const { data: headers } = await supabaseAdmin
    .from("cluster4_experience_part_submissions")
    .select("id,part_name")
    .eq("organization_slug", input.organization)
    .eq("week_id", input.weekId)
    .eq("team_id", input.teamId);
  const headerIdByPart = new Map<string, string>();
  for (const h of (headers ?? []) as Array<{ id: string; part_name: string }>) {
    headerIdByPart.set(h.part_name, h.id);
  }
  const existingCellKeys = new Set<string>();
  const headerIds = Array.from(headerIdByPart.values());
  if (headerIds.length > 0) {
    const { data: cells } = await supabaseAdmin
      .from("cluster4_experience_part_submission_cells")
      .select("crew_user_id,line_type")
      .in("submission_id", headerIds);
    for (const c of (cells ?? []) as Array<{ crew_user_id: string; line_type: string }>) {
      existingCellKeys.add(`${c.crew_user_id}::${c.line_type}`);
    }
  }

  const now = new Date().toISOString();
  for (const sel of leaderSelections) {
    // 점수/보이드 정규화 — 일반 크루 개설 신청과 동일 SoT(experienceScoreState).
    //   payload 미지정 시 기본값 checked=true/score=7(= OVERALL_CELL_DEFAULT). 0 은 유효(미체크).
    const rawScore =
      sel.score !== undefined && sel.score !== null ? sel.score : 7;
    const rawChecked = sel.checked ?? true;
    const state = experienceScoreState(rawChecked ? rawScore : 0);
    // 보이드(미체크/0점) → 라인 미선택. score 1~10(체크)은 선택 라인 유지.
    const selectedLineId =
      state.checked && state.score >= 1 ? sel.selectedLineId ?? null : null;
    const cellExists = existingCellKeys.has(`${sel.crewUserId}::${sel.lineType}`);
    // 선택 라인도 없고 기존 셀도 없으면 생성 불필요(미배정 유지 — 헤더/셀 스팸 방지).
    //   기존 셀이 있으면(과거 검수로 물질화) 점수/체크/라인 변경을 반드시 반영한다.
    if (!selectedLineId && !cellExists) continue;
    if (selectedLineId && lineIdCategory.get(selectedLineId) !== sel.lineType) {
      throw Object.assign(
        new Error(
          "선택한 라인의 유형이 해당 평가 열과 일치하지 않습니다. 잘못된 라인 선택입니다.",
        ),
        { status: 422 },
      );
    }
    const partName = leaderPartByUser.get(sel.crewUserId) as string;
    // 파트 신청 헤더 find-or-create(파트장 단독 파트 등 헤더가 없을 수 있음).
    let headerId = headerIdByPart.get(partName);
    if (!headerId) {
      const { data: hdr, error: hdrErr } = await supabaseAdmin
        .from("cluster4_experience_part_submissions")
        .upsert(
          {
            organization_slug: input.organization,
            week_id: input.weekId,
            team_id: input.teamId,
            part_name: partName,
            submitted_by: null,
            submitted_at: now,
          },
          { onConflict: "organization_slug,week_id,team_id,part_name" },
        )
        .select("id")
        .single();
      if (hdrErr || !hdr) {
        throw new Error(hdrErr?.message ?? "파트장 신청 헤더 생성 실패");
      }
      headerId = (hdr as { id: string }).id;
      headerIdByPart.set(partName, headerId);
    }
    // 파트장 셀 upsert — 파트장이 검수 화면에서 고른 점수/체크 + 선택 라인(보이드 시 null).
    const { error: cellErr } = await supabaseAdmin
      .from("cluster4_experience_part_submission_cells")
      .upsert(
        {
          submission_id: headerId,
          crew_user_id: sel.crewUserId,
          line_type: sel.lineType,
          checked: state.checked,
          score: state.score,
          selected_line_id: selectedLineId,
        },
        { onConflict: "submission_id,crew_user_id,line_type" },
      );
    if (cellErr) throw new Error(cellErr.message);
    existingCellKeys.add(`${sel.crewUserId}::${sel.lineType}`);
  }
}

// ── [개설 검수] 완료 저장(고객 미반영) ──
export async function saveTeamOverallReview(input: {
  organization: string;
  weekId: string;
  teamId: string;
  teamName: string;
  leaderCells: OverallLeaderCellDto[];
  outputs: OverallOutput[];
  // 도출/분석/견문 라인명 편집 → 파트 신청 셀 write-back(단일 SoT). 미지정 시 라인 변경 없음.
  lineSelections?: OverallLineSelectionDto[];
  adminId: string | null;
  // 로그 실행자(임퍼소네이션 유효 시 그 테스트 유저=에이전트/팀장, 아니면 실 admin). 미지정 시 adminId.
  actorId?: string | null;
  mode?: ScopeMode;
}): Promise<{ status: "reviewed" }> {
  await assertPartLeaderLinesRequired(input);
  await assertOverallOutputsRequired(input);

  // 이미 개설 완료된 팀은 [개설 취소] 후에만 재검수/수정 가능(고객 라인과 불일치 방지).
  const existing = await loadOverallStored(
    input.organization,
    input.weekId,
    input.teamId,
  );
  if (existing.status === "opened") {
    throw Object.assign(
      new Error("이미 개설 완료된 팀입니다. [개설 취소] 후 다시 검수해주세요."),
      { status: 409 },
    );
  }

  // 모든 대상 파트의 [개설 신청] 완료 전에는 검수 불가 — 프론트 버튼 disable 과 동일 기준(공용 판정).
  //   UI 우회(직접 API 호출)도 여기서 fail-closed(persist 이전·DB write 금지).
  const readiness = await loadOverallApplicationReadiness(
    input.organization,
    input.weekId,
    input.teamId,
    input.teamName,
    input.mode ?? "operating",
  );
  if (readiness.totalPartCount === 0) {
    // 대상 파트 0개 = 신청 대상 자체가 없음 — "모든 파트 신청 완료"로 오인 금지(별도 문구).
    throw Object.assign(new Error(OVERALL_NO_TARGET_PARTS_MESSAGE), { status: 409 });
  }
  if (!readiness.allPartsApplied) {
    const detail =
      readiness.unappliedParts.length > 0
        ? `\n미신청 파트: ${readiness.unappliedParts.join(", ")}`
        : "";
    throw Object.assign(
      new Error(`${OVERALL_APPLICATION_INCOMPLETE_MESSAGE}${detail}`),
      { status: 409 },
    );
  }

  // 관리 류 자격 가드(일반 크루 차단) — persist 이전(DB write 금지).
  await assertNoIneligibleManagementCells(
    input.organization,
    input.teamName,
    input.mode ?? "operating",
    input.leaderCells,
  );

  // 도출/분석/견문 라인명 편집 → 파트 신청 셀 write-back. 유형 불일치는 422 로 여기서 중단.
  //   (persist 이전에 검증/적용 — 라인 유형 오류 시 검수 헤더가 남지 않게.)
  if (input.lineSelections && input.lineSelections.length > 0) {
    // 파트장(셀 없음)은 헤더/셀 find-or-create 로 먼저 물질화 → 아래 write-back 이 동일 SoT 로 갱신.
    await materializePartLeaderPartCells({
      organization: input.organization,
      weekId: input.weekId,
      teamId: input.teamId,
      teamName: input.teamName,
      mode: input.mode ?? "operating",
      selections: input.lineSelections,
    });
    await updateOverallPartCellLines({
      organization: input.organization,
      weekId: input.weekId,
      teamId: input.teamId,
      selections: input.lineSelections,
    });
  }

  await persistReviewState({ ...input, status: "reviewed" });
  await insertExperienceOpeningLog({
    action: "review",
    weekId: input.weekId,
    organizationSlug: input.organization,
    actorUserId: input.actorId ?? input.adminId,
    teamId: input.teamId,
    teamName: input.teamName,
    isTeamLevel: true,
  });
  return { status: "reviewed" };
}

// ── 카테고리 → 등록 라인(고객 반영용) 매핑 ──
export type RegLine = {
  bridgedMasterId: string;
  lineCode: string;
  lineName: string; // 조건부 라우팅 매칭용 raw line_name(mainTitle 은 가공값이라 부적합).
  mainTitle: string;
  outputImages: unknown;
  outputLinks: unknown;
};

async function loadRegLinesByCategory(
  organization: string,
): Promise<{ byCategory: Map<ExperienceOverallCategory, RegLine[]>; }> {
  const byCategory = new Map<ExperienceOverallCategory, RegLine[]>();
  // org 전용 + 공통('common') 둘 다. 라인 등록 목록·개설 후보와 동일 기준.
  //   ⚠ 종전 `.or(org.is.null, org.eq.X)` 는 "공통 = NULL" 가정이라 'common' 행을 제외했다
  //     (소속 클럽 필수화 이후 NULL 행 0건 → 공통 라인만 누락).
  const { data, error } = await supabaseAdmin
    .from("line_registrations")
    .select(
      "line_code,line_name,line_type,main_title,main_title_mode,output_images,output_links,organization_slug,is_active,bridged_master_id",
    )
    .eq("hub", "experience")
    .eq("is_active", true)
    .not("bridged_master_id", "is", null)
    .in("organization_slug", [organization, "common"])
    .order("line_code", { ascending: true });
  if (error) {
    console.warn("[team-overall reflect] line_registrations 조회 실패", error.message);
    return { byCategory };
  }
  const koToCat = new Map(
    EXPERIENCE_OVERALL_CATEGORIES.map((c) => [c.koLineType, c.key]),
  );
  for (const r of (data ?? []) as Array<{
    line_code: string;
    line_name: string;
    line_type: string;
    main_title: string;
    main_title_mode: string;
    output_images: unknown;
    output_links: unknown;
    bridged_master_id: string;
  }>) {
    const cat = koToCat.get(r.line_type);
    if (!cat) continue;
    const mainTitle =
      r.main_title_mode === "fixed" && r.main_title.trim() && r.main_title.trim() !== "-"
        ? r.main_title.trim()
        : r.line_name;
    const list = byCategory.get(cat) ?? [];
    list.push({
      bridgedMasterId: r.bridged_master_id,
      lineCode: r.line_code,
      lineName: r.line_name,
      mainTitle,
      outputImages: r.output_images,
      outputLinks: r.output_links,
    });
    byCategory.set(cat, list);
  }
  return { byCategory };
}

// 카테고리별 단일 등록 라인 선택(고객 반영 1라인/카테고리). 후보 다수면 규칙 적용 + 경고.
function pickRegLine(
  category: ExperienceOverallCategory,
  candidates: RegLine[] | undefined,
  extensionKind: "online" | "offline" | null,
  warnings: string[],
): RegLine | null {
  const label = EXPERIENCE_OVERALL_CATEGORIES.find((c) => c.key === category)?.label ?? category;
  if (!candidates || candidates.length === 0) {
    warnings.push(`'${label}' 라인 등록이 없어 개설하지 못했습니다.`);
    return null;
  }
  if (category === "extension") {
    // 확장: 활성 확장 종류(온라인/오프라인)에 맞는 라인 선택(line_name 기준).
    const want = extensionKind === "online" ? "온라인" : extensionKind === "offline" ? "오프라인" : null;
    if (want) {
      const matched = candidates.find((c) => c.mainTitle.includes(want) || c.lineCode.includes(want));
      if (matched) return matched;
    }
  }
  if (candidates.length > 1) {
    warnings.push(
      `'${label}' 라인 후보가 ${candidates.length}건입니다 — 첫 번째(${candidates[0].lineCode})로 개설했습니다. 확인 필요.`,
    );
  }
  return candidates[0];
}

// ── [신규 2026-06-13] 견문/관리 크루별 조건부 라인 라우팅 ──
// 정책:
//   견문(evaluation): user_growth_stats.cumulative_weeks <=1(0주차 신규 포함) → 마케터 Launch,
//                     >=2 → 상호 피드백. (oranke 만 2후보 — encre/phalanx 단일후보는 폴백=단일라인)
//   관리(management): membership_level 파트장 → _파트장, 에이전트 → _에이전트.
//                     일반(비관리직)은 관리 라인 대상 아님 → 스킵(경고).
//   그 외(도출/분석/확장): 기존 단일 라인(pickRegLine) 유지.
// 신규 개설부터만 적용(openTeamOverall 만 호출 — 이미 opened 라인 소급 변경 없음).
export type RoutingTarget = {
  userId: string;
  score: number;
  isPartLeader: boolean;
  statusLabel: string; // "일반" | "에이전트" | "파트장"
  cumulativeWeeks: number;
  // 사용자별 선택 라인 = cluster4_experience_part_submission_cells.selected_line_id
  //   (= line_registrations.bridged_master_id = RegLine.bridgedMasterId). 개설 완료 시 이 값으로
  //   라인을 그룹핑해 "사용자별 배정 라인"을 보존한다 — 크루 페이지 lineName 의 실질 SoT
  //   (cluster4_lines.experience_line_master_id → master.line_name). 수집 게이트에서 non-null 보장.
  selectedLineId: string;
};

// 매칭은 line_code 우선 + raw line_name 토큰 fallback. line_code 앵커(EN0001/EN0004)를
// 우선 사용해 라인명 변경(예: "상호 피드백"→"상호 다면 피드백")에 라우팅이 의존하지 않게 한다.
// encre "[다면 피드백] 실무 생산성 강화"는 "상호" 미포함 → 상호 피드백과 오매칭 없음.
// 관리 EL0001/EL0002 코드는 전 org 일관.
function isMarketerLaunchLine(r: RegLine): boolean {
  return (
    r.lineCode.endsWith("EN0001") ||
    (r.lineName.includes("마케터") && /launch/i.test(r.lineName))
  );
}
function isMutualFeedbackLine(r: RegLine): boolean {
  return (
    r.lineCode.endsWith("EN0004") ||
    (r.lineName.includes("상호") && r.lineName.includes("피드백"))
  );
}
function isPartLeaderLine(r: RegLine): boolean {
  return r.lineName.includes("파트장") || r.lineCode.endsWith("EL0001");
}
function isAgentLine(r: RegLine): boolean {
  return r.lineName.includes("에이전트") || r.lineCode.endsWith("EL0002");
}

// user_growth_stats.cumulative_weeks 배치 조회(견문 라우팅용, read-only).
//   누락/조회실패 = 0 취급(=마케터 Launch). 팀 단위 소규모이므로 PostgREST cap 무관.
async function loadCumulativeWeeks(
  userIds: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  if (ids.length === 0) return map;
  const { data, error } = await supabaseAdmin
    .from("user_growth_stats")
    .select("user_id,cumulative_weeks")
    .in("user_id", ids);
  if (error) {
    console.warn("[team-overall] cumulative_weeks 조회 실패:", error.message);
    return map;
  }
  for (const r of (data ?? []) as Array<{
    user_id: string;
    cumulative_weeks: number | null;
  }>) {
    map.set(r.user_id, r.cumulative_weeks ?? 0);
  }
  return map;
}

// ── [2026-07-16] 사용자별 선택 라인(selected_line_id) 기준 그룹핑 ──
// 크루 페이지 라인명 = cluster4_lines.experience_line_master_id → master.line_name 이라,
//   같은 카테고리라도 사용자가 서로 다른 라인을 골랐다면 라인을 분리 생성해야 각자의 선택이 보존된다.
//   (구 resolveCategoryLineGroups 는 도출/분석=candidates[0](첫 라인), 견문=누적주차 분기, 관리=역할
//    분기로 카테고리를 1~2개 라인으로 축약 → 사용자별 selected_line_id 를 유실했다. 이 함수가 대체.)
//   매칭: selected_line_id 값 == line_registrations.bridged_master_id(= RegLine.bridgedMasterId) 1:1.
//   옵션 원천(listExperienceOverallLineOptions)과 등록 라인 원천(loadRegLinesByCategory)은 동일 쿼리
//   (hub=experience·is_active·org+공통)라 유효 선택값은 항상 매칭된다. 미매칭(비활성화 등)은 경고 후
//   제외 — 임의 첫 라인으로 폴백하지 않는다(요구사항: 미배정/오류 사용자를 타인의 라인으로 대체 금지).
export function resolveSelectedLineGroups(
  category: ExperienceOverallCategory,
  candidates: RegLine[] | undefined,
  targets: RoutingTarget[],
  warnings: string[],
): Array<{ reg: RegLine; targets: RoutingTarget[] }> {
  const label =
    EXPERIENCE_OVERALL_CATEGORIES.find((c) => c.key === category)?.label ?? category;
  const regByMaster = new Map((candidates ?? []).map((r) => [r.bridgedMasterId, r]));

  // 선택 라인(bridged_master_id)별 그룹 — 입력(파트/이름) 순서 보존.
  const order: string[] = [];
  const byLine = new Map<string, RoutingTarget[]>();
  for (const t of targets) {
    const list = byLine.get(t.selectedLineId);
    if (list) {
      list.push(t);
    } else {
      byLine.set(t.selectedLineId, [t]);
      order.push(t.selectedLineId);
    }
  }

  const groups: Array<{ reg: RegLine; targets: RoutingTarget[] }> = [];
  for (const masterId of order) {
    const groupTargets = byLine.get(masterId) ?? [];
    const reg = regByMaster.get(masterId);
    if (!reg) {
      warnings.push(
        `'${label}' 선택 라인(${masterId})의 등록을 찾지 못해 ${groupTargets.length}명을 개설하지 못했습니다.`,
      );
      continue;
    }
    groups.push({ reg, targets: groupTargets });
  }
  return groups;
}

// [superseded 2026-07-16] 개설 완료 경로는 resolveSelectedLineGroups(사용자별 selected_line_id)로
//   전환됨. 이 함수는 누적주차/역할 자동분기의 순수 단위 검증(verify-experience-conditional-line-
//   routing)용으로만 유지 — 실제 개설엔 사용하지 않는다.
// 카테고리 → [{선택 라인, 그 라인의 대상 크루들}] 그룹. 분기 라인 미식별 시 단일 라인 폴백.
export function resolveCategoryLineGroups(
  category: ExperienceOverallCategory,
  candidates: RegLine[] | undefined,
  targets: RoutingTarget[],
  extensionKind: "online" | "offline" | null,
  warnings: string[],
): Array<{ reg: RegLine; targets: RoutingTarget[] }> {
  const label =
    EXPERIENCE_OVERALL_CATEGORIES.find((c) => c.key === category)?.label ?? category;

  // 견문 — 누적주차 분기(마케터 Launch / 상호 피드백 둘 다 등록된 경우에만).
  if (category === "evaluation" && candidates && candidates.length > 1) {
    const launch = candidates.find(isMarketerLaunchLine);
    const mutual = candidates.find(isMutualFeedbackLine);
    if (launch && mutual) {
      const launchTargets = targets.filter((t) => t.cumulativeWeeks <= 1);
      const mutualTargets = targets.filter((t) => t.cumulativeWeeks >= 2);
      const groups: Array<{ reg: RegLine; targets: RoutingTarget[] }> = [];
      if (launchTargets.length > 0) groups.push({ reg: launch, targets: launchTargets });
      if (mutualTargets.length > 0) groups.push({ reg: mutual, targets: mutualTargets });
      return groups;
    }
    // 둘 중 하나라도 식별 실패 → 단일 라인 폴백(아래).
  }

  // 관리 — 역할 분기(_파트장 / _에이전트). 일반(비관리직)은 대상 아님.
  if (category === "management") {
    const leaderLine = candidates?.find(isPartLeaderLine);
    const agentLine = candidates?.find(isAgentLine);
    const leaderTargets: RoutingTarget[] = [];
    const agentTargets: RoutingTarget[] = [];
    for (const t of targets) {
      if (t.isPartLeader) {
        if (leaderLine) leaderTargets.push(t);
        else
          warnings.push(
            `'${label}' 파트장 라인(_파트장) 등록이 없어 ${t.userId} 를 개설하지 못했습니다.`,
          );
      } else if (t.statusLabel === "에이전트") {
        if (agentLine) agentTargets.push(t);
        else
          warnings.push(
            `'${label}' 에이전트 라인(_에이전트) 등록이 없어 ${t.userId} 를 개설하지 못했습니다.`,
          );
      } else {
        // 일반(비관리직) — 관리 라인은 파트장/에이전트 전용(정책).
        warnings.push(
          `'${label}' 라인은 파트장/에이전트 전용 — ${t.userId}(${t.statusLabel}) 제외.`,
        );
      }
    }
    const groups: Array<{ reg: RegLine; targets: RoutingTarget[] }> = [];
    if (leaderLine && leaderTargets.length > 0)
      groups.push({ reg: leaderLine, targets: leaderTargets });
    if (agentLine && agentTargets.length > 0)
      groups.push({ reg: agentLine, targets: agentTargets });
    return groups;
  }

  // 그 외(도출/분석/확장) 또는 견문 단일후보 — 기존 단일 라인.
  const reg = pickRegLine(category, candidates, extensionKind, warnings);
  return reg ? [{ reg, targets }] : [];
}

// KST 기준 submission window(기존 openExperienceDrafts 와 동일 규칙).
function computeSubmissionOpensAt(weekStartDate: string): string {
  const ms = Date.UTC(
    +weekStartDate.slice(0, 4),
    +weekStartDate.slice(5, 7) - 1,
    +weekStartDate.slice(8, 10),
  );
  return new Date(ms - 9 * 3600_000).toISOString();
}
function computeSubmissionClosesAt(weekStartDate: string): string {
  const ms = Date.UTC(
    +weekStartDate.slice(0, 4),
    +weekStartDate.slice(5, 7) - 1,
    +weekStartDate.slice(8, 10),
  );
  const wednesdayMs = ms + 2 * 86_400_000;
  return new Date(wednesdayMs + 22 * 3600_000 - 9 * 3600_000).toISOString();
}

export type OpenOverallResult = {
  status: "opened";
  linesCreated: number;
  targetsCreated: number;
  evaluationsCreated: number;
  warnings: string[];
};

// ── [개설 완료] 최종 저장 + 크루 페이지(cluster4_lines) 반영 ──
export async function openTeamOverall(input: {
  organization: string;
  weekId: string;
  teamId: string;
  teamName: string;
  leaderCells: OverallLeaderCellDto[];
  outputs: OverallOutput[];
  // 도출/분석/견문 라인명 편집 → 파트 신청 셀 write-back(단일 SoT). 미지정 시 라인 변경 없음.
  lineSelections?: OverallLineSelectionDto[];
  adminId: string | null;
  // 로그 실행자(임퍼소네이션 유효 시 그 테스트 유저=팀장, 아니면 실 admin). 미지정 시 adminId.
  actorId?: string | null;
  mode?: ScopeMode;
}): Promise<OpenOverallResult> {
  const mode: ScopeMode = input.mode ?? "operating";

  await assertPartLeaderLinesRequired(input);
  await assertOverallOutputsRequired(input);

  // 구간별 계측(기본 OFF) — LINE_OPEN_PROFILE=1 일 때만 각 세그먼트 소요(ms)를 수집·로그한다.
  //   운영에선 미동작(오버헤드 0)이며, 비운영 DB/스테이징에서 실제 HTTP 개설 완료의 구간별 ms 를
  //   캡처하기 위한 임시 계측이다. 로직/DTO/SoT 무영향(순수 관찰).
  const profileOn = process.env.LINE_OPEN_PROFILE === "1";
  const marks: Array<{ label: string; ms: number }> = [];
  let profileLast = process.hrtime.bigint();
  const mark = (label: string) => {
    if (!profileOn) return;
    const now = process.hrtime.bigint();
    marks.push({ label, ms: Number(now - profileLast) / 1e6 });
    profileLast = now;
  };

  // 공식 휴식 주차 차단(UI canOpen 과 동일 판정) — operating/test 무관, 모든 write 전 422.
  //   예외(line_opening_windows)는 org+hub 스코프로 판정(Encre+실무경험 등록 시 그 org·경험만 통과).
  await assertWeekOpenable(input.weekId, input.organization, "experience");

  // ── 개설 기간 게이트(강제) — 실무 정보(info-lines)·역량(competency-lines) POST 와 동일 SoT ──
  //   그 주차 실무 경험이 개설 기간(open_confirmed && practicalExperience[teamId] 체크)이 아니면 409.
  //   공식 휴식은 아니지만 개설 기간도 아닌 주차(예: 오픈 확인 전 주차)를 URL/HTTP 직접 호출로 여는 것을 차단.
  await assertExperienceLineOpenable(input.organization, input.weekId, input.teamId);

  const existing = await loadOverallStored(input.organization, input.weekId, input.teamId);
  if (existing.status === "opened") {
    throw Object.assign(
      new Error("이미 개설 완료된 팀입니다. 변경하려면 [개설 취소] 후 다시 진행해주세요."),
      { status: 409 },
    );
  }
  // ⑪ 개설 검수 완료 전에는 개설 완료 불가 — 반드시 [개설 검수](status=reviewed)를 거쳐야 한다(팀장 포함).
  //   프론트 [개설 완료] 버튼 disabled 와 동일 기준. UI 우회(직접 API 호출)도 여기서 fail-closed(409).
  //   역할 제한(파트장=신청만·에이전트=검수만·개설은 팀장/owner)은 라우트 assertImpersonationCapability 가 담당.
  if (existing.status !== "reviewed") {
    throw Object.assign(
      new Error(
        "모든 필수 개설 검수가 완료되어야 개설 완료할 수 있습니다. [개설 검수]를 먼저 진행해주세요.",
      ),
      { status: 409 },
    );
  }

  // 관리 류 자격 가드(일반 크루 차단) — 검수 경로(saveTeamOverallReview)와 동일 기준을 개설 완료에도
  //   적용한다. UI 우회/변조로 일반 크루의 관리 셀(checked/score/selected_line_id)이 섞여 들어와도
  //   write(팀장 셀 저장 + 고객 라인 생성) 이전에 fail-closed(422). "검수/완료 동일 권한 판정".
  await assertNoIneligibleManagementCells(
    input.organization,
    input.teamName,
    mode,
    input.leaderCells,
  );
  mark("guards+loadExisting");

  // 0) 도출/분석/견문 라인명 편집 → 파트 신청 셀 write-back(유형 불일치 422 → 여기서 중단).
  if (input.lineSelections && input.lineSelections.length > 0) {
    // 파트장(셀 없음)은 헤더/셀 find-or-create 로 먼저 물질화 → 완료 시 대상자(cluster4_line_targets)
    //   생성 경로(getTeamOverallBoard 재조립)가 파트장 도출/분석/견문 라인을 정상 수집한다.
    await materializePartLeaderPartCells({
      organization: input.organization,
      weekId: input.weekId,
      teamId: input.teamId,
      teamName: input.teamName,
      mode,
      selections: input.lineSelections,
    });
    await updateOverallPartCellLines({
      organization: input.organization,
      weekId: input.weekId,
      teamId: input.teamId,
      selections: input.lineSelections,
    });
  }
  mark("lineSelWriteback");

  // 1) 입력값 저장(status 는 일단 reviewed 로 보존 — 반영 성공 후 opened 로 승격).
  const overallId = await persistReviewState({
    ...input,
    status: "reviewed",
  });
  mark("persistReview");

  // 2) 머지된 보드(part-derived 라이브 + 방금 저장한 leader 셀) 재조립. (모집단 = 동일 mode 스코프)
  const board = await getTeamOverallBoard(
    input.organization,
    input.weekId,
    input.teamId,
    input.teamName,
    mode,
  );
  const weekDates = await loadWeekDates(input.weekId);
  if (!weekDates) {
    throw Object.assign(new Error("주차 정보를 찾을 수 없습니다"), { status: 404 });
  }
  const submissionOpensAt = computeSubmissionOpensAt(weekDates.startDate);
  const submissionClosesAt = computeSubmissionClosesAt(weekDates.startDate);

  // 출력 맵.
  const outputByCat = new Map(input.outputs.map((o) => [o.category, o]));
  const { byCategory } = await loadRegLinesByCategory(input.organization);

  // 크루별 누적주차 로드(견문 라우팅용) — board.crews 전체 userId 1회 배치 조회.
  const allCrewUserIds = board.parts.flatMap((p) => p.crews.map((c) => c.userId));
  const cumulativeWeeksMap = await loadCumulativeWeeks(allCrewUserIds);
  mark("reassemble+regLoad");

  // 카테고리별 대상 크루(해당 카테고리 checked=true) 수집(라우팅 속성 포함).
  const crewsByCat = new Map<ExperienceOverallCategory, RoutingTarget[]>();
  for (const part of board.parts) {
    for (const crew of part.crews) {
      const cumulativeWeeks = cumulativeWeeksMap.get(crew.userId) ?? 0;
      for (const cat of EXPERIENCE_OVERALL_CATEGORIES) {
        // 확장은 확장 주간에만 반영.
        if (cat.key === "extension" && !board.extensionActive) continue;
        const cell = crew.cells[cat.key];
        if (!cell.checked || cell.score <= 0 || !cell.selectedLineId) continue;
        const list = crewsByCat.get(cat.key) ?? [];
        list.push({
          userId: crew.userId,
          score: cell.score,
          isPartLeader: crew.isPartLeader,
          statusLabel: crew.statusLabel,
          cumulativeWeeks,
          // 게이트(위 조건)에서 non-null 보장 — 사용자별 배정 라인 보존 키.
          selectedLineId: cell.selectedLineId,
        });
        crewsByCat.set(cat.key, list);
      }
    }
  }

  // 안전장치 — cluster4_line_targets 생성 직전, 전 카테고리 대상 userId 전원이 현재 모드
  // 스코프에 부합하는지 검증. operating 에 테스트 계정 / test 에 실사용자가 하나라도 섞이면
  // 고객 반영(라인/타깃/평가) write 전에 중단한다. board.crews 는 이미 스코프 필터를 거치므로
  // 정상 경로에선 통과하나, 입력/머지 변조에 대한 방어선(defense-in-depth)으로 독립 검증한다.
  const allTargetUserIds = Array.from(crewsByCat.values()).flatMap((list) =>
    list.map((t) => t.userId),
  );
  const openScope = await resolveUserScope(mode, null);
  assertUserIdsInScope(openScope, allTargetUserIds);

  const warnings: string[] = [];
  const createdLineIds: string[] = [];
  const createdTargetIds: string[] = [];
  const openedLineRows: Array<{ category: string; lineId: string }> = [];
  let targetsCreated = 0;
  let evaluationsCreated = 0;
  const affectedUserIds = new Set<string>();

  try {
    for (const cat of EXPERIENCE_OVERALL_CATEGORIES) {
      const targets = crewsByCat.get(cat.key) ?? [];
      if (targets.length === 0) continue;
      // 사용자별 선택 라인(selected_line_id) 기준 그룹핑 — 도출/분석/견문/관리/확장 전 카테고리에서
      //   각자 고른 라인을 분리 생성해 배정 라인을 보존한다(크루 페이지 lineName SoT 정합).
      const groups = resolveSelectedLineGroups(
        cat.key,
        byCategory.get(cat.key),
        targets,
        warnings,
      );

      for (const { reg, targets: groupTargets } of groups) {
        if (groupTargets.length === 0) continue;

        const screenOut = outputByCat.get(cat.key);
        const screenLink = screenOut?.link.trim() || null;
        const screenDesc = screenOut?.description.trim() || "";
        const screenImageUrl = screenOut?.imageUrl.trim() || null;
        const screenImageDescription = screenOut?.imageDescription.trim() || "";
        const outputLinks = screenLink
          ? [{ url: screenLink, label: screenDesc }]
          : resolveOutputLinks(reg.outputLinks, [null, null]);

        const { data: lineRow, error: lineError } = await supabaseAdmin
          .from("cluster4_lines")
          .insert({
            part_type: "experience",
            experience_line_master_id: reg.bridgedMasterId,
            line_code: reg.lineCode,
            main_title: reg.mainTitle,
            team_id: input.teamId,
            output_link_1: screenLink,
            output_link_2: null,
            output_links: outputLinks,
            // 아웃풋 이미지 = 라인 등록값 자동 반영(입력 UI 없음).
            output_images: screenImageUrl
              ? [{ url: screenImageUrl, caption: screenImageDescription || null }]
              : [],
            submission_opens_at: submissionOpensAt,
            submission_closes_at: submissionClosesAt,
            is_active: true,
            // QA 기간(QA_HIDE_REAL_USERS=true) 생성분 표식 — 운영 조회 제외. 기본 false.
            is_qa_test: QA_HIDE_REAL_USERS,
            created_by: input.adminId,
            updated_by: input.adminId,
          })
          .select("id")
          .single();
        if (lineError || !lineRow) {
          throw new Error(lineError?.message ?? `'${cat.label}' 라인 생성 실패`);
        }
        const lineId = (lineRow as { id: string }).id;
        createdLineIds.push(lineId);
        openedLineRows.push({ category: cat.key, lineId });

        // ⑥ 성능 — 대상/평가를 크루 1명씩 직렬(await 2회/명) insert 하던 것을 그룹 단위 배치 insert 로
        //   전환한다. 생성되는 행(스키마·내용·개수)은 이전과 동일하며 DB 왕복만 2N → 2 로 줄여 직렬 병목을
        //   제거한다(대상 인원이 많은 팀에서 개설 완료 소요 시간 대폭 단축). SoT/판정 로직 무변경.
        const evaluatedAt = new Date().toISOString();
        const targetInsertRows = groupTargets.map((tgt) => ({
          line_id: lineId,
          week_id: input.weekId,
          target_mode: "user" as const,
          target_user_id: tgt.userId,
          target_rule: {},
          created_by: input.adminId,
          updated_by: input.adminId,
        }));
        const { data: insertedTargets, error: targetError } = await supabaseAdmin
          .from("cluster4_line_targets")
          .insert(targetInsertRows)
          .select("id,target_user_id");
        if (targetError || !insertedTargets) {
          throw new Error(targetError?.message ?? "라인 대상 생성 실패");
        }
        // user → target_id 맵(그룹 내 한 유저는 라인당 1행이라 유일) — 평가 행 연결 + 롤백 추적용.
        const targetIdByUser = new Map<string, string>();
        for (const r of insertedTargets as Array<{ id: string; target_user_id: string | null }>) {
          if (r.target_user_id) targetIdByUser.set(r.target_user_id, r.id);
          createdTargetIds.push(r.id);
          targetsCreated++;
        }
        for (const tgt of groupTargets) affectedUserIds.add(tgt.userId);

        // 평가 배치 insert — target_id 가 확보된 대상만(정상 경로에선 전원). 실패 시 그룹 단위 경고
        //   (라인/대상은 생성됨) — 개별 행 경고 granularity 만 그룹 단위로 바뀔 뿐 성공 경로는 동일.
        const evalInsertRows = groupTargets
          .map((tgt) => {
            const targetId = targetIdByUser.get(tgt.userId);
            return targetId
              ? {
                  line_target_id: targetId,
                  user_id: tgt.userId,
                  rating: tgt.score,
                  evaluated_by: input.adminId,
                  evaluated_at: evaluatedAt,
                }
              : null;
          })
          .filter((r): r is NonNullable<typeof r> => r !== null);
        if (evalInsertRows.length > 0) {
          const { error: evalError } = await supabaseAdmin
            .from("cluster4_experience_line_evaluations")
            .insert(evalInsertRows);
          if (evalError) {
            warnings.push(
              `'${cat.label}' 평가 생성 실패 — ${evalError.message}. 라인/대상은 생성됨.`,
            );
          } else {
            evaluationsCreated += evalInsertRows.length;
          }
        }
      }
    }
  } catch (e) {
    // best-effort 롤백(생성 역순).
    await rollbackLines(createdLineIds);
    throw Object.assign(
      new Error(e instanceof Error ? e.message : "개설 완료 반영 실패"),
      { status: 500 },
    );
  }
  mark("insertTargetsEvals");

  // 생성한 라인 추적 기록(개설 취소 원복용).
  if (openedLineRows.length > 0) {
    const { error: trackErr } = await supabaseAdmin
      .from("cluster4_experience_team_overall_opened_lines")
      .insert(
        openedLineRows.map((r) => ({
          overall_id: overallId,
          category: r.category,
          line_id: r.lineId,
        })),
      );
    if (trackErr) {
      warnings.push(`개설 라인 추적 기록 실패 — ${trackErr.message}. 개설 취소가 제한될 수 있습니다.`);
    }
  }

  // 헤더 status → opened 승격.
  const { error: statusErr } = await supabaseAdmin
    .from("cluster4_experience_team_overall")
    .update({ status: "opened", opened_by: input.adminId, opened_at: new Date().toISOString() })
    .eq("id", overallId);
  if (statusErr) {
    warnings.push(`상태 갱신 실패 — ${statusErr.message}`);
  }
  mark("trackAndStatus");

  // weekly-cards snapshot 무효화 = 3허브 통일 헬퍼(info/experience-lines/competency 와 동일 기준):
  //   배정 크루 즉시 재계산(개설 크루 바로 반영) + org audience 분모 A stale(비배정 크루 lazy 수렴).
  //   과거엔 배정자만 무효화해 비배정 크루 강화율 분모가 지연됐다(드리프트) — 통일로 해소.
  if (affectedUserIds.size > 0) {
    if (createdLineIds.length > 0) {
      await invalidateWeeklyCardsForLineOpen(createdLineIds[0], Array.from(affectedUserIds), mode);
    } else {
      await invalidateWeeklyCardsForUsers(Array.from(affectedUserIds));
    }
  }
  mark("invalidate");

  // 라인 개설 대상자 등록 → Point A·B 즉시 지급(source='line', pay-once). 공통 SoT. best-effort.
  for (const lineId of createdLineIds) {
    try {
      await payLineOpenTargetsOnce(lineId);
    } catch (payoutErr) {
      console.warn("[openTeamOverall] line payout failed", { lineId, message: payoutErr instanceof Error ? payoutErr.message : String(payoutErr) });
    }
  }

  // 정본 저장 경로와 동일 파생 수렴 — 개설+평점으로 강화 결과(success/fail)가 즉시 결정되는
  //   배정 크루 전원에 대해 라인 A/B 지급·회수 → uwp 재집계 → uws 재판정 → snapshot → 성장통계 →
  //   품계 를 수행한다(payLineOpenTargetsOnce 는 폐기 no-op 이라 이 경로가 실제 지급/판정을 담당).
  //   개설은 additive(회수 없음) → orphanLineId 미지정. best-effort.
  if (affectedUserIds.size > 0) {
    await convergeLineChangeForUsers({
      weekId: input.weekId,
      userIds: Array.from(affectedUserIds),
      actor: input.actorId ?? input.adminId ?? null,
    });
  }
  mark("converge");

  await insertExperienceOpeningLog({
    action: "open",
    weekId: input.weekId,
    organizationSlug: input.organization,
    actorUserId: input.actorId ?? input.adminId,
    teamId: input.teamId,
    teamName: input.teamName,
    isTeamLevel: true,
  });
  mark("openLog");

  if (profileOn) {
    const total = marks.reduce((n, m) => n + m.ms, 0);
    console.log(
      "[openTeamOverall profile]",
      JSON.stringify({
        weekId: input.weekId,
        teamId: input.teamId,
        affectedUsers: affectedUserIds.size,
        linesCreated: createdLineIds.length,
        targetsCreated,
        totalMs: Math.round(total),
        segments: marks.map((m) => ({ label: m.label, ms: Math.round(m.ms) })),
      }),
    );
  }

  return {
    status: "opened",
    linesCreated: createdLineIds.length,
    targetsCreated,
    evaluationsCreated,
    warnings,
  };
}

// ── [개설 취소] 고객 반영 원복 + status reviewed 복귀 ──
export async function cancelTeamOverall(input: {
  organization: string;
  weekId: string;
  teamId: string;
  teamName: string;
  adminId: string | null;
  // 로그 실행자(임퍼소네이션 유효 시 그 테스트 유저=팀장, 아니면 실 admin). 미지정 시 adminId.
  actorId?: string | null;
}): Promise<{ status: "reviewed"; linesRemoved: number }> {
  const { data: header } = await supabaseAdmin
    .from("cluster4_experience_team_overall")
    .select("id,status")
    .eq("organization_slug", input.organization)
    .eq("week_id", input.weekId)
    .eq("team_id", input.teamId)
    .maybeSingle();
  const h = header as { id: string; status: "reviewed" | "opened" } | null;
  if (!h || h.status !== "opened") {
    throw Object.assign(new Error("개설 완료 상태에서만 취소할 수 있습니다."), { status: 400 });
  }

  const { data: lineRows } = await supabaseAdmin
    .from("cluster4_experience_team_overall_opened_lines")
    .select("line_id")
    .eq("overall_id", h.id);
  const lineIds = ((lineRows ?? []) as Array<{ line_id: string }>).map((r) => r.line_id);

  // 영향 대상자 수집(stale 표시용) — 라인 삭제 전 타깃에서.
  const affected = new Set<string>();
  if (lineIds.length > 0) {
    const { data: tgts } = await supabaseAdmin
      .from("cluster4_line_targets")
      .select("target_user_id")
      .in("line_id", lineIds);
    for (const t of (tgts ?? []) as Array<{ target_user_id: string | null }>) {
      if (t.target_user_id) affected.add(t.target_user_id);
    }
  }

  await rollbackLines(lineIds);

  // 추적 행 제거.
  await supabaseAdmin
    .from("cluster4_experience_team_overall_opened_lines")
    .delete()
    .eq("overall_id", h.id);

  // status reviewed 로 복귀(검수 데이터는 보존 — 이어서 수정/재완료 가능).
  await supabaseAdmin
    .from("cluster4_experience_team_overall")
    .update({ status: "reviewed", opened_by: null, opened_at: null })
    .eq("id", h.id);

  if (affected.size > 0) {
    await invalidateWeeklyCardsForUsers(Array.from(affected));
  }

  await insertExperienceOpeningLog({
    action: "cancel",
    weekId: input.weekId,
    organizationSlug: input.organization,
    actorUserId: input.actorId ?? input.adminId,
    teamId: input.teamId,
    teamName: input.teamName,
    isTeamLevel: true,
  });

  return { status: "reviewed", linesRemoved: lineIds.length };
}

// 라인 id 집합의 평가→타깃→라인을 역순 삭제(best-effort).
async function rollbackLines(lineIds: string[]): Promise<void> {
  if (lineIds.length === 0) return;
  // 회수 정책(2026-07-15): 라인 롤백/삭제 시에도 기존 지급 포인트는 유지한다(회수 없음).
  const { data: tgts } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("id")
    .in("line_id", lineIds);
  const targetIds = ((tgts ?? []) as Array<{ id: string }>).map((t) => t.id);
  if (targetIds.length > 0) {
    const { error: evalErr } = await supabaseAdmin
      .from("cluster4_experience_line_evaluations")
      .delete()
      .in("line_target_id", targetIds);
    if (evalErr) console.error("[team-overall rollback] eval:", evalErr.message);
    const { error: tgtErr } = await supabaseAdmin
      .from("cluster4_line_targets")
      .delete()
      .in("id", targetIds);
    if (tgtErr) console.error("[team-overall rollback] targets:", tgtErr.message);
  }
  const { error: lineErr } = await supabaseAdmin
    .from("cluster4_lines")
    .delete()
    .in("id", lineIds);
  if (lineErr) console.error("[team-overall rollback] lines:", lineErr.message);
}

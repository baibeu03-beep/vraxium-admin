// 실무 경험 파트장 입력 그리드 — 데이터 레이어(신규 전용 저장, standalone).
//
// cluster4_experience_part_submissions(헤더) + cluster4_experience_part_submission_cells(셀)만
// 읽고 쓴다. 기존 experience_drafts/검수/개설/snapshot 과 무연동(이번 phase 신청 저장/취소만).
//
// 크루/파트/상태는 user_profiles(role) + user_memberships(team_name/part_name/membership_level/state)
// 에서 resolve 한다. 클래스 판정은 공통 변환기(resolvePositionLabels) 단일 경로.
// 평가 대상 = 일반/에이전트(파트장·팀장 제외).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { normalizeMemberRole, resolvePositionLabels } from "@/lib/adminMembersTypes";
import { loadCurrentWeekOverrideLabels } from "@/lib/positionResolver";
import {
  assertUserIdsInScope,
  resolveUserScope,
  type ScopeMode,
} from "@/lib/userScope";
import { assertWeekOpenable } from "@/lib/cluster4OfficialRestWeek";
import { assertExperienceLineOpenable } from "@/lib/experienceLineOpenGate";
import { getCurrentSeasonRestUserIds } from "@/lib/currentSeasonRest";
import {
  EXPERIENCE_PART_LINE_KEYS,
  normalizePartInputCell,
  type ExperiencePartLineType,
  type PartInputCellDto,
  type PartInputCrew,
  type PartOverallAggregate,
} from "@/lib/experiencePartInputTypes";
import {
  buildLineIdCategoryMap,
  listExperienceLineOptions,
} from "@/lib/adminExperienceLineData";

// ── 크루 행(팀 기준 enriched) ──

type TeamCrewRow = {
  userId: string;
  displayName: string;
  partName: string | null;
  role: string | null;
  membershipLevel: string | null;
  membershipState: string | null;
  /** 현재 주차 override 의 position_code(없으면 null → role+등급 정규화로 판정). */
  overridePositionCode?: string | null;
};

// 파트가 아닌 placeholder part_name(미배정 기본값). 등급 단어 '일반' 이 part_name 으로 새는 경우 등.
// 실제 파트만 노출하기 위해 파트 목록/크루 목록에서 제외한다.
const EXCLUDED_PART_NAMES = new Set<string>(["일반"]);

// 평가 대상 크루의 상태 라벨(일반/에이전트)만 반환. 파트장/팀장/기타는 null(목록 제외).
function crewDisplayStatus(
  role: string | null,
  membershipLevel: string | null,
  // 현재 주차 override 의 position_code. 있으면 멤버십 대신 이 값으로 판정(현재 상태 화면 규칙)
  //   — 평가 대상 선별이 화면 클래스 컬럼과 갈리지 않게 한다.
  overridePositionCode?: string | null,
): "일반" | "에이전트" | null {
  // ⚠ 라벨 문자열이 아니라 positionCode 로 판정한다(어휘 2종 혼선 원천 차단).
  const code = resolvePositionLabels({
    positionCode: overridePositionCode ?? null,
    role,
    membershipLevel,
  }).positionCode;
  if (code === "regular") return "일반";
  if (code === "advanced_agent") return "에이전트";
  return null;
}

// (org, teamName) 의 활동 크루 행 — user_profiles(role) + user_memberships(현재행) join.
//   모집단 = mode 스코프(operating=실사용자만 / test=test_user_markers 만). 단일 SoT: lib/userScope.
export async function loadTeamCrewRows(
  organization: string,
  teamName: string,
  mode: ScopeMode = "operating",
): Promise<TeamCrewRow[]> {
  let profileQuery = supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name,role")
    .order("display_name", { ascending: true });
  if (organization) {
    profileQuery = profileQuery.eq("organization_slug", organization);
  }
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
  // org 필터는 위 profileQuery 가 이미 적용하므로 scope.org 는 null(includes 판정은 org 무관).
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

  // 현재 주차 파트/클래스 override — 평가 대상 선별/표시가 화면 클래스와 갈리지 않게 함께 읽는다.
  const weekOverrides = await loadCurrentWeekOverrideLabels(
    profs.map((x) => x.user_id),
    organization,
  );
  const rows: TeamCrewRow[] = [];
  for (const p of profs) {
    // 모집단 스코프: operating=실사용자만 / test=테스트 유저만.
    if (!scope.includes(p.user_id)) continue;
    if (restIds.has(p.user_id)) continue; // 현재 시즌 전체 휴식자 제외(라인 개설 후보 아님).
    const m = memMap.get(p.user_id);
    if (!m || m.team_name !== teamName) continue;
    // 휴식 크루는 평가 대상에서 제외(active 만).
    if (m.membership_state === "rest") continue;
    // 실제 파트만(미배정/placeholder '일반' 제외).
    //   ⚠ 클래스만 override 를 따르고 파트는 멤버십을 쓰면 같은 사람이 화면마다 다른 파트로 잡힌다 — 동일 SoT.
    const ovr = weekOverrides.get(p.user_id) ?? null;
    const effPart = ovr ? ovr.rawPart : m.part_name;
    const part = effPart?.trim() ?? "";
    if (!part || EXCLUDED_PART_NAMES.has(part)) continue;
    rows.push({
      userId: p.user_id,
      displayName: p.display_name ?? "(이름 없음)",
      partName: effPart,
      role: p.role,
      membershipLevel: m.membership_level,
      membershipState: m.membership_state,
      overridePositionCode: ovr?.positionCode ?? null,
    });
  }
  return rows;
}

// ── Actor context (기본 팀탭/파트 결정) ──

export async function resolveActorContext(
  userId: string,
): Promise<{
  role: string | null;
  teamName: string | null;
  partName: string | null;
  memberRole: "team_leader" | "part_leader" | "agent" | "member";
}> {
  const { data: prof } = await supabaseAdmin
    .from("user_profiles")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();
  const { data: mems } = await supabaseAdmin
    .from("user_memberships")
    .select("team_name,part_name,membership_level,is_current")
    .eq("user_id", userId);
  const rows = (mems ?? []) as Array<{
    team_name: string | null;
    part_name: string | null;
    membership_level: string | null;
    is_current: boolean | null;
  }>;
  const chosen = rows.find((r) => r.is_current) ?? rows[0] ?? null;
  const role = (prof as { role: string | null } | null)?.role ?? null;
  return {
    role,
    teamName: chosen?.team_name ?? null,
    partName: chosen?.part_name ?? null,
    memberRole: normalizeMemberRole(role, chosen?.membership_level ?? null),
  };
}

// ── Parts / Crews ──

export async function listTeamParts(
  organization: string,
  teamName: string,
  mode: ScopeMode = "operating",
): Promise<string[]> {
  const rows = await loadTeamCrewRows(organization, teamName, mode);
  const set = new Set<string>();
  for (const r of rows) if (r.partName) set.add(r.partName);
  return Array.from(set).sort();
}

export async function listPartCrews(
  organization: string,
  teamName: string,
  part: string,
  mode: ScopeMode = "operating",
): Promise<PartInputCrew[]> {
  const rows = await loadTeamCrewRows(organization, teamName, mode);
  const out: PartInputCrew[] = [];
  for (const r of rows) {
    if (r.partName !== part) continue;
    const status = crewDisplayStatus(r.role, r.membershipLevel, r.overridePositionCode);
    if (!status) continue; // 파트장/팀장 등 제외
    out.push({
      userId: r.userId,
      displayName: r.displayName,
      partName: r.partName,
      statusLabel: status,
    });
  }
  return out;
}

// 팀 전체(모든 파트 합집합)의 평가 대상 크루 — listPartCrews 와 동일 판정(파트장/팀장·휴식·미배정 제외).
//   팀 총괄(part_name=NULL) 스코프의 "체크 대상자 로스터" 로 쓴다. 파트 필터만 없앤 형태.
export async function listTeamCrews(
  organization: string,
  teamName: string,
  mode: ScopeMode = "operating",
): Promise<PartInputCrew[]> {
  const rows = await loadTeamCrewRows(organization, teamName, mode);
  const out: PartInputCrew[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const status = crewDisplayStatus(r.role, r.membershipLevel, r.overridePositionCode);
    if (!status) continue; // 파트장/팀장 등 제외
    if (seen.has(r.userId)) continue;
    seen.add(r.userId);
    out.push({
      userId: r.userId,
      displayName: r.displayName,
      partName: r.partName,
      statusLabel: status,
    });
  }
  return out;
}

// ── 신청 조회/저장/삭제 ──

async function findHeaderId(
  organization: string,
  weekId: string,
  teamId: string,
  part: string,
): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("cluster4_experience_part_submissions")
    .select("id")
    .eq("organization_slug", organization)
    .eq("week_id", weekId)
    .eq("team_id", teamId)
    .eq("part_name", part)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

async function fetchCells(submissionId: string): Promise<PartInputCellDto[]> {
  const { data } = await supabaseAdmin
    .from("cluster4_experience_part_submission_cells")
    .select("crew_user_id,line_type,checked,score,selected_line_id")
    .eq("submission_id", submissionId);
  return ((data ?? []) as Array<{
    crew_user_id: string;
    line_type: ExperiencePartLineType;
    checked: boolean;
    score: number;
    selected_line_id: string | null;
  }>).map((c) => normalizePartInputCell({
    crewUserId: c.crew_user_id,
    lineType: c.line_type,
    checked: c.checked,
    score: c.score,
    selectedLineId: c.selected_line_id ?? null,
  }));
}

export async function getPartSubmission(
  organization: string,
  weekId: string,
  teamId: string,
  part: string,
): Promise<{ submitted: boolean; cells: PartInputCellDto[] }> {
  const headerId = await findHeaderId(organization, weekId, teamId, part);
  if (!headerId) return { submitted: false, cells: [] };
  const cells = await fetchCells(headerId);
  return { submitted: true, cells };
}

// 팀 총괄 — 그 팀의 모든 파트 신청을 집계(읽기 전용).
export async function getTeamOverall(
  organization: string,
  weekId: string,
  teamId: string,
  teamName: string,
  mode: ScopeMode = "operating",
): Promise<PartOverallAggregate> {
  const { data: headers } = await supabaseAdmin
    .from("cluster4_experience_part_submissions")
    .select("id,part_name")
    .eq("organization_slug", organization)
    .eq("week_id", weekId)
    .eq("team_id", teamId);
  const headerRows = (headers ?? []) as Array<{ id: string; part_name: string }>;
  if (headerRows.length === 0) return { parts: [] };

  const headerIds = headerRows.map((h) => h.id);
  const { data: cellRows } = await supabaseAdmin
    .from("cluster4_experience_part_submission_cells")
    .select("submission_id,crew_user_id,line_type,checked,score,selected_line_id")
    .in("submission_id", headerIds);
  const cells = (cellRows ?? []) as Array<{
    submission_id: string;
    crew_user_id: string;
    line_type: ExperiencePartLineType;
    checked: boolean;
    score: number;
    selected_line_id: string | null;
  }>;

  // 크루 표시 정보(이름/상태) — 팀 단위 1회 조회 후 맵.
  const crewRows = await loadTeamCrewRows(organization, teamName, mode);
  const crewMap = new Map(
    crewRows.map((r) => [
      r.userId,
      {
        displayName: r.displayName,
        statusLabel: crewDisplayStatus(r.role, r.membershipLevel, r.overridePositionCode) ?? "-",
      },
    ]),
  );

  const parts = headerRows
    .map((h) => {
      const partCells = cells.filter((c) => c.submission_id === h.id);
      const byCrew = new Map<string, PartInputCellDto[]>();
      for (const c of partCells) {
        const list = byCrew.get(c.crew_user_id) ?? [];
        list.push(normalizePartInputCell({
          crewUserId: c.crew_user_id,
          lineType: c.line_type,
          checked: c.checked,
          score: c.score,
          selectedLineId: c.selected_line_id ?? null,
        }));
        byCrew.set(c.crew_user_id, list);
      }
      const crews = Array.from(byCrew.entries()).map(([userId, cs]) => {
        const info = crewMap.get(userId);
        return {
          userId,
          displayName: info?.displayName ?? "(이름 없음)",
          statusLabel: info?.statusLabel ?? "-",
          cells: cs,
        };
      });
      return { partName: h.part_name, crews };
    })
    .sort((a, b) => a.partName.localeCompare(b.partName));

  return { parts };
}

export async function savePartSubmission(input: {
  organization: string;
  weekId: string;
  teamId: string;
  part: string;
  submittedBy: string | null;
  cells: PartInputCellDto[];
  mode?: ScopeMode;
}): Promise<{ submitted: true }> {
  // 0a. 공식 휴식 주차 차단(UI canOpen 과 동일 판정) — operating/test 무관, write 전 422.
  //   예외(line_opening_windows)는 org+hub 스코프 판정(Encre+실무경험 등록 시 그 org·경험만 통과).
  await assertWeekOpenable(input.weekId, input.organization, "experience");

  // 0a-2. 개설 기간 게이트 — 개설 신청도 개설 기간(cluster4_week_opening_configs)에서만 가능하다.
  //   개설 기간이 아닌 주차(오픈 확인 전/미체크)에는 신청 write 를 409 로 차단(팀 총괄 개설과 동일 SoT).
  await assertExperienceLineOpenable(input.organization, input.weekId, input.teamId);

  // 0b. 안전장치 — 셀의 crew userId 가 현재 모드 스코프에 전원 부합하는지 검증(헤더 upsert 전).
  //    operating: 테스트 계정이 / test: 실사용자가 하나라도 섞이면 422 로 중단.
  const cellUserIds = input.cells.map((c) => c.crewUserId).filter(Boolean);
  if (cellUserIds.length > 0) {
    const scope = await resolveUserScope(input.mode ?? "operating", null);
    assertUserIdsInScope(scope, cellUserIds);
  }

  // 1. 헤더 upsert(파트당 1행/주차) → id.
  const { data: header, error: headerError } = await supabaseAdmin
    .from("cluster4_experience_part_submissions")
    .upsert(
      {
        organization_slug: input.organization,
        week_id: input.weekId,
        team_id: input.teamId,
        part_name: input.part,
        submitted_by: input.submittedBy,
        submitted_at: new Date().toISOString(),
      },
      { onConflict: "organization_slug,week_id,team_id,part_name" },
    )
    .select("id")
    .single();
  if (headerError || !header) {
    throw new Error(headerError?.message ?? "신청 헤더 저장 실패");
  }
  const submissionId = (header as { id: string }).id;

  // 2. 셀 replace(기존 삭제 후 재삽입) — 유효 line_type 만.
  const { error: delError } = await supabaseAdmin
    .from("cluster4_experience_part_submission_cells")
    .delete()
    .eq("submission_id", submissionId);
  if (delError) throw new Error(delError.message);

  // normalizePartInputCell 이 점수 상태를 정규화한다(선택 라인은 평점과 무관하게 그대로 보존).
  const valid = input.cells
    .filter((c) => (EXPERIENCE_PART_LINE_KEYS as string[]).includes(c.lineType))
    .map(normalizePartInputCell);

  // 라인 유형 정합성 — 선택 라인은 반드시 그 셀 line_type 과 같은 유형이어야 한다(요구사항 §7).
  //   옵션 원천 = 개설 신청/검수/검증 공용 listExperienceLineOptions(org+공통).
  const lineIdCategory = buildLineIdCategoryMap(
    await listExperienceLineOptions(input.organization),
  );
  for (const c of valid) {
    if (!c.selectedLineId) continue; // 미선택('-') — 검증 불필요.
    if (lineIdCategory.get(c.selectedLineId) !== c.lineType) {
      throw Object.assign(
        new Error(
          "선택한 라인의 유형이 해당 평가 열과 일치하지 않습니다. 잘못된 라인 선택입니다.",
        ),
        { status: 422 },
      );
    }
  }

  if (valid.length > 0) {
    const { error: insError } = await supabaseAdmin
      .from("cluster4_experience_part_submission_cells")
      .insert(
        valid.map((c) => ({
          submission_id: submissionId,
          crew_user_id: c.crewUserId,
          line_type: c.lineType,
          checked: c.checked,
          score: Math.max(0, Math.min(10, Math.round(c.score))),
          selected_line_id: c.selectedLineId ?? null,
        })),
      );
    if (insError) throw new Error(insError.message);
  }

  return { submitted: true };
}

// ── [검수] 팀 총괄 보드에서 도출/분석/견문 라인 선택 편집 → 파트 신청 셀에 write-back ──
// 라인명 SoT 는 파트 신청 셀(selected_line_id) 하나뿐이므로, 검수 화면 편집도 같은 셀을 갱신한다.
//   · checked/score 는 건드리지 않는다(도출/분석/견문 점수는 파트장 소유·검수는 라인명만 편집).
//   · 라인명은 평점과 분리(2026-07-24) — 평점 0점(강화 실패) 셀에도 선택 라인을 그대로 저장한다.
//   · 유형 정합성: 선택 라인 유형 == 셀 line_type 아니면 422.
//   · 파트 미신청(셀 없음) 크루는 스킵(부착할 셀이 없음).
export async function updateOverallPartCellLines(input: {
  organization: string;
  weekId: string;
  teamId: string;
  selections: Array<{
    crewUserId: string;
    lineType: ExperiencePartLineType;
    selectedLineId: string | null;
  }>;
}): Promise<void> {
  const selections = input.selections.filter((s) =>
    (EXPERIENCE_PART_LINE_KEYS as string[]).includes(s.lineType),
  );
  if (selections.length === 0) return;

  // 대상 팀·주차의 신청 헤더 → 셀(도출/분석/견문) 조회. (crew::lineType) → 셀 메타 맵.
  const { data: headers } = await supabaseAdmin
    .from("cluster4_experience_part_submissions")
    .select("id")
    .eq("organization_slug", input.organization)
    .eq("week_id", input.weekId)
    .eq("team_id", input.teamId);
  const headerIds = ((headers ?? []) as Array<{ id: string }>).map((h) => h.id);
  if (headerIds.length === 0) return;

  const { data: cellRows } = await supabaseAdmin
    .from("cluster4_experience_part_submission_cells")
    .select("id,crew_user_id,line_type")
    .in("submission_id", headerIds);
  const cellMap = new Map<string, { id: string }>();
  for (const c of (cellRows ?? []) as Array<{
    id: string;
    crew_user_id: string;
    line_type: ExperiencePartLineType;
  }>) {
    cellMap.set(`${c.crew_user_id}::${c.line_type}`, { id: c.id });
  }

  const lineIdCategory = buildLineIdCategoryMap(
    await listExperienceLineOptions(input.organization),
  );

  for (const sel of selections) {
    const cell = cellMap.get(`${sel.crewUserId}::${sel.lineType}`);
    if (!cell) continue; // 파트 미신청 크루 — 부착할 셀 없음.
    // 라인명은 평점과 분리 — 강화 실패(0점) 셀에도 선택 라인을 그대로 저장한다(null 강제 없음).
    const nextId: string | null = sel.selectedLineId ?? null;
    if (nextId) {
      if (lineIdCategory.get(nextId) !== sel.lineType) {
        throw Object.assign(
          new Error(
            "선택한 라인의 유형이 해당 평가 열과 일치하지 않습니다. 잘못된 라인 선택입니다.",
          ),
          { status: 422 },
        );
      }
    }
    const { error } = await supabaseAdmin
      .from("cluster4_experience_part_submission_cells")
      .update({ selected_line_id: nextId })
      .eq("id", cell.id);
    if (error) throw new Error(error.message);
  }
}

export async function deletePartSubmission(
  organization: string,
  weekId: string,
  teamId: string,
  part: string,
): Promise<{ submitted: false }> {
  // 헤더 삭제 → 셀 CASCADE.
  const { error } = await supabaseAdmin
    .from("cluster4_experience_part_submissions")
    .delete()
    .eq("organization_slug", organization)
    .eq("week_id", weekId)
    .eq("team_id", teamId)
    .eq("part_name", part);
  if (error) throw new Error(error.message);
  return { submitted: false };
}

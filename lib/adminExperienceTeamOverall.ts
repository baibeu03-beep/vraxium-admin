// 실무 경험 [팀 총괄] — 데이터 레이어(standalone).
//
// 개설 검수(임시저장) · 개설 완료(고객 반영) · 개설 취소(원복) 상태를 다음 3+1 테이블로 관리한다.
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
import {
  assertUserIdsInScope,
  resolveUserScope,
  type ScopeMode,
} from "@/lib/userScope";
import { invalidateWeeklyCardsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";
import { assertWeekOpenable } from "@/lib/cluster4OfficialRestWeek";
import { memberStatusLabel } from "@/lib/adminMembersTypes";
import { resolveOutputLinks } from "@/lib/cluster4OutputLinks";
import { insertExperienceOpeningLog } from "@/lib/adminExperienceOpeningLogs";
import {
  EXPERIENCE_OVERALL_CATEGORIES,
  OVERALL_CELL_DEFAULT,
  OVERALL_LEADER_CATEGORIES,
  OVERALL_PART_CATEGORIES,
  type ExperienceOverallCategory,
  type ExperienceTeamOverallBoard,
  type OverallBoardCrew,
  type OverallBoardPart,
  type OverallCell,
  type OverallLeaderCellDto,
  type OverallOutput,
} from "@/lib/experienceTeamOverallTypes";

// part_submissions line_type(도출/분석/견문) ↔ overall category 동일 키.
type PartLineType = "derivation" | "analysis" | "evaluation";

const EXCLUDED_PART_NAMES = new Set<string>(["일반"]);

// 팀 총괄 평가 대상 = 일반/에이전트/파트장(팀장·관리자 제외). 상태 라벨 + 파트장 여부 반환.
function overallMemberStatus(
  role: string | null,
  membershipLevel: string | null,
): { label: string; isPartLeader: boolean } | null {
  const label = memberStatusLabel(role, membershipLevel);
  if (label === "일반") return { label: "일반", isPartLeader: false };
  if (label === "심화(에이전트)") return { label: "에이전트", isPartLeader: false };
  if (label === "심화(파트장)") return { label: "파트장", isPartLeader: true };
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
async function loadTeamMembersWithLeaders(
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

  const rows: OverallMemberRow[] = [];
  for (const p of profs) {
    // 모집단 스코프: operating=실사용자만 / test=테스트 유저만.
    if (!scope.includes(p.user_id)) continue;
    const m = memMap.get(p.user_id);
    if (!m || m.team_name !== teamName) continue;
    if (m.membership_state === "rest") continue; // 휴식 제외(active 만).
    const part = m.part_name?.trim() ?? "";
    if (!part || EXCLUDED_PART_NAMES.has(part)) continue;
    const status = overallMemberStatus(p.role, m.membership_level);
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
    .select("crew_user_id,line_type,checked,score")
    .in("submission_id", headerIds);
  for (const c of (cellRows ?? []) as Array<{
    crew_user_id: string;
    line_type: PartLineType;
    checked: boolean;
    score: number;
  }>) {
    cells.set(`${c.crew_user_id}::${c.line_type}`, {
      checked: c.checked,
      score: c.score,
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
  outputs: Map<ExperienceOverallCategory, { link: string; description: string }>;
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
    .select("crew_user_id,category,checked,score")
    .eq("overall_id", h.id);
  for (const c of (cellRows ?? []) as Array<{
    crew_user_id: string;
    category: "management" | "extension";
    checked: boolean;
    score: number;
  }>) {
    leaderCells.set(`${c.crew_user_id}::${c.category}`, {
      checked: c.checked,
      score: c.score,
    });
  }

  const outputs = new Map<ExperienceOverallCategory, { link: string; description: string }>();
  const { data: outRows } = await supabaseAdmin
    .from("cluster4_experience_team_overall_outputs")
    .select("category,output_link,output_description")
    .eq("overall_id", h.id);
  for (const o of (outRows ?? []) as Array<{
    category: ExperienceOverallCategory;
    output_link: string | null;
    output_description: string | null;
  }>) {
    outputs.set(o.category, {
      link: o.output_link ?? "",
      description: o.output_description ?? "",
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

// 빈 5-카테고리 셀(기본값).
function defaultCells(): Record<ExperienceOverallCategory, OverallCell> {
  const out = {} as Record<ExperienceOverallCategory, OverallCell>;
  for (const c of EXPERIENCE_OVERALL_CATEGORIES) {
    out[c.key] = { ...OVERALL_CELL_DEFAULT };
  }
  return out;
}

// ── 팀 총괄 보드 조립(merged crew cells 포함) ──
export async function getTeamOverallBoard(
  organization: string,
  weekId: string,
  teamId: string,
  teamName: string,
  mode: ScopeMode = "operating",
): Promise<ExperienceTeamOverallBoard> {
  const [members, partCellsData, stored, weekDates] = await Promise.all([
    loadTeamMembersWithLeaders(organization, teamName, mode),
    loadPartSubmissionCells(organization, weekId, teamId),
    loadOverallStored(organization, weekId, teamId),
    loadWeekDates(weekId),
  ]);

  const extension = weekDates
    ? await resolveExtension(organization, weekDates.startDate, weekDates.endDate)
    : { active: false, kind: null as "online" | "offline" | null };

  // 파트별 그룹.
  const partMap = new Map<string, OverallBoardCrew[]>();
  for (const m of members) {
    const cells = defaultCells();
    // 도출/분석/견문 = 파트 신청 라이브(파트장/미신청은 기본값 유지).
    for (const cat of OVERALL_PART_CATEGORIES) {
      const saved = partCellsData.cells.get(`${m.userId}::${cat}`);
      if (saved) cells[cat] = saved;
    }
    // 관리/확장 = 팀장 저장 셀(없으면 기본값).
    for (const cat of OVERALL_LEADER_CATEGORIES) {
      const saved = stored.leaderCells.get(`${m.userId}::${cat}`);
      if (saved) cells[cat] = saved;
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
    ([category, v]) => ({ category, link: v.link, description: v.description }),
  );

  return {
    status: stored.status ?? "none",
    extensionActive: extension.active,
    extensionKind: extension.kind,
    parts,
    outputs,
    reviewedAt: stored.reviewedAt,
    openedAt: stored.openedAt,
  };
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
    const { error: insCellErr } = await supabaseAdmin
      .from("cluster4_experience_team_overall_cells")
      .insert(
        validCells.map((c) => ({
          overall_id: overallId,
          crew_user_id: c.crewUserId,
          category: c.category,
          checked: c.checked,
          score: Math.max(0, Math.min(10, Math.round(c.score))),
        })),
      );
    if (insCellErr) throw new Error(insCellErr.message);
  }

  // 아웃풋 replace(내용 있는 카테고리만).
  const { error: delOutErr } = await supabaseAdmin
    .from("cluster4_experience_team_overall_outputs")
    .delete()
    .eq("overall_id", overallId);
  if (delOutErr) throw new Error(delOutErr.message);
  const validOutputs = input.outputs.filter(
    (o) => o.link.trim() || o.description.trim(),
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
        })),
      );
    if (insOutErr) throw new Error(insOutErr.message);
  }

  return overallId;
}

// ── [개설 검수] 임시저장(고객 미반영) ──
export async function saveTeamOverallReview(input: {
  organization: string;
  weekId: string;
  teamId: string;
  teamName: string;
  leaderCells: OverallLeaderCellDto[];
  outputs: OverallOutput[];
  adminId: string | null;
}): Promise<{ status: "reviewed" }> {
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

  await persistReviewState({ ...input, status: "reviewed" });
  await insertExperienceOpeningLog({
    action: "review",
    draftId: null,
    weekId: input.weekId,
    organizationSlug: input.organization,
    targetUserId: null,
    changedBy: input.adminId,
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
  // org 전용 + 공통(org NULL) 둘 다.
  const { data, error } = await supabaseAdmin
    .from("line_registrations")
    .select(
      "line_code,line_name,line_type,main_title,main_title_mode,output_images,output_links,organization_slug,is_active,bridged_master_id",
    )
    .eq("hub", "experience")
    .eq("is_active", true)
    .not("bridged_master_id", "is", null)
    .or(`organization_slug.is.null,organization_slug.eq.${organization}`)
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

// ── [개설 완료] 최종 저장 + 고객 페이지(cluster4_lines) 반영 ──
export async function openTeamOverall(input: {
  organization: string;
  weekId: string;
  teamId: string;
  teamName: string;
  leaderCells: OverallLeaderCellDto[];
  outputs: OverallOutput[];
  adminId: string | null;
  mode?: ScopeMode;
}): Promise<OpenOverallResult> {
  const mode: ScopeMode = input.mode ?? "operating";
  // 공식 휴식 주차 차단(UI canOpen 과 동일 판정) — operating/test 무관, 모든 write 전 422.
  await assertWeekOpenable(input.weekId);

  const existing = await loadOverallStored(input.organization, input.weekId, input.teamId);
  if (existing.status === "opened") {
    throw Object.assign(
      new Error("이미 개설 완료된 팀입니다. 변경하려면 [개설 취소] 후 다시 진행해주세요."),
      { status: 409 },
    );
  }

  // 1) 입력값 저장(status 는 일단 reviewed 로 보존 — 반영 성공 후 opened 로 승격).
  const overallId = await persistReviewState({
    ...input,
    status: "reviewed",
  });

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

  // 카테고리별 대상 크루(해당 카테고리 checked=true) 수집(라우팅 속성 포함).
  const crewsByCat = new Map<ExperienceOverallCategory, RoutingTarget[]>();
  for (const part of board.parts) {
    for (const crew of part.crews) {
      const cumulativeWeeks = cumulativeWeeksMap.get(crew.userId) ?? 0;
      for (const cat of EXPERIENCE_OVERALL_CATEGORIES) {
        // 확장은 확장 주간에만 반영.
        if (cat.key === "extension" && !board.extensionActive) continue;
        const cell = crew.cells[cat.key];
        if (!cell.checked) continue; // 미체크 = 해당 라인 비대상.
        const list = crewsByCat.get(cat.key) ?? [];
        list.push({
          userId: crew.userId,
          score: cell.score,
          isPartLeader: crew.isPartLeader,
          statusLabel: crew.statusLabel,
          cumulativeWeeks,
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
      // 견문/관리 = 크루별 조건부 라우팅(라인 1+개), 그 외 = 단일 라인.
      const groups = resolveCategoryLineGroups(
        cat.key,
        byCategory.get(cat.key),
        targets,
        board.extensionKind,
        warnings,
      );

      for (const { reg, targets: groupTargets } of groups) {
        if (groupTargets.length === 0) continue;

        const screenOut = outputByCat.get(cat.key);
        const screenLink = screenOut?.link.trim() || null;
        const screenDesc = screenOut?.description.trim() || "";
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
            output_images: reg.outputImages,
            submission_opens_at: submissionOpensAt,
            submission_closes_at: submissionClosesAt,
            is_active: true,
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

        for (const tgt of groupTargets) {
          affectedUserIds.add(tgt.userId);
          const { data: targetRow, error: targetError } = await supabaseAdmin
            .from("cluster4_line_targets")
            .insert({
              line_id: lineId,
              week_id: input.weekId,
              target_mode: "user",
              target_user_id: tgt.userId,
              target_rule: {},
              created_by: input.adminId,
              updated_by: input.adminId,
            })
            .select("id")
            .single();
          if (targetError || !targetRow) {
            throw new Error(targetError?.message ?? "라인 대상 생성 실패");
          }
          const targetId = (targetRow as { id: string }).id;
          createdTargetIds.push(targetId);
          targetsCreated++;

          const { error: evalError } = await supabaseAdmin
            .from("cluster4_experience_line_evaluations")
            .insert({
              line_target_id: targetId,
              user_id: tgt.userId,
              rating: tgt.score,
              evaluated_by: input.adminId,
              evaluated_at: new Date().toISOString(),
            });
          if (evalError) {
            warnings.push(
              `'${cat.label}' ${tgt.userId} 평가 생성 실패 — ${evalError.message}. 라인/대상은 생성됨.`,
            );
          } else {
            evaluationsCreated++;
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

  // 대상자 주차 카드 즉시 재계산(저장 직후 고객 반영) — ≤10 즉시 / >10 background. 평점→강화/주차인정 반영.
  if (affectedUserIds.size > 0) {
    await invalidateWeeklyCardsForUsers(Array.from(affectedUserIds));
  }

  await insertExperienceOpeningLog({
    action: "open",
    draftId: null,
    weekId: input.weekId,
    organizationSlug: input.organization,
    targetUserId: null,
    changedBy: input.adminId,
  });

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
    draftId: null,
    weekId: input.weekId,
    organizationSlug: input.organization,
    targetUserId: null,
    changedBy: input.adminId,
  });

  return { status: "reviewed", linesRemoved: lineIds.length };
}

// 라인 id 집합의 평가→타깃→라인을 역순 삭제(best-effort).
async function rollbackLines(lineIds: string[]): Promise<void> {
  if (lineIds.length === 0) return;
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

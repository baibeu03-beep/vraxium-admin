// 클럽 정보 > 주차 내역 > 활동 관리 > [라인 개설 관리] 탭 — 주차 전체 요약 집계 (read-only).
//
// 라우트와 검증 스크립트가 동일 함수를 호출해 "direct == HTTP" 를 보장한다.
//
// 이번 범위: "주차 전체 라인칸 개설 관리" 요약 5필드까지만(허브별 상세 라인 목록은 다음 작업).
//
// 라인 유니버스(관리 대상) = 오픈 설정(cluster4_week_opening_configs)의 라인 단위와 동일 granularity:
//   · 실무 정보 = 활동유형(activity_types, practical_info) 1개 = 라인 1개 (9종)
//   · 실무 경험 = (팀 × 카테고리 5종[도출·분석·견문·관리·확장]) 각 1개 = 라인 1개
//   · 실무 역량 = 허브 단일 라인 1개
//   · 실무 경력 = 이번 집계에서 제외
//
// 산식:
//   totalLines     = 위 유니버스의 모든 라인 수(실무 경력 제외)
//   openLines      = totalLines 중 [오픈 확인]된 설정에서 체크된(오픈 대상) 라인 수
//                    (open_confirmed=false 면 0 — 확인 전에는 오픈 대상 없음)
//   createdLines   = openLines 중 실제 라인칸(cluster4_lines)이 개설(활성)된 라인 수
//   notCreatedLines= openLines - createdLines
//   lineOpenRate   = openLines==0 ? 0 : round(createdLines / openLines * 100)   ("라인칸 개설율")
//
// "개설 완료(created)" 판정 원천(전부 admin-side · 고객 weekly-card snapshot 무접촉):
//   · 정보 = getInfoLineResultsForWeek(status==='opened') — org/mode 스코프 재사용(활성 라인 존재)
//   · 경험 = cluster4_experience_team_overall(status='opened') ⋈ _opened_lines(category) — (팀,카테고리)
//   · 역량 = cluster4_line_targets(week_id) ⋈ cluster4_lines(part_type='competency', is_active) 中 lineOrg==org
//
// mode(operating/test): 실무 경험 팀 목록 스코프만 달라진다(listTeams). DTO 구조는 동일 — demoUserId 경로 없음.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  loadWeekOpeningConfig,
  type ExperienceLineType,
} from "@/lib/adminTeamPartsInfoWeekDetailData";
import {
  getInfoLineResultsForWeek,
  type InfoLineResultDto,
} from "@/lib/adminCluster4InfoLineResults";
import { listTeams, listCrewsForTargetSelection } from "@/lib/adminExperienceLineData";
import { loadTeamMembersWithLeaders } from "@/lib/adminExperienceTeamOverall";
import {
  canEditOverallManagement,
  type ExperienceOverallCategory,
} from "@/lib/experienceTeamOverallTypes";
import { resolveUserScope } from "@/lib/userScope";
import type { OrganizationSlug } from "@/lib/organizations";
import type { ScopeMode } from "@/lib/userScopeShared";

// 실무 정보 활동유형 표시 순서(adminCluster4InfoLineResults PREFERRED_ORDER 미러 — 라인 목록 정렬 SoT).
const INFO_PREFERRED_ORDER = [
  "wisdom", "essay", "infodesk", "calendar", "forum",
  "session", "practical_lecture", "community", "etc_a",
];

// 실무 경험 5개 라인(표시 순서 = 도출·분석·견문·관리·확장).
//   type   = 오픈 설정(config.practicalExperience[team][type]) 키
//   category = 팀 총괄 개설 카테고리(cluster4_experience_team_overall_opened_lines.category)
//   label  = 라인명(견문=evaluation, 확장=extension 구 워딩 매핑)
const EXP_CATEGORIES: ReadonlyArray<{
  type: ExperienceLineType;
  category: ExperienceOverallCategory;
  label: string;
}> = [
  { type: "derive", category: "derivation", label: "도출" },
  { type: "analysis", category: "analysis", label: "분석" },
  { type: "research", category: "evaluation", label: "견문" },
  { type: "management", category: "management", label: "관리" },
  { type: "expansion", category: "extension", label: "확장" },
];

// 2차 기입 판정(실무 정보 getInfoLineResultsForWeek.hasSecondInput 미러) — 어떤 필드라도 비어있지 않으면 기입.
function hasSecondInputSubmission(sub: Record<string, unknown>): boolean {
  const s = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  const arr = (v: unknown) => Array.isArray(v) && v.length > 0;
  return (
    s(sub.subtitle) || s(sub.growth_point) ||
    s(sub.output_link_2) || s(sub.output_link_3) || s(sub.output_link_4) || s(sub.output_link_5) ||
    arr(sub.output_links) || arr(sub.output_images)
  );
}

export type LineOpeningSummary = {
  totalLines: number;
  openLines: number;
  createdLines: number;
  notCreatedLines: number;
  lineOpenRate: number; // "라인칸 개설율" = createdLines / openLines (오픈율 아님)
};

// 라인칸 개설 진행 상태:
//   not_required          = 개설 불가(이번 주 오픈 대상 아님)
//   required              = 개설 필요(오픈 대상이나 아직 미개설)
//   crew_submitting       = 크루 기입 중(개설 완료·주차 검수 전)
//   crew_submission_closed= 크루 기입 종료(주차 검수 이후)
export type InfoLineProgressStatus =
  | "not_required"
  | "required"
  | "crew_submitting"
  | "crew_submission_closed";

export type InfoLineOpeningRowDto = {
  lineId: string; // 활동유형 id
  lineName: string;
  operatorName: string | null; // 라인칸 개설 운영진(미개설=null)
  isOpenThisWeek: boolean; // 오픈 확인된 설정 기준 오픈 대상
  createdAtLabel: string | null; // "26. 07. 13(월) 12:33" (미개설=null)
  createdAtIso: string | null; // 개설 시점 원본 ISO(정렬용 실제 값·미개설=null). 표시엔 createdAtLabel 사용.
  createdTimingStatus: "ontime" | "late" | null; // 월요일 23:59 기준(미개설=null)
  createdCrewCount: number | null; // 실제 개설 대상 크루(미개설=null)
  eligibleCrewCount: number; // 이 라인을 이행하여 개설 가능했던 크루(=조직 활동 크루 모집단)
  submittedCrewCount: number | null; // 2차 기입 완료 크루(미개설=null)
  submissionEligibleCrewCount: number | null; // 2차 기입 가능 크루(=개설 대상 크루, 미개설=null)
  progressStatus: InfoLineProgressStatus;
};

// 실무 정보/경험 공용 라인칸 행 DTO(구조 동일). 실무 경험 팀 라인도 이 형상을 재사용한다.
export type LineOpeningRowDto = InfoLineOpeningRowDto;

// 실무 경험 팀 — 팀별 요약 + (도출·분석·견문·관리·확장) 5개 라인칸 개설 상태.
export type ExperienceLineOpeningTeam = {
  teamId: string;
  teamName: string;
  summary: LineOpeningSummary;
  lines: LineOpeningRowDto[];
};

export type LineOpeningManagementData = {
  weekId: string;
  club: OrganizationSlug;
  summary: LineOpeningSummary;
  // 허브 급 1: 실무 정보 — 허브 요약 + 산하 라인별 라인칸 개설 상태.
  practicalInfo: {
    summary: LineOpeningSummary;
    lines: InfoLineOpeningRowDto[];
  };
  // 허브 급 2: 실무 경험 — 허브 요약 + 팀별(팀 탭) 요약/라인칸.
  practicalExperience: {
    summary: LineOpeningSummary;
    teams: ExperienceLineOpeningTeam[];
  };
  // 허브 급 3: 실무 역량 — 허브 요약 + 등록 라인(마스터)별 라인칸 개설 상태.
  //   크루가 선택해 진행 → 주 시작 시점엔 오픈 여부 미상. "개설 필요(required)" 상태 없음.
  practicalCompetency: {
    summary: LineOpeningSummary;
    lines: LineOpeningRowDto[];
  };
};

function rate(open: number, created: number): number {
  return open > 0 ? Math.round((created / open) * 100) : 0;
}

// 개설 시점 라벨 — KST "26. 07. 13(월) 12:33". 미개설/파싱 실패 = null.
const KOREAN_DOW = ["일", "월", "화", "수", "목", "금", "토"];
function formatCreatedAtKst(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms + 9 * 3600 * 1000);
  const yy = String(d.getUTCFullYear()).slice(2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const dow = KOREAN_DOW[d.getUTCDay()];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yy}. ${mm}. ${dd}(${dow}) ${hh}:${mi}`;
}

// 개설 타이밍 — 주차 월요일(weekStart) 23:59 KST 이전=ontime, 이후=late. 미개설/정보부족=null.
function createdTiming(
  openedAtIso: string | null,
  weekStart: string | null,
): "ontime" | "late" | null {
  if (!openedAtIso) return null;
  const openedMs = Date.parse(openedAtIso);
  if (Number.isNaN(openedMs)) return null;
  if (!weekStart) return "ontime"; // 개설됐으나 기준 주차 정보 없음 → 정시로 간주.
  const deadline = Date.parse(`${weekStart}T23:59:00+09:00`);
  if (Number.isNaN(deadline)) return "ontime";
  return openedMs <= deadline ? "ontime" : "late";
}

// 허브 급 3: 실무 역량 — 등록 라인(cluster4_competency_line_masters, is_active) 전부 표시 + 라인칸 개설 상태.
//   역량 라인은 크루가 선택해 진행 → 개설되기 전엔 오픈 여부 미상. "개설 필요(required)" 상태 없음:
//     · 미개설 = 개설 불가(not_required, 회색)   · 개설 완료 = 크루 기입 중   · 주차 검수 이후 = 크루 기입 종료
//   개설 판정(클럽 기준) = 마스터에 연결된 활성 역량 라인(cluster4_lines.competency_line_master_id)이
//     이번 주 타깃을 가지며, 그 타깃 중 클럽 활동 크루(eligibleCrewIds)가 1명 이상.
//     · 개설 크루 = 그 클럽 크루 수 / 분모 = 클럽 활동 크루(eligibleCrewIds.size)
//     · 기입 크루 = 그 크루 중 2차 기입 존재 수 / 분모 = 개설 크루
//   openLines = createdLines(개설=오픈), notCreatedLines=0. 등록 30개는 하드코딩 아님(마스터 조회).
async function loadCompetencyLineOpening(opts: {
  weekId: string;
  organization: OrganizationSlug;
  weekStart: string | null;
  reviewed: boolean;
  eligibleCrewIds: ReadonlySet<string>;
}): Promise<LineOpeningManagementData["practicalCompetency"]> {
  const { weekId, organization, weekStart, reviewed, eligibleCrewIds } = opts;
  const empty = { summary: { totalLines: 0, openLines: 0, createdLines: 0, notCreatedLines: 0, lineOpenRate: 0 }, lines: [] as LineOpeningRowDto[] };

  // 1) 등록 라인(마스터) — 클럽 노출(common ∪ org). 표시 순서 = line_code.
  const { data: masterData, error: mErr } = await supabaseAdmin
    .from("cluster4_competency_line_masters")
    .select("id,line_code,line_name")
    .eq("is_active", true)
    .in("organization_slug", ["common", organization]);
  if (mErr) {
    console.warn("[line-opening-management] competency masters unavailable:", mErr.message);
    return empty;
  }
  const masters = ((masterData ?? []) as Array<{ id: string; line_code: string | null; line_name: string | null }>)
    .sort((a, b) => (a.line_code ?? "").localeCompare(b.line_code ?? ""));
  if (masters.length === 0) return empty;
  const masterIds = new Set(masters.map((m) => m.id));

  // 2) 이번 주 타깃 → line_id + user, 그리고 competency 라인 메타(마스터/개설시점/개설자).
  const { data: tRows, error: tErr } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("id,line_id,target_user_id")
    .eq("week_id", weekId);
  const targetsByLine = new Map<string, Array<{ id: string; userId: string | null }>>();
  const lineIds: string[] = [];
  if (!tErr) {
    for (const r of (tRows ?? []) as Array<{ id: string; line_id: string | null; target_user_id: string | null }>) {
      if (!r.line_id) continue;
      const arr = targetsByLine.get(r.line_id) ?? [];
      if (arr.length === 0) lineIds.push(r.line_id);
      arr.push({ id: r.id, userId: r.target_user_id });
      targetsByLine.set(r.line_id, arr);
    }
  }
  type CompLine = { masterId: string; openedAt: string | null; openerId: string | null };
  const compLineById = new Map<string, CompLine>();
  if (lineIds.length) {
    for (let i = 0; i < lineIds.length; i += 200) {
      const chunk = lineIds.slice(i, i + 200);
      const { data: lineRows } = await supabaseAdmin
        .from("cluster4_lines")
        .select("id,competency_line_master_id,opened_at,created_at,opened_by,created_by")
        .eq("part_type", "competency")
        .eq("is_active", true)
        .in("id", chunk);
      for (const r of (lineRows ?? []) as Array<{ id: string; competency_line_master_id: string | null; opened_at: string | null; created_at: string | null; opened_by: string | null; created_by: string | null }>) {
        if (!r.competency_line_master_id || !masterIds.has(r.competency_line_master_id)) continue;
        compLineById.set(r.id, { masterId: r.competency_line_master_id, openedAt: r.opened_at ?? r.created_at, openerId: r.opened_by ?? r.created_by });
      }
    }
  }

  // 3) 마스터별 집계 — 클럽 크루 타깃(eligibleCrewIds)만. 개설 크루/기입 크루 분모 = 클럽 크루.
  type Agg = { users: Set<string>; targetIds: string[]; openedAt: string | null; openerId: string | null };
  const aggByMaster = new Map<string, Agg>();
  for (const [lineId, targets] of targetsByLine) {
    const meta = compLineById.get(lineId);
    if (!meta) continue;
    const agg = aggByMaster.get(meta.masterId) ?? { users: new Set<string>(), targetIds: [], openedAt: meta.openedAt, openerId: meta.openerId };
    // 개설 시점/개설자는 가장 이른 라인 기준(멀티 라인 대비).
    if (meta.openedAt && (!agg.openedAt || meta.openedAt < agg.openedAt)) { agg.openedAt = meta.openedAt; agg.openerId = meta.openerId; }
    for (const t of targets) {
      if (!t.userId || !eligibleCrewIds.has(t.userId)) continue; // 클럽 활동 크루만.
      agg.users.add(t.userId);
      agg.targetIds.push(t.id);
    }
    aggByMaster.set(meta.masterId, agg);
  }

  // 4) 2차 기입 크루 수(개설 크루 분모) — 위 target id 들 제출 중 기입 존재.
  const submittedByMaster = new Map<string, number>();
  const targetIdToMaster = new Map<string, string>();
  for (const [masterId, agg] of aggByMaster) for (const tid of agg.targetIds) targetIdToMaster.set(tid, masterId);
  const allTargetIds = [...targetIdToMaster.keys()];
  for (let i = 0; i < allTargetIds.length; i += 500) {
    const chunk = allTargetIds.slice(i, i + 500);
    const { data } = await supabaseAdmin
      .from("cluster4_line_submissions")
      .select("line_target_id,subtitle,growth_point,output_link_2,output_link_3,output_link_4,output_link_5,output_links,output_images")
      .in("line_target_id", chunk);
    for (const r of (data ?? []) as Array<Record<string, unknown> & { line_target_id: string }>) {
      if (!hasSecondInputSubmission(r)) continue;
      const masterId = targetIdToMaster.get(r.line_target_id);
      if (masterId) submittedByMaster.set(masterId, (submittedByMaster.get(masterId) ?? 0) + 1);
    }
  }

  // 5) 운영진(개설자) 이름.
  const openerIds = Array.from(new Set([...aggByMaster.values()].map((a) => a.openerId).filter((v): v is string => !!v)));
  const nameById = new Map<string, string>();
  if (openerIds.length) {
    const { data: profs } = await supabaseAdmin.from("user_profiles").select("user_id,display_name").in("user_id", openerIds);
    for (const p of (profs ?? []) as Array<{ user_id: string; display_name: string | null }>) if (p.display_name?.trim()) nameById.set(p.user_id, p.display_name.trim());
    const missing = openerIds.filter((id) => !nameById.has(id));
    if (missing.length) {
      const { data: admins } = await supabaseAdmin.from("admin_users").select("id,email").in("id", missing);
      for (const a of (admins ?? []) as Array<{ id: string; email: string | null }>) if (a.email) nameById.set(a.id, a.email);
    }
  }

  // 6) 라인 DTO — 등록 마스터 전부. 개설(클럽 크루≥1) 여부로 상태 결정.
  const eligibleCrewCount = eligibleCrewIds.size;
  const lines: LineOpeningRowDto[] = masters.map((m) => {
    const agg = aggByMaster.get(m.id) ?? null;
    const createdCrewCount = agg ? agg.users.size : 0;
    const created = createdCrewCount > 0; // 클럽 기준 개설.
    // 역량은 "개설 필요(required)" 없음 → 미개설=not_required, 개설=크루 기입 중/종료.
    const progressStatus: InfoLineProgressStatus = !created
      ? "not_required"
      : reviewed
        ? "crew_submission_closed"
        : "crew_submitting";
    return {
      lineId: m.id,
      lineName: m.line_name ?? m.line_code ?? m.id,
      operatorName: created && agg?.openerId ? nameById.get(agg.openerId) ?? "관리자" : null,
      // 개설=오픈(역량은 개설 시점에야 오픈 여부를 앎). 미개설=미오픈.
      isOpenThisWeek: created,
      createdAtLabel: created ? formatCreatedAtKst(agg?.openedAt ?? null) : null,
      createdAtIso: created ? agg?.openedAt ?? null : null,
      createdTimingStatus: created ? createdTiming(agg?.openedAt ?? null, weekStart) : null,
      createdCrewCount: created ? createdCrewCount : null,
      eligibleCrewCount,
      submittedCrewCount: created ? submittedByMaster.get(m.id) ?? 0 : null,
      submissionEligibleCrewCount: created ? createdCrewCount : null,
      progressStatus,
    };
  });

  const totalLines = lines.length;
  const createdLines = lines.filter((l) => l.isOpenThisWeek).length;
  // openLines = createdLines(개설=오픈), notCreatedLines=0.
  return {
    summary: {
      totalLines,
      openLines: createdLines,
      createdLines,
      notCreatedLines: 0,
      lineOpenRate: rate(createdLines, createdLines),
    },
    lines,
  };
}

// 허브 급 2: 실무 경험 — 팀별(팀 탭) 요약 + (도출·분석·견문·관리·확장) 라인칸 개설 상태.
//   집계는 "전체 클럽"이 아니라 "선택 팀"의 활동 크루 기준. 관리(management) 라인 모수 = 심화 크루(≤팀당 10).
//   개설 원천: cluster4_experience_team_overall(status='opened') ⋈ _opened_lines(category, line_id).
//     · 운영진/개설 시점 = 헤더 opened_by / opened_at
//     · 개설 크루        = 개설 라인의 user 타깃(현재 모드 스코프) 수
//     · 기입 크루        = 그 타깃 중 2차 기입 존재 수 / 분모 = 개설 크루
//   테이블 미적용/오류는 fail-closed(미개설)로 본다.
async function loadExperienceLineOpening(opts: {
  weekId: string;
  organization: OrganizationSlug;
  mode: ScopeMode;
  config: Awaited<ReturnType<typeof loadWeekOpeningConfig>>["config"];
  openConfirmed: boolean;
  teams: Array<{ id: string; teamName: string }>;
  weekStart: string | null;
  reviewed: boolean;
}): Promise<LineOpeningManagementData["practicalExperience"]> {
  const { weekId, organization, mode, config, openConfirmed, teams, weekStart, reviewed } = opts;
  const savedExp = config?.practicalExperience ?? {};
  const teamIds = teams.map((t) => t.id);

  const scope = await resolveUserScope(mode, null);

  // 1) 팀별 총괄 헤더(status/opened_at/opened_by).
  type Header = { overallId: string; status: string | null; openedAt: string | null; openedBy: string | null };
  const headerByTeam = new Map<string, Header>();
  const overallToTeam = new Map<string, string>();
  if (teamIds.length) {
    const { data, error } = await supabaseAdmin
      .from("cluster4_experience_team_overall")
      .select("id,team_id,status,opened_at,opened_by")
      .eq("organization_slug", organization)
      .eq("week_id", weekId)
      .in("team_id", teamIds);
    if (error) console.warn("[line-opening-management] exp headers unavailable:", error.message);
    else
      for (const r of (data ?? []) as Array<{ id: string; team_id: string; status: string | null; opened_at: string | null; opened_by: string | null }>) {
        headerByTeam.set(r.team_id, { overallId: r.id, status: r.status, openedAt: r.opened_at, openedBy: r.opened_by });
        overallToTeam.set(r.id, r.team_id);
      }
  }

  // 2) 개설 라인(opened_lines) — (teamId::category) 생성 집합 + 라인 id 목록.
  const createdSet = new Set<string>();
  const keyByLineId = new Map<string, string>();
  const openedOverallIds = [...headerByTeam.values()].filter((h) => h.status === "opened").map((h) => h.overallId);
  if (openedOverallIds.length) {
    const { data, error } = await supabaseAdmin
      .from("cluster4_experience_team_overall_opened_lines")
      .select("overall_id,category,line_id")
      .in("overall_id", openedOverallIds);
    if (error) console.warn("[line-opening-management] exp opened_lines unavailable:", error.message);
    else
      for (const r of (data ?? []) as Array<{ overall_id: string; category: string; line_id: string | null }>) {
        const teamId = overallToTeam.get(r.overall_id);
        if (!teamId) continue;
        const key = `${teamId}::${r.category}`;
        createdSet.add(key);
        if (r.line_id) keyByLineId.set(r.line_id, key);
      }
  }

  // 3) 개설 라인 타깃 → (teamId::category) 별 개설 크루(현재 모드 스코프) + target id.
  const usersByKey = new Map<string, Set<string>>();
  const keyByTargetId = new Map<string, string>();
  const allLineIds = [...keyByLineId.keys()];
  for (let i = 0; i < allLineIds.length; i += 200) {
    const chunk = allLineIds.slice(i, i + 200);
    const { data, error } = await supabaseAdmin
      .from("cluster4_line_targets")
      .select("id,line_id,target_user_id,target_mode")
      .eq("week_id", weekId)
      .eq("target_mode", "user")
      .in("line_id", chunk);
    if (error) continue;
    for (const r of (data ?? []) as Array<{ id: string; line_id: string; target_user_id: string | null; target_mode: string }>) {
      const key = keyByLineId.get(r.line_id);
      if (!key || !r.target_user_id || !scope.includes(r.target_user_id)) continue;
      const set = usersByKey.get(key) ?? new Set<string>();
      set.add(r.target_user_id);
      usersByKey.set(key, set);
      keyByTargetId.set(r.id, key);
    }
  }

  // 4) 2차 기입 크루 수(개설 크루 분모) — 위 target id 들의 제출 중 기입 존재.
  const submittedByKey = new Map<string, number>();
  const allTargetIds = [...keyByTargetId.keys()];
  for (let i = 0; i < allTargetIds.length; i += 500) {
    const chunk = allTargetIds.slice(i, i + 500);
    const { data, error } = await supabaseAdmin
      .from("cluster4_line_submissions")
      .select("line_target_id,subtitle,growth_point,output_link_2,output_link_3,output_link_4,output_link_5,output_links,output_images")
      .in("line_target_id", chunk);
    if (error) continue;
    for (const r of (data ?? []) as Array<Record<string, unknown> & { line_target_id: string }>) {
      if (!hasSecondInputSubmission(r)) continue;
      const key = keyByTargetId.get(r.line_target_id);
      if (key) submittedByKey.set(key, (submittedByKey.get(key) ?? 0) + 1);
    }
  }

  // 5) 운영진(개설자) 이름 — opened_by → display_name(없으면 admin email ?? "관리자").
  const openerIds = Array.from(new Set([...headerByTeam.values()].map((h) => h.openedBy).filter((v): v is string => !!v)));
  const nameById = new Map<string, string>();
  if (openerIds.length) {
    const { data: profs } = await supabaseAdmin.from("user_profiles").select("user_id,display_name").in("user_id", openerIds);
    for (const p of (profs ?? []) as Array<{ user_id: string; display_name: string | null }>) {
      if (p.display_name?.trim()) nameById.set(p.user_id, p.display_name.trim());
    }
    const missing = openerIds.filter((id) => !nameById.has(id));
    if (missing.length) {
      const { data: admins } = await supabaseAdmin.from("admin_users").select("id,email").in("id", missing);
      for (const a of (admins ?? []) as Array<{ id: string; email: string | null }>) if (a.email) nameById.set(a.id, a.email);
    }
  }

  // 6) 팀 코호트(개설 가능 크루 모수) — 팀별 활동 크루. 관리 라인 = 심화 크루(파트장/에이전트)만.
  const cohorts = await Promise.all(
    teams.map((t) => loadTeamMembersWithLeaders(organization, t.teamName, mode).catch(() => [])),
  );

  // 7) 팀 DTO 조립.
  const teamDtos: ExperienceLineOpeningTeam[] = teams.map((t, i) => {
    const header = headerByTeam.get(t.id) ?? null;
    const cohort = cohorts[i];
    const cohortCount = cohort.length;
    const advancedCount = cohort.filter((c) => canEditOverallManagement(c)).length; // 심화(관리 라인 모수)
    const operatorName = header?.openedBy ? nameById.get(header.openedBy) ?? "관리자" : null;
    const savedTeam = savedExp[t.id] ?? {};

    const lines: LineOpeningRowDto[] = EXP_CATEGORIES.map((c) => {
      const key = `${t.id}::${c.category}`;
      const isOpenThisWeek = openConfirmed && savedTeam[c.type] === true;
      const created = createdSet.has(key);
      // 관리 라인 모수 = 심화 크루 · 그 외 = 팀 전체 활동 크루.
      const baseEligible = c.category === "management" ? advancedCount : cohortCount;
      const createdCrewCount = created ? usersByKey.get(key)?.size ?? 0 : null;
      // 개설된 라인의 "받을 수 있었던 크루"는 실제 받은 크루 이상이어야 한다. 과거 주차 코호트 drift
      //   (개설 당시 대상 > 현재 팀 코호트)로 개설>모수 역전이 나지 않도록 하한 보정(현재 주차엔 무영향).
      const eligibleCrewCount =
        created && createdCrewCount != null ? Math.max(baseEligible, createdCrewCount) : baseEligible;
      const submittedCrewCount = created ? submittedByKey.get(key) ?? 0 : null;
      let progressStatus: InfoLineProgressStatus;
      if (!isOpenThisWeek) progressStatus = "not_required";
      else if (!created) progressStatus = "required";
      else progressStatus = reviewed ? "crew_submission_closed" : "crew_submitting";
      return {
        lineId: key,
        lineName: c.label,
        operatorName: created ? operatorName : null,
        isOpenThisWeek,
        createdAtLabel: created ? formatCreatedAtKst(header?.openedAt ?? null) : null,
        createdAtIso: created ? header?.openedAt ?? null : null,
        createdTimingStatus: created ? createdTiming(header?.openedAt ?? null, weekStart) : null,
        createdCrewCount,
        eligibleCrewCount,
        submittedCrewCount,
        submissionEligibleCrewCount: createdCrewCount,
        progressStatus,
      };
    });

    const openLines = lines.filter((l) => l.isOpenThisWeek).length;
    const createdLines = lines.filter(
      (l) => l.isOpenThisWeek && (l.progressStatus === "crew_submitting" || l.progressStatus === "crew_submission_closed"),
    ).length;
    return {
      teamId: t.id,
      teamName: t.teamName,
      summary: {
        totalLines: lines.length,
        openLines,
        createdLines,
        notCreatedLines: openLines - createdLines,
        lineOpenRate: rate(openLines, createdLines),
      },
      lines,
    };
  });

  // 허브 요약 — 팀별 합산이 아니라 "대표로 1번"(카테고리 distinct) 집계. 모든 팀이 동일한 5개
  //   카테고리를 공유하므로 팀 수만큼 곱하지 않는다. 전체=카테고리 수, 오픈=어느 팀이든 오픈된
  //   카테고리(1회), 개설=어느 팀이든 개설(크루 기입)된 카테고리(1회).
  const openCategories = new Set<string>();
  const createdCategories = new Set<string>();
  for (const t of teamDtos) {
    for (const l of t.lines) {
      if (!l.isOpenThisWeek) continue;
      // lineId = `${teamId}::${category}` → 카테고리만 추출해 팀 간 중복 제거.
      const category = l.lineId.slice(l.lineId.indexOf("::") + 2);
      openCategories.add(category);
      if (l.progressStatus === "crew_submitting" || l.progressStatus === "crew_submission_closed") {
        createdCategories.add(category);
      }
    }
  }
  const hub: LineOpeningSummary = {
    totalLines: EXP_CATEGORIES.length,
    openLines: openCategories.size,
    createdLines: createdCategories.size,
    notCreatedLines: openCategories.size - createdCategories.size,
    lineOpenRate: rate(openCategories.size, createdCategories.size),
  };

  return { summary: hub, teams: teamDtos };
}

// 실무 정보 활동유형(라인) 카탈로그 — 관리 대상 유니버스(총 라인 수·라인명) SoT. 표시 순서 적용.
async function loadInfoCatalog(): Promise<Array<{ id: string; name: string }>> {
  const { data, error } = await supabaseAdmin
    .from("activity_types")
    .select("id,name")
    .eq("cluster_id", "practical_info")
    .eq("is_active", true);
  if (error) {
    console.warn("[line-opening-management] activity_types unavailable:", error.message);
    return [];
  }
  const rows = (data ?? []) as Array<{ id: string; name: string | null }>;
  const orderIdx = (id: string) => {
    const i = INFO_PREFERRED_ORDER.indexOf(id);
    return i < 0 ? INFO_PREFERRED_ORDER.length : i;
  };
  rows.sort((a, b) => orderIdx(a.id) - orderIdx(b.id) || a.id.localeCompare(b.id));
  return rows.map((r) => ({ id: r.id, name: r.name ?? r.id }));
}

// 주차 메타 — 월요일(start_date, 개설 타이밍 기준) + 검수 여부(result_reviewed_at, 크루 기입 종료 판정).
async function loadWeekMeta(
  weekId: string,
): Promise<{ startDate: string | null; reviewed: boolean }> {
  const { data, error } = await supabaseAdmin
    .from("weeks")
    .select("start_date,result_reviewed_at")
    .eq("id", weekId)
    .maybeSingle();
  if (error) {
    console.warn("[line-opening-management] weeks meta unavailable:", error.message);
    return { startDate: null, reviewed: false };
  }
  const row = data as { start_date: string | null; result_reviewed_at: string | null } | null;
  return { startDate: row?.start_date ?? null, reviewed: row?.result_reviewed_at != null };
}

export async function loadTeamPartsInfoLineOpeningManagement(opts: {
  weekId: string;
  organization: OrganizationSlug;
  mode: ScopeMode;
}): Promise<LineOpeningManagementData> {
  const { weekId, organization, mode } = opts;

  // 유니버스(관리 대상) + [오픈 확인]된 raw 설정 + 개설 완료 원천 + 부가 메타 — 병렬 로드.
  //   "오픈" 판정은 UI 기본값 병합이 아닌 실제 저장(확인)된 config 기준(오픈 확인된 설정 기준).
  const [
    { config, openConfirmed },
    infoCatalog,
    teams,
    infoResults,
    weekMeta,
    eligibleCrews,
  ] = await Promise.all([
    loadWeekOpeningConfig(weekId, organization),
    loadInfoCatalog(),
    listTeams(organization, mode),
    getInfoLineResultsForWeek({ weekId, organization, mode }).catch((e) => {
      console.warn(
        "[line-opening-management] info line results unavailable:",
        e instanceof Error ? e.message : e,
      );
      return null;
    }),
    loadWeekMeta(weekId),
    // 개설 가능했던 크루(모집단) = 조직 활동 크루(휴식 제외·현재 모드 스코프). 라인 공통 분모.
    listCrewsForTargetSelection({ organization, status: "active", mode }).catch((e) => {
      console.warn(
        "[line-opening-management] eligible crews unavailable:",
        e instanceof Error ? e.message : e,
      );
      return [];
    }),
  ]);

  const savedInfo = config?.practicalInfo ?? {};
  const eligibleCrewCount = eligibleCrews.length;
  const eligibleCrewIds = new Set(eligibleCrews.map((c) => c.userId));
  const infoResultById = new Map<string, InfoLineResultDto>(
    (infoResults?.lines ?? []).map((l) => [l.activityTypeId, l]),
  );
  // 개설 타이밍 기준 주차 월요일 — infoResults(있으면) 우선, 없으면 weeks.start_date.
  const weekStart = infoResults?.weekStartDate ?? weekMeta.startDate;

  // ── 허브 급 1: 실무 정보 — 라인별 라인칸 개설 상태 + 허브 요약 ──
  const infoLines: InfoLineOpeningRowDto[] = infoCatalog.map((cat) => {
    const isOpenThisWeek = openConfirmed && savedInfo[cat.id] === true;
    const r = infoResultById.get(cat.id) ?? null;
    const created = r?.status === "opened";

    let progressStatus: InfoLineProgressStatus;
    if (!isOpenThisWeek) progressStatus = "not_required";
    else if (!created) progressStatus = "required";
    else progressStatus = weekMeta.reviewed ? "crew_submission_closed" : "crew_submitting";

    return {
      lineId: cat.id,
      lineName: r?.lineName ?? cat.name,
      operatorName: created ? r?.openedByName ?? null : null,
      isOpenThisWeek,
      createdAtLabel: created ? formatCreatedAtKst(r?.openedAt ?? null) : null,
      createdAtIso: created ? r?.openedAt ?? null : null,
      createdTimingStatus: created ? createdTiming(r?.openedAt ?? null, weekStart) : null,
      createdCrewCount: created ? r?.targetCount ?? 0 : null,
      eligibleCrewCount,
      submittedCrewCount: created ? r?.secondInputCount ?? 0 : null,
      submissionEligibleCrewCount: created ? r?.targetCount ?? 0 : null,
      progressStatus,
    };
  });
  const infoTotal = infoLines.length;
  const infoOpen = infoLines.filter((l) => l.isOpenThisWeek).length;
  const infoCreated = infoLines.filter(
    (l) => l.isOpenThisWeek && l.progressStatus !== "required",
  ).length;

  // ── 허브 급 2: 실무 경험 — 팀별 요약/라인칸(선택 팀 기준 집계) ──
  const experience = await loadExperienceLineOpening({
    weekId,
    organization,
    mode,
    config,
    openConfirmed,
    teams,
    weekStart,
    reviewed: weekMeta.reviewed,
  });

  // ── 허브 급 3: 실무 역량 — 등록 라인(마스터)별 개설 상태(클럽 크루 기준) ──
  const competency = await loadCompetencyLineOpening({
    weekId,
    organization,
    weekStart,
    reviewed: weekMeta.reviewed,
    eligibleCrewIds,
  });

  // ── 주차 전체 요약 = 정보 + 경험 + 역량 합(실무 경력 제외) ──
  const totalLines = infoTotal + experience.summary.totalLines + competency.summary.totalLines;
  const openLines = infoOpen + experience.summary.openLines + competency.summary.openLines;
  const createdLines = infoCreated + experience.summary.createdLines + competency.summary.createdLines;

  return {
    weekId,
    club: organization,
    summary: {
      totalLines,
      openLines,
      createdLines,
      notCreatedLines: openLines - createdLines,
      lineOpenRate: rate(openLines, createdLines),
    },
    practicalInfo: {
      summary: {
        totalLines: infoTotal,
        openLines: infoOpen,
        createdLines: infoCreated,
        notCreatedLines: infoOpen - infoCreated,
        lineOpenRate: rate(infoOpen, infoCreated),
      },
      lines: infoLines,
    },
    practicalExperience: experience,
    practicalCompetency: competency,
  };
}

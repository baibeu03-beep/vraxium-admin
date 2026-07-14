// 클럽 정보 > 주차 내역 > 활동 관리 > [액트 체크 관리] 탭 — 집계/목록 (read-only).
//
// 라우트와 검증 스크립트가 동일 함수를 호출해 "direct == HTTP" 를 보장한다.
//
// 허브: 클럽 총괄(0)·실무 정보(1)·실무 경험(2, 팀 탭)·실무 역량(3). 각 허브 요약 + 라인급별 요일 액트.
//
// 데이터 원천(전부 live 조회 — 고객 weekly-card snapshot 무접촉):
//   · 라인급(체크) SoT   = process_line_groups(hub, is_active) — 프로세스 등록 "소속 라인급"과 동일 line_group_id
//   · 정규 액트          = process_acts (hub ∈ ACT_HUBS, is_active) — line_group_id 로 직접 분류(이름매칭 없음)
//   · 요일               = process_acts.occur_dow (0=일 … 6=토)
//   · 체크/신청시점/담당자 = process_check_statuses(org, hub, week) 의 status·requested_at·completed_at·scheduled_check_at·requested_by
//   · 변동 액트          = process_irregular_acts(org, week_id, scope_mode=mode) — scheduled_check_at 요일로 배치(info 귀속)
//   · "가동"(오픈) 판정  = open_confirmed && 라인급 체크(config.actCheck.{info,experience,club}·competency=practicalCompetency.checked)
//     · config.actCheck 부재(과거 확정 주차) 시 라인급 기본 전체 체크(읽기전용 표시만 — 결과/포인트/snapshot 무영향)
//
// 신청 시점(scheduledLabel): 정규 = 상태행 scheduled_check_at ?? 액트 check 요일/시각(주차 기준 파생). 변동 = scheduled_check_at.
// 체크 상태(checkStatus): 신청됨일 때만 — 실제 신청(completed_at ?? requested_at) ≤ 신청 시점 → 'ontime'(🔴), 초과 → 'late'(🔵).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadWeekOpeningConfig } from "@/lib/adminTeamPartsInfoWeekDetailData";
import { listTeams } from "@/lib/adminExperienceLineData";
import { formatClubDate, formatClubDateTime, formatClubWeekdayTime } from "@/lib/clubDate";
import { resolveActCardState, type ActCardState } from "@/lib/actCardState";
import { memberStatusLabel } from "@/lib/adminMembersTypes";
import type { OrganizationSlug } from "@/lib/organizations";
import type { ScopeMode } from "@/lib/userScopeShared";

// 액트 체크(7) 대상 허브. 라인급(체크) SoT = process_line_groups(hub, is_active) — 프로세스 등록의
//   "소속 라인급"·활동관리 "라인 급(체크)"·여기 액트 분류가 모두 동일 line_group_id 를 공유한다(이름
//   매칭·activity_types 매핑 없음). info/experience/club = config.actCheck 게이트, competency =
//   practicalCompetency.checked(공유) 게이트. 신규 라인급을 프로세스 등록에서 추가하면 자동 노출된다.
const ACT_HUBS = ["info", "experience", "competency", "club"] as const;

// [클럽 총괄] 초기 정규 라인급 시드(2종) — scripts/seed-club-overall-act-check-lines.ts 참조용.
//   ⚠ allowlist 아님: 액트 체크 관리는 hub='club' 활성 라인급 "전체"를 노출한다(프로세스 등록 추가분 자동 반영).
//   시드는 "최소 2종 보장"일 뿐이며 스코프 필터로 쓰지 않는다.
export const CLUB_ACT_CHECK_LINE_SEED = [
  { id: "0c1b0000-0000-4000-8000-000000000001", name: "클럽 전체 가이드" },
  { id: "0c1b0000-0000-4000-8000-000000000002", name: "행정 보안 검수" },
] as const;

// occur_dow(0=일 … 6=토) → 요일 키.
const DOW_KEY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
type DayKey = (typeof DOW_KEY)[number];
function emptyByDay<T>(): Record<DayKey, T[]> {
  return { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
}

export type ActCheckStatus = "ontime" | "late" | null;

export type ActCheckSummary = {
  totalActs: number;
  activeActs: number;
  checkedActs: number;
  uncheckedActs: number;
  variableActs: number;
  actCheckRate: number;
};

export type ActCheckActDto = {
  actId: string;
  actName: string;
  isActiveThisWeek: boolean;
  isChecked: boolean;
  // 카드 상태 5종(서버 판정 — 원본 timestamp 로만 비교). 색상/표시의 단일 SoT.
  cardState: ActCardState;
  // 원본 timestamp(ISO·KST 비교용·표시 아님) — 일반/테스트 모드 동일 구조 검증용으로 노출.
  requiredCheckedAt: string | null; // 필요 시점(체크 신청 마감)
  actualCheckedAt: string | null; // 실제 체크 신청 시점(미신청 null)
  // 표시 라벨(모든 상태에서 1번째 줄에 "액트명 | [필요] (요일) HH:mm").
  requiredLabel: string | null; // "(목) 14:00"
  // 완료 상태 2번째 줄 "[신청 시점(실제)] YY - MM - DD (요일) HH:mm".
  actualLabel: string | null;
  requesterLabel: string | null; // "홍길동 님(앰배서더)"
  // (호환) 요약/요일 통계용. 표시 로직은 cardState 사용.
  scheduledLabel: string | null; // 신청 시점 "26 - 07 - 14 (화) 14:30"
  checkStatus: ActCheckStatus; // ontime / late / null(미신청)
};

export type ActCheckVariableActDto = {
  id: string;
  actName: string;
  cardState: ActCardState;
  requiredCheckedAt: string | null;
  actualCheckedAt: string | null;
  requiredLabel: string | null;
  actualLabel: string | null;
  requesterLabel: string | null;
  scheduledLabel: string | null;
  checkStatus: ActCheckStatus;
};

export type ActCheckInfoLineDto = {
  lineId: string;
  lineName: string;
  isOpenThisWeek: boolean;
  regularActsByDay: Record<DayKey, ActCheckActDto[]>;
};

// 실무 경험 팀 탭 — 팀별 요약 + 라인급(라인그룹) 행 + 요일별 액트.
export type ActCheckHubTeam = {
  teamId: string;
  teamName: string;
  summary: ActCheckSummary;
  lines: ActCheckInfoLineDto[];
  variableActsByDay: Record<DayKey, ActCheckVariableActDto[]>;
};

export type ActCheckManagementData = {
  weekId: string;
  club: OrganizationSlug;
  summary: ActCheckSummary;
  // 허브 급 0: 클럽 총괄 — 실무 정보와 동일 구조(허브 요약 + 라인급/요일 액트). 라인=고정 카탈로그 2종.
  //   가동/체크 = 허브 단위(clubOpen = openConfirmed). 변동 액트는 info 허브 귀속 → 클럽 총괄 변동=0.
  clubOverall: {
    summary: ActCheckSummary;
    lines: ActCheckInfoLineDto[];
    variableActsByDay: Record<DayKey, ActCheckVariableActDto[]>;
  };
  practicalInfo: {
    summary: ActCheckSummary;
    lines: ActCheckInfoLineDto[];
    // 요일별 변동 액트(정규 액트 아래 "변동 액트" 행에 표시).
    variableActsByDay: Record<DayKey, ActCheckVariableActDto[]>;
  };
  // 실무 경험 — 허브 요약 + 팀 탭(팀별 요약/라인급/요일 액트).
  practicalExperience: {
    summary: ActCheckSummary;
    teams: ActCheckHubTeam[];
  };
  // 실무 역량 — 실무 정보와 동일 구조(허브 요약 + 라인급/요일 액트). 현재 라인 1개.
  practicalCompetency: {
    summary: ActCheckSummary;
    lines: ActCheckInfoLineDto[];
    variableActsByDay: Record<DayKey, ActCheckVariableActDto[]>;
  };
};

type ActRow = {
  id: string;
  line_group_id: string | null;
  hub: string;
  act_name: string;
  occur_dow: number | null;
  check_week: string | null;
  check_dow: number | null;
  check_time: string | null;
  check_target: string | null;
};

type StatusRow = {
  act_id: string | null;
  status: string | null;
  requested_at: string | null;
  completed_at: string | null;
  scheduled_check_at: string | null;
  requested_by: string | null;
};

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
// weekStart(월요일 ISO) + occur/check dow(0=일…6=토, N1=다음주) → 날짜 ISO.
function dateForDow(weekStart: string | null, dow: number | null, weekRef: string | null): string | null {
  if (!weekStart || dow == null) return null;
  const offsetFromMonday = (dow + 6) % 7; // 월=0 … 일=6
  return addDaysIso(weekStart, offsetFromMonday + (weekRef === "N1" ? 7 : 0));
}
function hhmm(t: string | null): string | null {
  return t && /^\d{2}:\d{2}/.test(t) ? t.slice(0, 5) : null;
}
function deadlineMsKst(dateIso: string | null, timeStr: string | null): number | null {
  if (!dateIso) return null;
  const t = hhmm(timeStr) ?? "23:59";
  const ms = Date.parse(`${dateIso}T${t}:00+09:00`);
  return Number.isNaN(ms) ? null : ms;
}
// KST 기준 요일(0=일 … 6=토).
function kstDow(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + 9 * 3600 * 1000).getUTCDay();
}
// 신청됨(actual) vs 신청 시점(deadline) → ontime/late.
function timingOf(actualIso: string | null, deadlineMs: number | null): ActCheckStatus {
  if (!actualIso) return "ontime"; // 신청됨이나 시각 정보 없음 → 정시로 간주
  const a = Date.parse(actualIso);
  if (Number.isNaN(a) || deadlineMs == null) return "ontime";
  return a <= deadlineMs ? "ontime" : "late";
}
function rate(active: number, checked: number): number {
  return active > 0 ? Math.round((checked / active) * 100) : 0;
}

// 카드 표시/상태 필드 단일 빌더 — 정규/변동·정보/경험 전부 동일 판정을 쓴다.
//   필요 시점(required)·실제 신청(actual)은 원본 timestamp(epoch ms)로만 비교(문자열 재비교 금지).
//   cardState 는 resolveActCardState(공용 함수) 로 서버에서 확정 → 서버/클라 시간대 판정 불일치 없음.
function buildActCardFields(o: {
  isActive: boolean;
  scheduledCheckAt: string | null; // 상태행 예약 검수시각(있으면 필요 시점 우선)
  derivedDate: string | null; // 없을 때 act check 요일에서 파생한 날짜(ISO date)
  checkTime: string | null; // act check_time("HH:mm[:ss]")
  applied: boolean; // 체크 신청 기록 존재(pending|completed)
  actualIso: string | null; // 실제 신청 시점(completed_at ?? requested_at)
  nowMs: number;
}): {
  cardState: ActCardState;
  requiredCheckedAt: string | null;
  actualCheckedAt: string | null;
  requiredLabel: string | null;
  actualLabel: string | null;
  scheduledLabel: string | null;
  checkStatus: ActCheckStatus;
} {
  const timeStr = hhmm(o.checkTime);

  // 필요 시점(required) — 원본 ISO·라벨·epoch ms.
  let requiredCheckedAt: string | null = null;
  let requiredLabel: string | null = null;
  let requiredMs: number | null = null;
  if (o.scheduledCheckAt) {
    requiredCheckedAt = o.scheduledCheckAt;
    requiredLabel = formatClubWeekdayTime(o.scheduledCheckAt);
    const ms = Date.parse(o.scheduledCheckAt);
    requiredMs = Number.isNaN(ms) ? null : ms;
  } else if (o.derivedDate) {
    const iso = timeStr ? `${o.derivedDate}T${timeStr}:00+09:00` : o.derivedDate;
    requiredCheckedAt = iso;
    requiredLabel = formatClubWeekdayTime(iso);
    requiredMs = deadlineMsKst(o.derivedDate, o.checkTime);
  }

  // 표시용 full 라벨(기존 scheduledLabel 의미 유지 = 필요 시점 full date-time).
  const scheduledLabel = o.scheduledCheckAt
    ? formatClubDateTime(o.scheduledCheckAt)
    : o.derivedDate
      ? `${formatClubDate(o.derivedDate)}${timeStr ? ` ${timeStr}` : ""}`
      : null;

  // 실제 신청 시점(actual).
  const actualCheckedAt = o.applied ? o.actualIso : null;
  const actualMsRaw = actualCheckedAt ? Date.parse(actualCheckedAt) : NaN;
  const actualMs = Number.isNaN(actualMsRaw) ? null : actualMsRaw;
  const actualLabel = actualCheckedAt ? formatClubDateTime(actualCheckedAt) : null;

  const checkStatus: ActCheckStatus = o.applied ? timingOf(o.actualIso, requiredMs) : null;
  const cardState = resolveActCardState({
    isActive: o.isActive,
    requiredCheckedAtMs: requiredMs,
    check: o.applied ? { actualCheckedAtMs: actualMs } : null,
    nowMs: o.nowMs,
  });

  return { cardState, requiredCheckedAt, actualCheckedAt, requiredLabel, actualLabel, scheduledLabel, checkStatus };
}

export async function loadTeamPartsInfoActCheckManagement(opts: {
  weekId: string;
  organization: OrganizationSlug;
  mode: ScopeMode;
}): Promise<ActCheckManagementData> {
  const { weekId, organization, mode } = opts;

  // 카드 pending/overdue 판정 기준 현재 시각 — 한 응답 내 모든 카드가 동일 now 를 쓴다(서버 확정).
  const nowMs = Date.now();

  // 0) 주차 시작일(신청 시점 파생용).
  let weekStart: string | null = null;
  {
    const { data } = await supabaseAdmin.from("weeks").select("start_date").eq("id", weekId).maybeSingle();
    weekStart = (data as { start_date: string | null } | null)?.start_date ?? null;
  }

  // 1) 오픈 확인 + 액트 체크(7) 라인급 선택(config.actCheck). open_confirmed=false → 아무 것도 가동 아님.
  //    라인급(체크) SoT = process_line_groups(hub, is_active). 액트는 line_group_id 로 직접 분류(이름매칭 없음).
  //    체크 기본값 = 전체 체크(§4 통일) — actCheck 없는 과거 확정 주차는 전 라인급 체크로 간주(읽기전용 표시만).
  const { config, openConfirmed } = await loadWeekOpeningConfig(weekId, organization);
  const actCfg = config?.actCheck ?? {};
  const infoChecked = (lgId: string | null): boolean => (lgId != null ? actCfg.info?.[lgId] ?? true : false);
  const clubChecked = (lgId: string | null): boolean => (lgId != null ? actCfg.club?.[lgId] ?? true : false);
  const expChecked = (teamId: string, lgId: string | null): boolean =>
    lgId != null ? actCfg.experience?.[teamId]?.[lgId] ?? true : false;
  const compChecked = config?.practicalCompetency?.checked === true;

  // 2) 라인급(체크) 카탈로그 = process_line_groups(hub, is_active). sort_order → created_at 순(register 동일).
  const loadLineGroups = async (hub: string): Promise<Array<{ id: string; name: string }>> => {
    const { data, error } = await supabaseAdmin
      .from("process_line_groups")
      .select("id,name,sort_order,created_at")
      .eq("hub", hub)
      .eq("is_active", true);
    if (error) { console.warn(`[act-check-management] process_line_groups(${hub}) unavailable:`, error.message); return []; }
    return ((data ?? []) as Array<{ id: string; name: string | null; sort_order: number | null; created_at: string | null }>)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || (a.created_at ?? "").localeCompare(b.created_at ?? ""))
      .map((r) => ({ id: r.id, name: r.name ?? r.id }));
  };
  const [infoLineGroups, expLineGroups, clubLineGroups, compLineGroups] = await Promise.all([
    loadLineGroups("info"), loadLineGroups("experience"), loadLineGroups("club"), loadLineGroups("competency"),
  ]);
  const activeLgIds = new Set<string>(
    [...infoLineGroups, ...expLineGroups, ...clubLineGroups, ...compLineGroups].map((g) => g.id),
  );

  // 3) 정규 액트 — hub∈ACT_HUBS·is_active·활성 라인급 소속만(비활성/미등록 라인그룹 액트 제외).
  const { data: actData, error: actErr } = await supabaseAdmin
    .from("process_acts")
    .select("id,line_group_id,hub,act_name,occur_dow,check_week,check_dow,check_time,check_target")
    .in("hub", ACT_HUBS as unknown as string[])
    .eq("is_active", true);
  if (actErr) throw new Error(actErr.message);
  const allActs = ((actData ?? []) as ActRow[]).filter((a) => a.line_group_id != null && activeLgIds.has(a.line_group_id));
  const infoActs = allActs.filter((a) => a.hub === "info");
  const expActs = allActs.filter((a) => a.hub === "experience");
  const compActs = allActs.filter((a) => a.hub === "competency");
  const clubActs = allActs.filter((a) => a.hub === "club");

  // 4) 체크 상태행. info/competency/club = act_id 단위(team_id null), experience = (act_id, team_id) 단위.
  const statusByAct = new Map<string, StatusRow>();
  const appliedActIds = new Set<string>();
  const expStatusByActTeam = new Map<string, StatusRow>();
  const appliedExpSet = new Set<string>();
  const preferApplied = (prev: StatusRow | undefined, applied: boolean) =>
    !prev || (applied && !(prev.status === "pending" || prev.status === "completed"));
  {
    const { data, error } = await supabaseAdmin
      .from("process_check_statuses")
      .select("act_id,hub,team_id,status,requested_at,completed_at,scheduled_check_at,requested_by")
      .eq("organization_slug", organization)
      .in("hub", ACT_HUBS as unknown as string[])
      .eq("week_id", weekId);
    if (error) {
      console.warn("[act-check-management] check_statuses read unavailable:", error.message);
    } else {
      for (const r of (data ?? []) as Array<StatusRow & { hub: string | null; team_id: string | null }>) {
        if (!r.act_id) continue;
        const applied = r.status === "pending" || r.status === "completed";
        if (r.hub === "experience" && r.team_id) {
          const key = `${r.act_id}::${r.team_id}`;
          if (applied) appliedExpSet.add(key);
          if (preferApplied(expStatusByActTeam.get(key), applied)) expStatusByActTeam.set(key, r);
        } else {
          if (applied) appliedActIds.add(r.act_id);
          if (preferApplied(statusByAct.get(r.act_id), applied)) statusByAct.set(r.act_id, r);
        }
      }
    }
  }

  // 5) 변동 액트 원본 로드(org, week, scope_mode=mode) — 담당자 해석 후 카드화(7).
  //    ⚠ origin='emergency_rest'(긴급 휴식 Po.C 지급용 내부 액트)는 액트가 아니므로 활동 관리
  //      목록·집계(변동/전체/체크율)에서 제외한다 — 변동 액트 보드(adminProcessIrregularData)와 동일 정책.
  //      휴식 포인트는 process_point_awards 원장(Detail Log·주간 포인트·snapshot)으로만 반영되며,
  //      제외는 title 문자열이 아니라 origin 필드로 판정한다. origin 컬럼 미적용(42703) 환경에선
  //      필터 없이 조회(그 땐 긴급 액트 자체가 없다).
  type IrrRow = {
    id: string; act_name: string | null; applicant_admin_id: string | null; applicant_admin_name: string | null;
    scheduled_check_at: string | null; completed_at: string | null; created_at: string | null; status: string | null;
  };
  let irr: IrrRow[] = [];
  {
    const IRR_COLS =
      "id,act_name,applicant_admin_id,applicant_admin_name,scheduled_check_at,completed_at,created_at,status";
    const runIrrQuery = (cols: string) =>
      supabaseAdmin
        .from("process_irregular_acts")
        .select(cols)
        .eq("organization_slug", organization)
        .eq("week_id", weekId)
        .eq("scope_mode", mode);
    let hasOrigin = true;
    let res = await runIrrQuery(IRR_COLS + ",origin");
    if (res.error && res.error.code === "42703") {
      hasOrigin = false;
      res = await runIrrQuery(IRR_COLS);
    }
    if (res.error) console.warn("[act-check-management] irregular acts read unavailable:", res.error.message);
    else {
      const rawRows = (res.data ?? []) as unknown as Array<IrrRow & { origin?: string | null }>;
      irr = hasOrigin ? rawRows.filter((r) => r.origin !== "emergency_rest") : rawRows;
    }
  }
  const variableCount = irr.length;

  // 6) 담당자 이름 + 역할 해석 — 정규(requested_by) ∪ 변동(applicant_admin_id).
  //    역할 = memberStatusLabel(user_profiles.role, membership_level)(앰배서더/팀장/파트장/에이전트/…).
  //    운영자(등급 미상 admin)면 "관리자". 담당자명 뒤에 항상 (역할)을 붙인다.
  const requesterIds = Array.from(
    new Set(
      [
        ...Array.from(statusByAct.values()).map((s) => s.requested_by),
        ...Array.from(expStatusByActTeam.values()).map((s) => s.requested_by),
        ...irr.map((r) => r.applicant_admin_id),
      ].filter((v): v is string => !!v),
    ),
  );
  const requesterInfoById = new Map<string, { name: string; role: string }>();
  if (requesterIds.length) {
    const [{ data: profs }, { data: mems }, { data: admins }] = await Promise.all([
      supabaseAdmin.from("user_profiles").select("user_id,display_name,role").in("user_id", requesterIds),
      supabaseAdmin.from("user_memberships").select("user_id,membership_level,is_current").in("user_id", requesterIds),
      supabaseAdmin.from("admin_users").select("id,email").in("id", requesterIds),
    ]);
    const nameById = new Map<string, string>();
    const roleRawById = new Map<string, string | null>();
    const levelById = new Map<string, string | null>();
    const isAdmin = new Set<string>();
    for (const p of (profs ?? []) as Array<{ user_id: string; display_name: string | null; role: string | null }>) {
      if (p.display_name?.trim()) nameById.set(p.user_id, p.display_name.trim());
      roleRawById.set(p.user_id, p.role ?? null);
    }
    for (const m of (mems ?? []) as Array<{ user_id: string; membership_level: string | null; is_current: boolean | null }>) {
      if (m.is_current) levelById.set(m.user_id, m.membership_level ?? null);
    }
    for (const a of (admins ?? []) as Array<{ id: string; email: string | null }>) {
      isAdmin.add(a.id);
      if (!nameById.has(a.id) && a.email) nameById.set(a.id, a.email);
    }
    for (const id of requesterIds) {
      const name = nameById.get(id);
      if (!name) continue;
      let role = memberStatusLabel(roleRawById.get(id) ?? null, levelById.get(id) ?? null);
      if (role === "크루" && isAdmin.has(id)) role = "관리자";
      requesterInfoById.set(id, { name, role });
    }
  }
  const regularRequesterLabel = (id: string | null): string | null => {
    const info = id ? requesterInfoById.get(id) : null;
    return info ? `${info.name} 님(${info.role})` : null;
  };

  // 7) 변동 액트 → 요일별 카드(담당자명(역할) 포함).
  const variableActsByDay = emptyByDay<ActCheckVariableActDto>();
  for (const r of irr) {
    const anchor = r.scheduled_check_at ?? r.created_at;
    const dow = kstDow(anchor);
    const key: DayKey | null = dow != null && dow >= 0 && dow <= 6 ? DOW_KEY[dow] : null;
    if (!key) continue;
    const info = r.applicant_admin_id ? requesterInfoById.get(r.applicant_admin_id) : null;
    const name = r.applicant_admin_name?.trim() || info?.name || null;
    const role = info?.role ?? "관리자"; // 변동 액트 신청자 = 운영진(admin) → 기본 "관리자".
    // 변동 액트: 항상 가동. 필요 시점 = scheduled_check_at, 실제 = completed_at(있으면 신청 기록).
    const fields = buildActCardFields({
      isActive: true,
      scheduledCheckAt: r.scheduled_check_at ?? null,
      derivedDate: null,
      checkTime: null,
      applied: r.completed_at != null,
      actualIso: r.completed_at ?? null,
      nowMs,
    });
    variableActsByDay[key].push({
      id: r.id,
      actName: r.act_name ?? "(변동 액트)",
      requesterLabel: name ? `${name} 님(${role})` : null,
      ...fields,
    });
  }

  // 7) 정규 액트 → 카드 필드 계산. info/competency/club 전용(experience 는 expCardOf 별도).
  //    가동 = openConfirmed && 라인급 체크(info=infoChecked·competency=compChecked·club=clubChecked).
  const cardOf = (a: ActRow): ActCheckActDto => {
    const isActive = openConfirmed && (
      a.hub === "info" ? infoChecked(a.line_group_id)
      : a.hub === "competency" ? compChecked
      : a.hub === "club" ? clubChecked(a.line_group_id)
      : false
    );
    const st = statusByAct.get(a.id) ?? null;
    const applied = st != null && (st.status === "pending" || st.status === "completed");
    // 필요 시점: 상태행 scheduled_check_at 우선, 없으면 act check 요일/시각(주차 기준 파생).
    const derivedDate = dateForDow(weekStart, a.check_dow, a.check_week);
    const fields = buildActCardFields({
      isActive,
      scheduledCheckAt: st?.scheduled_check_at ?? null,
      derivedDate,
      checkTime: a.check_time,
      applied,
      actualIso: st?.completed_at ?? st?.requested_at ?? null,
      nowMs,
    });
    return {
      actId: a.id,
      actName: a.act_name,
      isActiveThisWeek: isActive,
      isChecked: applied,
      requesterLabel: regularRequesterLabel(st?.requested_by ?? null),
      ...fields,
    };
  };

  // 8) 실무 정보 라인급별 목록 — process_line_groups(hub=info). 액트는 line_group_id 로 직접 매칭.
  const lines: ActCheckInfoLineDto[] = infoLineGroups.map((lg) => {
    const byDay = emptyByDay<ActCheckActDto>();
    for (const a of infoActs) {
      if (a.line_group_id !== lg.id) continue;
      const d = a.occur_dow;
      const key: DayKey | null = d != null && d >= 0 && d <= 6 ? DOW_KEY[d] : null;
      if (!key) continue;
      byDay[key].push(cardOf(a));
    }
    return { lineId: lg.id, lineName: lg.name, isOpenThisWeek: openConfirmed && infoChecked(lg.id), regularActsByDay: byDay };
  });

  // 8b) 실무 경험 — 팀 × 라인급(process_line_groups hub=experience) × 요일. 가동 = openConfirmed && 팀별 라인급 체크.
  //   체크 = (act, team) 상태행 신청됨. 변동 액트는 팀 귀속 불가 → 경험 팀/허브 변동=0.
  const teams = await listTeams(organization, mode);
  const expCardOf = (a: ActRow, teamId: string, lineOpen: boolean): ActCheckActDto => {
    const st = expStatusByActTeam.get(`${a.id}::${teamId}`) ?? null;
    const applied = st != null && (st.status === "pending" || st.status === "completed");
    const derivedDate = dateForDow(weekStart, a.check_dow, a.check_week);
    const fields = buildActCardFields({
      isActive: lineOpen,
      scheduledCheckAt: st?.scheduled_check_at ?? null,
      derivedDate,
      checkTime: a.check_time,
      applied,
      actualIso: st?.completed_at ?? st?.requested_at ?? null,
      nowMs,
    });
    return {
      actId: a.id, actName: a.act_name, isActiveThisWeek: lineOpen, isChecked: applied,
      requesterLabel: regularRequesterLabel(st?.requested_by ?? null),
      ...fields,
    };
  };
  const expTeams: ActCheckHubTeam[] = teams.map((t) => {
    const teamLines: ActCheckInfoLineDto[] = expLineGroups.map((lg) => {
      const lineOpen = openConfirmed && expChecked(t.id, lg.id);
      const byDay = emptyByDay<ActCheckActDto>();
      for (const a of expActs) {
        if (a.line_group_id !== lg.id) continue;
        const d = a.occur_dow;
        const key: DayKey | null = d != null && d >= 0 && d <= 6 ? DOW_KEY[d] : null;
        if (!key) continue;
        byDay[key].push(expCardOf(a, t.id, lineOpen));
      }
      return { lineId: lg.id, lineName: lg.name, isOpenThisWeek: lineOpen, regularActsByDay: byDay };
    });
    const active = expActs.filter((a) => a.check_target === "check" && openConfirmed && expChecked(t.id, a.line_group_id));
    const activeActs = active.length;
    const checkedActs = active.filter((a) => appliedExpSet.has(`${a.id}::${t.id}`)).length;
    return {
      teamId: t.id,
      teamName: t.teamName,
      summary: {
        totalActs: expActs.length,
        activeActs,
        checkedActs,
        uncheckedActs: activeActs - checkedActs,
        variableActs: 0,
        actCheckRate: rate(activeActs, checkedActs),
      },
      lines: teamLines,
      variableActsByDay: emptyByDay<ActCheckVariableActDto>(),
    };
  });
  // 허브 요약 — distinct(팀 합 아님). 가동 = openConfirmed && 어느 팀이든 라인급 체크. 체크 = 어느 팀이든 신청됨.
  const expHubActive = expActs.filter(
    (a) => a.check_target === "check" && openConfirmed && teams.some((t) => expChecked(t.id, a.line_group_id)),
  );
  const expHubChecked = expHubActive.filter((a) => teams.some((t) => appliedExpSet.has(`${a.id}::${t.id}`)));
  const expHubSummary: ActCheckSummary = {
    totalActs: expActs.length,
    activeActs: expHubActive.length,
    checkedActs: expHubChecked.length,
    uncheckedActs: expHubActive.length - expHubChecked.length,
    variableActs: 0,
    actCheckRate: rate(expHubActive.length, expHubChecked.length),
  };

  // 8c) 실무 역량 — process_line_groups(hub=competency). 가동/체크 = 공유 게이트(compChecked, (5) 정상 진행).
  //   변동 액트는 info 허브에 귀속 → 역량 변동=0(경험과 동일).
  const compLines: ActCheckInfoLineDto[] = compLineGroups.map((lg) => {
    const byDay = emptyByDay<ActCheckActDto>();
    for (const a of compActs) {
      if (a.line_group_id !== lg.id) continue;
      const d = a.occur_dow;
      const key: DayKey | null = d != null && d >= 0 && d <= 6 ? DOW_KEY[d] : null;
      if (!key) continue;
      byDay[key].push(cardOf(a));
    }
    return { lineId: lg.id, lineName: lg.name, isOpenThisWeek: openConfirmed && compChecked, regularActsByDay: byDay };
  });

  // 8d) 클럽 총괄 — process_line_groups(hub=club) 활성 전체(고정 UUID allowlist 제거·프로세스 등록 추가분 자동 노출).
  //   변동 액트는 info 허브 귀속 → 클럽 총괄 변동=0(경험/역량과 동일).
  const clubLines: ActCheckInfoLineDto[] = clubLineGroups.map((lg) => {
    const byDay = emptyByDay<ActCheckActDto>();
    for (const a of clubActs) {
      if (a.line_group_id !== lg.id) continue;
      const d = a.occur_dow;
      const key: DayKey | null = d != null && d >= 0 && d <= 6 ? DOW_KEY[d] : null;
      if (!key) continue;
      byDay[key].push(cardOf(a));
    }
    return { lineId: lg.id, lineName: lg.name, isOpenThisWeek: openConfirmed && clubChecked(lg.id), regularActsByDay: byDay };
  });

  // 9) 집계. 가동 = check_target='check' && openConfirmed && 라인급 체크. 허브별 distinct(1회) 판정.
  const isActActive = (a: ActRow): boolean => {
    if (!openConfirmed) return false;
    if (a.hub === "info") return infoChecked(a.line_group_id);
    if (a.hub === "experience") return teams.some((t) => expChecked(t.id, a.line_group_id));
    if (a.hub === "competency") return compChecked;
    if (a.hub === "club") return clubChecked(a.line_group_id);
    return false;
  };
  const isActChecked = (a: ActRow): boolean =>
    a.hub === "experience" ? teams.some((t) => appliedExpSet.has(`${a.id}::${t.id}`)) : appliedActIds.has(a.id);
  // withVariable=true 는 변동 액트(info 귀속)를 total/variable 에 포함 — 주차 전체·실무 정보에만 적용.
  const summarize = (scope: ActRow[], withVariable: boolean): ActCheckSummary => {
    const active = scope.filter((a) => a.check_target === "check" && isActActive(a));
    const activeActs = active.length;
    const checkedActs = active.filter(isActChecked).length;
    return {
      totalActs: scope.length + (withVariable ? variableCount : 0),
      activeActs,
      checkedActs,
      uncheckedActs: activeActs - checkedActs,
      variableActs: withVariable ? variableCount : 0,
      actCheckRate: rate(activeActs, checkedActs),
    };
  };

  return {
    weekId,
    club: organization,
    // 주차 전체 = 클럽 총괄 + 정보 + 경험 + 역량 정규 액트 + 변동(info 귀속).
    summary: summarize(allActs, true),
    clubOverall: {
      summary: summarize(clubActs, false),
      lines: clubLines,
      variableActsByDay: emptyByDay<ActCheckVariableActDto>(),
    },
    practicalInfo: {
      summary: summarize(infoActs, true),
      lines,
      variableActsByDay,
    },
    practicalExperience: {
      summary: expHubSummary,
      teams: expTeams,
    },
    practicalCompetency: {
      summary: summarize(compActs, false),
      lines: compLines,
      variableActsByDay: emptyByDay<ActCheckVariableActDto>(),
    },
  };
}

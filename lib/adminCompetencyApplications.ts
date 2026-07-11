// 실무 역량 [라인 개설] 신청/승인 명단 — 데이터 레이어 (cluster4_competency_applications).
//
// 고객 신청(source='customer', 추후 고객 UI) + 운영자 수동 추가(source='manual')를 통합 관리한다.
// 표시값(크루명/팀/학교)은 읽기 시점에 loadCrewRecords 로 resolve(번호·이름 변경에도 최신값).
//
// ⚠ 어드민 승인 메타데이터. 고객 반영은 [개설 완료](adminCompetencyLineOpening)가 cluster4_lines 로 수행.
//    테이블 미적용(수동 마이그 전)이면 list/summary 는 빈/0 으로 graceful 동작.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { QA_HIDE_REAL_USERS } from "@/lib/qaFixedScope";
import { loadCrewRecords } from "@/lib/cluster4CafeLineMatch";
import { listCrewsForTargetSelection } from "@/lib/adminExperienceLineData";
import { invalidateWeeklyCardsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";
import { filterGrowthStoppedUserIds } from "@/lib/cluster4GrowthStopPolicy";
import {
  assertUserIdsInScope,
  resolveUserScope,
} from "@/lib/userScope";
import type { ScopeMode } from "@/lib/userScopeShared";
import type { OrganizationSlug } from "@/lib/organizations";

export type CompetencyApplicationDto = {
  id: string;
  targetUserId: string;
  crewNo: number | null;
  crewCode: string | null;
  displayName: string;
  teamName: string | null;
  schoolName: string | null;
  // "036003-1254053 - 홍길동 - 콘텐츠 팀 - 한국대" (식별자 = 크루 코드, 미생성이면 "-")
  crewLabel: string;
  competencyLineMasterId: string | null;
  lineCode: string | null;
  lineName: string;
  submissionLink: string | null;
  cafeChecked: boolean;
  approvalChecked: boolean;
  rejectionReason: string | null;
  source: "customer" | "manual";
  resolution: "pending" | "opened" | "rejected";
  createdAt: string;
};

export type CompetencyApplicationSummary = {
  activeCrews: number; // 활동 크루(휴식 제외, 신청과 무관)
  appliedCrews: number; // 신청 크루(distinct)
  openedCrews: number; // 개설 크루(resolution=opened, 초기 0)
  rejectedCrews: number; // 반려 크루(resolution=rejected, 초기 0)
  appliedLines: number; // 신청 라인(distinct)
  openedLines: number; // 개설 라인(resolution=opened distinct, 초기 0)
  enhanceSuccess: number; // 강화 성공 = 활동 크루 중 개설(opened) 대상
  enhanceFail: number; // 강화 실패 = 활동 크루 − 강화 성공 (반려 + 미신청)
};

const SELECT =
  "id,target_user_id,competency_line_master_id,line_code,line_name,submission_link,cafe_checked,approval_checked,rejection_reason,source,resolution,opened_line_id,created_at";

type AppRow = {
  id: string;
  target_user_id: string;
  competency_line_master_id: string | null;
  line_code: string | null;
  line_name: string;
  submission_link: string | null;
  cafe_checked: boolean;
  approval_checked: boolean;
  rejection_reason: string | null;
  source: "customer" | "manual";
  resolution: "pending" | "opened" | "rejected";
  // 개설로 생성된 라인 id (resolution='opened' 일 때). 외부 정리 등으로 라인이 삭제되면 이 값은
  //   남지만 실제 cluster4_lines row 는 없을 수 있다(고아) → openApprovedApplications 가 self-heal.
  opened_line_id: string | null;
  created_at: string;
};

function crewLabel(r: {
  crewCode: string | null;
  name: string;
  teamName: string | null;
  schoolName: string | null;
}): string {
  // 식별자 = 크루 코드(13자리). 미생성이면 "-" — 4자리 crew_no 로 폴백하지 않는다.
  const code = r.crewCode?.trim() || "-";
  return [code, r.name || "-", r.teamName ?? "-", r.schoolName ?? "-"].join(" - ");
}

// best-effort: 테이블 미적용(마이그 전) 등 실패 시 빈 배열.
// line_code 컬럼 미적용(2026-06-12 마이그 전)이면 line_code 없이 재조회(graceful).
async function loadApplicationRows(
  org: OrganizationSlug,
  weekId: string,
): Promise<AppRow[]> {
  const run = (sel: string) =>
    supabaseAdmin
      .from("cluster4_competency_applications")
      .select(sel)
      .eq("organization_slug", org)
      .eq("week_id", weekId)
      .order("created_at", { ascending: true });
  try {
    let { data, error } = await run(SELECT);
    if (error && /line_code/.test(error.message)) {
      ({ data, error } = await run(SELECT.replace(",line_code", "")));
    }
    if (error) throw error;
    return ((data ?? []) as unknown as AppRow[]).map((r) => ({ ...r, line_code: r.line_code ?? null }));
  } catch (e) {
    console.warn(
      "[competency applications] load skipped (table missing?):",
      e instanceof Error ? e.message : e,
    );
    return [];
  }
}

const lineKey = (r: { competency_line_master_id: string | null; line_name: string }) =>
  r.competency_line_master_id ?? `name:${r.line_name.trim()}`;

// 크루 레코드(userId→record) 맵. 표시값(크루명/팀/학교/코드) resolve 용 — org 스코프면 그 조직 크루만.
type CrewRecordMap = Map<string, Awaited<ReturnType<typeof loadCrewRecords>>[number]>;

// ── 순수 빌더(공통) — 이미 로드한 rows/records/activeList 로만 DTO 를 만든다(추가 DB 호출 없음) ──
//   list/summary/results 가 같은 원천을 3중 조회하던 것을 번들에서 1회 로드 후 이 빌더들로 합류시킨다.
function buildApplicationDtos(
  rows: AppRow[],
  byUser: CrewRecordMap,
): CompetencyApplicationDto[] {
  return rows.map((r) => {
    const rec = byUser.get(r.target_user_id) ?? null;
    return {
      id: r.id,
      targetUserId: r.target_user_id,
      crewNo: rec?.crewNo ?? null,
      crewCode: rec?.crewCode ?? null,
      displayName: rec?.name ?? "(이름 없음)",
      teamName: rec?.teamName ?? null,
      schoolName: rec?.schoolName ?? null,
      crewLabel: rec
        ? crewLabel(rec)
        : ["-", "(이름 없음)", "-", "-"].join(" - "),
      competencyLineMasterId: r.competency_line_master_id,
      lineCode: r.line_code,
      lineName: r.line_name,
      submissionLink: r.submission_link,
      cafeChecked: r.cafe_checked,
      approvalChecked: r.approval_checked,
      rejectionReason: r.rejection_reason,
      source: r.source,
      resolution: r.resolution,
      createdAt: r.created_at,
    };
  });
}

export async function listCompetencyApplications(
  org: OrganizationSlug,
  weekId: string,
): Promise<CompetencyApplicationDto[]> {
  const rows = await loadApplicationRows(org, weekId);
  if (rows.length === 0) return [];
  // org 스코프 — rows 는 organization_slug=org 로 필터되어 target_user_id 전원이 이 조직 소속.
  //   전 org 스캔(loadCrewRecords()) 대신 조직 크루만 로드해 불필요한 전체 조회를 제거한다.
  const records = await loadCrewRecords(org);
  const byUser: CrewRecordMap = new Map(records.map((r) => [r.userId, r]));
  return buildApplicationDtos(rows, byUser);
}

// 신청 명단 기반 개설(resolution='opened')이 1건이라도 있으면 true — 상태창 opened·개설 취소 enable 에 사용.
export async function hasOpenedApplications(
  org: OrganizationSlug,
  weekId: string,
): Promise<boolean> {
  try {
    const { count, error } = await supabaseAdmin
      .from("cluster4_competency_applications")
      .select("id", { count: "exact", head: true })
      .eq("organization_slug", org)
      .eq("week_id", weekId)
      .eq("resolution", "opened");
    if (error) throw error;
    return (count ?? 0) > 0;
  } catch {
    return false;
  }
}

export async function getCompetencyApplicationSummary(
  org: OrganizationSlug,
  weekId: string,
  mode: ScopeMode = "operating",
): Promise<CompetencyApplicationSummary> {
  const [rows, activeList] = await Promise.all([
    loadApplicationRows(org, weekId),
    // 활동 크루 모집단 = QA_HIDE_REAL_USERS 스위치 기준(QA=테스트 유저 / 종료 후=실사용자) — listCrews 가 스코프 적용.
    listCrewsForTargetSelection({
      organization: org,
      status: "active",
      mode,
    }).catch(() => []),
  ]);
  return buildSummary(rows, activeList);
}

// 순수 요약 빌더 — 이미 로드한 rows/activeList 로만 계산(추가 DB 호출 없음).
function buildSummary(
  rows: AppRow[],
  activeList: Array<{ userId: string }>,
): CompetencyApplicationSummary {
  // 활동 크루 = 휴식 제외 + 현재 모드 모집단. 강화 결과 분모 = 활동 크루(미신청 포함).
  const activeIds = new Set(activeList.map((c) => c.userId));
  const activeCrews = activeIds.size;
  const applied = new Set<string>();
  const opened = new Set<string>();
  const rejected = new Set<string>();
  const appliedLines = new Set<string>();
  const openedLines = new Set<string>();
  for (const r of rows) {
    applied.add(r.target_user_id);
    appliedLines.add(lineKey(r));
    if (r.resolution === "opened") {
      opened.add(r.target_user_id);
      openedLines.add(lineKey(r));
    } else if (r.resolution === "rejected") {
      rejected.add(r.target_user_id);
    }
  }
  // 강화 성공 = 활동 크루 중 개설(opened) 대상. 강화 실패 = 활동 크루 − 성공 (반려 + 미신청 포함).
  //   ⚠ 미신청 크루도 분모(활동 크루)에 포함 → 강화 실패로 계산(실무 역량 허브 정책).
  let enhanceSuccess = 0;
  for (const uid of opened) if (activeIds.has(uid)) enhanceSuccess++;
  const enhanceFail = Math.max(0, activeCrews - enhanceSuccess);
  return {
    activeCrews,
    appliedCrews: applied.size,
    openedCrews: opened.size,
    rejectedCrews: rejected.size,
    appliedLines: appliedLines.size,
    openedLines: openedLines.size,
    enhanceSuccess,
    enhanceFail,
  };
}

// ── [라인 관리] 크루별 라인 개설 결과 표 ─────────────────────────────────────
// 집계 카드와 동일 source(loadApplicationRows + listCrewsForTargetSelection + test 제외 + loadCrewRecords).
// 활동 대상 크루 전원(미신청 포함)을 행으로 만든다.
//   라인 결과 정책: 승인(opened)·강화 대기(pending) = 강화 성공 / 반려(rejected)·미신청 = 강화 실패.
//   ⚠ 집계 카드의 enhanceSuccess(=opened 만)와 달리, 이 표는 강화 대기(pending)도 강화 성공으로 표시한다
//     (운영 화면 정책 — 신청·승인 진행 중 크루를 성공으로 미리 노출). 분모/source 는 동일.
export type CompetencyLineResultDto = {
  userId: string;
  crewNo: number | null;
  crewCode: string | null;
  displayName: string;
  teamName: string | null;
  schoolName: string | null;
  // 신청·개설 대상 라인명. 미신청이면 null.
  progressLine: string | null;
  result: "success" | "fail"; // 강화 성공 / 강화 실패
  appliedAt: string | null; // 신청 시간(고객 신청 또는 수동 추가 시각). 미신청이면 null.
  applied: boolean; // 신청 데이터 보유(정렬: 신청 크루 먼저)
};

export async function getCompetencyLineResults(
  org: OrganizationSlug,
  weekId: string,
  mode: ScopeMode = "operating",
): Promise<CompetencyLineResultDto[]> {
  const [rows, activeList, records] = await Promise.all([
    loadApplicationRows(org, weekId),
    // 활동 대상 크루 모집단 = 현재 스코프(집계 카드 분모와 동일 source).
    listCrewsForTargetSelection({
      organization: org,
      status: "active",
      mode,
    }).catch(() => []),
    // org 스코프 — 활동 크루/신청자 전원이 이 조직 소속. 전 org 스캔 대신 조직 크루만 로드.
    loadCrewRecords(org).catch(() => []),
  ]);
  const byUser: CrewRecordMap = new Map(records.map((r) => [r.userId, r]));
  return buildResults(rows, activeList, byUser);
}

// 순수 결과 빌더 — 이미 로드한 rows/activeList/records 로만 계산(추가 DB 호출 없음).
function buildResults(
  rows: AppRow[],
  activeList: Array<{
    userId: string;
    crewNo?: number | null;
    displayName?: string | null;
    teamName?: string | null;
  }>,
  byUser: CrewRecordMap,
): CompetencyLineResultDto[] {
  // 활동 대상 크루 = 휴식 제외 + 현재 모드 모집단 (집계 카드 분모와 동일).
  const activeCrew = activeList;

  const appsByUser = new Map<string, AppRow[]>();
  for (const r of rows) {
    const arr = appsByUser.get(r.target_user_id);
    if (arr) arr.push(r);
    else appsByUser.set(r.target_user_id, [r]);
  }

  const results: CompetencyLineResultDto[] = activeCrew.map((c) => {
    const rec = byUser.get(c.userId) ?? null;
    const apps = appsByUser.get(c.userId) ?? [];
    let progressLine: string | null = null;
    let result: "success" | "fail" = "fail";
    let appliedAt: string | null = null;
    if (apps.length > 0) {
      // 성공 = opened 또는 pending(강화 대기). 둘 다 없으면(전부 rejected) 실패.
      const successApp =
        apps.find((a) => a.resolution === "opened") ??
        apps.find((a) => a.resolution === "pending");
      const rep = successApp ?? apps[0];
      progressLine = rep.line_name;
      appliedAt = rep.created_at;
      result = successApp ? "success" : "fail";
    }
    return {
      userId: c.userId,
      crewNo: rec?.crewNo ?? c.crewNo ?? null,
      crewCode: rec?.crewCode ?? null,
      displayName: rec?.name ?? c.displayName ?? "(이름 없음)",
      teamName: rec?.teamName ?? c.teamName ?? null,
      schoolName: rec?.schoolName ?? null,
      progressLine,
      result,
      appliedAt,
      applied: apps.length > 0,
    };
  });

  // 정렬: 신청 데이터 있는 크루 먼저 → 미신청 뒤. 같은 그룹 내 crewNo(없으면 뒤)·이름순.
  results.sort((a, b) => {
    if (a.applied !== b.applied) return a.applied ? -1 : 1;
    const an = a.crewNo ?? Number.POSITIVE_INFINITY;
    const bn = b.crewNo ?? Number.POSITIVE_INFINITY;
    if (an !== bn) return an - bn;
    return a.displayName.localeCompare(b.displayName, "ko");
  });
  return results;
}

// ── 라인 개설 화면 단일 조회(번들) ─────────────────────────────────────────────
// GET /api/admin/cluster4/competency/applications 는 applications/summary/results 를 함께 반환한다.
// 세 값은 모두 같은 원천(신청 rows + 활동 크루 명부 + 크루 레코드)에서 나오므로, 예전처럼 3함수를
// 각각 호출하면 loadApplicationRows ×3 · listCrewsForTargetSelection ×2 · loadCrewRecords ×2(전 org 스캔)
// 로 동일 데이터를 동시 중복 조회했다(커넥션 포화 → fetch 실패 · 지연). 여기서 각 원천을 1회만 로드해
// 순수 빌더로 합류시킨다 — 운영/테스트 동일 경로·동일 DTO(입력 mode 만 다름), 결과는 3함수 개별 호출과 동일.
export async function getCompetencyApplicationsBundle(
  org: OrganizationSlug,
  weekId: string,
  mode: ScopeMode = "operating",
): Promise<{
  applications: CompetencyApplicationDto[];
  summary: CompetencyApplicationSummary;
  results: CompetencyLineResultDto[];
}> {
  const [rows, activeList, records] = await Promise.all([
    loadApplicationRows(org, weekId),
    // 활동 크루 모집단 = QA_HIDE_REAL_USERS 스위치 기준(operating=실사용자 / test=test_user_markers).
    listCrewsForTargetSelection({ organization: org, status: "active", mode }).catch(() => []),
    // org 스코프 — rows(organization_slug=org)·activeList 모두 이 조직 소속이라 조직 크루만 로드하면 충분.
    loadCrewRecords(org).catch(() => []),
  ]);
  const byUser: CrewRecordMap = new Map(records.map((r) => [r.userId, r]));
  return {
    applications: rows.length === 0 ? [] : buildApplicationDtos(rows, byUser),
    summary: buildSummary(rows, activeList),
    results: buildResults(rows, activeList, byUser),
  };
}

// 운영자 수동 추가(고객 신청 누락 보완) — source='manual', 라인명/제출 링크 직접 입력.
export async function addManualCompetencyApplication(input: {
  org: OrganizationSlug;
  weekId: string;
  targetUserId: string;
  lineName: string;
  competencyLineMasterId?: string | null;
  lineCode?: string | null;
  submissionLink?: string | null;
  adminId: string | null;
}): Promise<{ id: string }> {
  const payload: Record<string, unknown> = {
    organization_slug: input.org,
    week_id: input.weekId,
    target_user_id: input.targetUserId,
    competency_line_master_id: input.competencyLineMasterId ?? null,
    line_code: input.lineCode?.trim() || null,
    line_name: input.lineName,
    submission_link: input.submissionLink?.trim() || null,
    source: "manual",
    created_by: input.adminId,
  };
  let { data, error } = await supabaseAdmin
    .from("cluster4_competency_applications")
    .insert(payload)
    .select("id")
    .single();
  // line_code 컬럼 미적용(2026-06-12 마이그 전)이면 line_code 없이 재시도(graceful).
  if (error && /line_code/.test(error.message)) {
    const { line_code, ...rest } = payload;
    void line_code;
    ({ data, error } = await supabaseAdmin
      .from("cluster4_competency_applications")
      .insert(rest)
      .select("id")
      .single());
  }
  if (error) throw Object.assign(new Error(error.message), { status: 500 });
  return { id: (data as { id: string }).id };
}

// ── 개설 완료/취소 고객 반영 (cluster4_lines per-crew) ──
// 개설 완료: approval_checked=true 신청 → 크루별 라인 1개(output_link_1=공통, output_link_2=제출링크)
//   + target 생성, resolution='opened'. approval_checked=false → resolution='rejected'.
// 개설 취소: opened 라인/타깃 삭제 + resolution='pending' 복귀.
// ⚠ snapshot 은 호출부(adminCompetencyLineOpening)가 markStale 위임. 본 함수는 라인 CRUD + resolution 만.

const DAY_MS = 86_400_000;

async function loadWeekStart(weekId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("weeks")
    .select("start_date")
    .eq("id", weekId)
    .maybeSingle();
  return (data as { start_date: string } | null)?.start_date ?? null;
}

// competency-lines POST 와 동일한 KST 기준 기입 기간(open=주 시작 00:00 KST, close=Wed 22:00 KST).
function deriveWindow(weekStartIso: string): { opensAt: string; closesAt: string } {
  const ms = Date.UTC(
    +weekStartIso.slice(0, 4),
    +weekStartIso.slice(5, 7) - 1,
    +weekStartIso.slice(8, 10),
  );
  const wed = ms + 2 * DAY_MS;
  return {
    opensAt: new Date(ms - 9 * 3600_000).toISOString(),
    closesAt: new Date(wed + 22 * 3600_000 - 9 * 3600_000).toISOString(),
  };
}

export type ApprovalReflectResult = {
  openedCrews: number;
  openedLines: number;
  rejectedCrews: number;
  affectedUserIds: string[];
  openedLineIds: string[];
};

// 라인 타깃 생성 전 사전 가드(write 0) — 승인 신청 대상 전원이 현재 모드 모집단에 부합하는지 검증.
//   openCompetencyHub 가 is_active 토글 등 어떤 write 보다 먼저 호출해 부분 반영을 막는다(422 on mix).
export async function assertApprovedApplicationsInScope(
  org: OrganizationSlug,
  weekId: string,
  mode: ScopeMode = "operating",
): Promise<void> {
  const rows = await loadApplicationRows(org, weekId);
  const approvedTargetIds = rows
    .filter((r) => r.resolution !== "opened" && r.approval_checked)
    .map((r) => r.target_user_id);
  if (approvedTargetIds.length === 0) return;
  const scope = await resolveUserScope(mode, org);
  assertUserIdsInScope(scope, approvedTargetIds);
}

export async function openApprovedApplications(input: {
  org: OrganizationSlug;
  weekId: string;
  outputLink1: string | null;
  description: string | null;
  adminId: string | null;
  // 모집단(QA_HIDE_REAL_USERS 기준) — 라인 타깃(cluster4_line_targets) 생성 직전 fail-closed 가드.
  mode?: ScopeMode;
}): Promise<ApprovalReflectResult> {
  const rows = await loadApplicationRows(input.org, input.weekId);
  // 신규(미개설) 신청 — 아직 opened 아님.
  const fresh = rows.filter((r) => r.resolution !== "opened");
  // self-heal: resolution='opened' 인데 실제 라인 row 가 사라진(외부 정리 등) 고아 신청은 재생성 대상.
  //   (원인: 봄 2026 테스트라인 정리 등 라인만 삭제되고 application resolution 은 opened 로 남음 →
  //    통계는 개설 3인데 고객앱엔 라인 없음. 재개설 시 이 고아를 다시 열어 라인/타깃을 복구한다.)
  const openedRows = rows.filter((r) => r.resolution === "opened");
  const priorOpenedLineIds = Array.from(
    new Set(openedRows.map((r) => r.opened_line_id).filter((id): id is string => !!id)),
  );
  const existingLineIds = new Set<string>();
  if (priorOpenedLineIds.length > 0) {
    const { data: existRows } = await supabaseAdmin
      .from("cluster4_lines")
      .select("id")
      .in("id", priorOpenedLineIds);
    for (const l of (existRows ?? []) as Array<{ id: string }>) existingLineIds.add(l.id);
  }
  const orphaned = openedRows.filter(
    (r) => !r.opened_line_id || !existingLineIds.has(r.opened_line_id),
  );
  if (orphaned.length > 0) {
    console.warn("[competency open] 고아 opened 신청 self-heal(라인 재생성)", {
      org: input.org,
      weekId: input.weekId,
      count: orphaned.length,
    });
  }
  // 처리 대상 = 신규 신청 + 고아(라인 소실) opened 신청. 정상 opened(라인 존재)는 멱등 스킵.
  const pending = [...fresh, ...orphaned];
  if (pending.length === 0) {
    return {
      openedCrews: 0,
      openedLines: 0,
      rejectedCrews: 0,
      affectedUserIds: [],
      openedLineIds: [],
    };
  }

  // ── 모드 스코프 가드(fail-closed) ─────────────────────────────────────────
  //   라인 타깃을 만드는 건 승인(approval_checked) 신청뿐 — 그 대상 전원이 현재 모드 모집단에
  //   부합해야 한다(operating=실사용자만 / test=test_user_markers 만). 하나라도 어긋나면 타깃
  //   생성 전 422 로 중단(운영↔테스트 cluster4_line_targets 혼입 차단). 반려(미승인)는 타깃 무생성.
  const scope = await resolveUserScope(input.mode ?? "operating", input.org);
  const approvedTargetIds = pending
    .filter((r) => r.approval_checked)
    .map((r) => r.target_user_id);
  assertUserIdsInScope(scope, approvedTargetIds);

  // 성장 중단(paused/suspended) 방어 — 피커/저장 게이트를 우회했거나 승인 후 중단으로 바뀐 대상은
  //   개설해도 truncateCardsForGrowthStop 로 고객앱 미노출이라 라인을 만들지 않는다(pending 유지 →
  //   추후 성장 재개 시 재개설 가능). 전체 open 을 깨지 않고 해당 대상만 조용히 건너뛴다.
  const stoppedTargetIds = await filterGrowthStoppedUserIds(approvedTargetIds);

  const weekStart = await loadWeekStart(input.weekId);
  const win = weekStart ? deriveWindow(weekStart) : null;
  const nowIso = new Date().toISOString();

  const masterIds = Array.from(
    new Set(pending.map((r) => r.competency_line_master_id).filter((id): id is string => !!id)),
  );
  const masterMap = new Map<string, { line_code: string; line_name: string; main_title: string | null }>();
  if (masterIds.length > 0) {
    const { data } = await supabaseAdmin
      .from("cluster4_competency_line_masters")
      .select("id,line_code,line_name,main_title")
      .in("id", masterIds);
    for (const m of (data ?? []) as Array<{
      id: string;
      line_code: string;
      line_name: string;
      main_title: string | null;
    }>) {
      masterMap.set(m.id, { line_code: m.line_code, line_name: m.line_name, main_title: m.main_title });
    }
  }

  const link1 = (input.outputLink1 ?? "").trim() || null;
  const desc = (input.description ?? "").trim();
  const affected = new Set<string>();
  const openedLineIds: string[] = [];
  const openedLineKeys = new Set<string>();
  let openedCrews = 0;
  let rejectedCrews = 0;

  for (const r of pending) {
    if (!r.approval_checked) {
      await supabaseAdmin
        .from("cluster4_competency_applications")
        .update({ resolution: "rejected", updated_at: nowIso })
        .eq("id", r.id);
      rejectedCrews++;
      continue;
    }

    // 성장 중단 대상 방어 — 라인 생성 없이 pending 유지(로그만). 고객앱 미노출이라 개설 무의미.
    if (stoppedTargetIds.has(r.target_user_id)) {
      console.warn("[competency open] 성장 중단 대상 개설 건너뜀(pending 유지)", {
        applicationId: r.id,
        targetUserId: r.target_user_id,
      });
      continue;
    }

    const m = r.competency_line_master_id ? masterMap.get(r.competency_line_master_id) : null;
    const mainTitle =
      (m?.main_title?.trim() || m?.line_name?.trim() || r.line_name.trim()) || r.line_name;
    const link2 = (r.submission_link ?? "").trim() || null;
    const outputLinks: Array<{ url: string; label: string }> = [];
    if (link1) outputLinks.push({ url: link1, label: desc });
    if (link2) outputLinks.push({ url: link2, label: "" });

    const { data: lineRow, error: lineErr } = await supabaseAdmin
      .from("cluster4_lines")
      .insert({
        part_type: "competency",
        competency_line_master_id: r.competency_line_master_id,
        // 수동 추가는 드롭다운에서 고른 line_code 저장값 우선, 없으면 마스터 line_code.
        line_code: r.line_code ?? m?.line_code ?? null,
        main_title: mainTitle,
        output_link_1: link1,
        output_link_2: link2,
        output_links: outputLinks,
        submission_opens_at: win?.opensAt ?? nowIso,
        submission_closes_at: win?.closesAt ?? nowIso,
        is_active: true,
        // QA 기간(QA_HIDE_REAL_USERS=true) 생성분 표식 — 운영 조회 제외. 기본 false.
        is_qa_test: QA_HIDE_REAL_USERS,
        created_by: input.adminId,
        updated_by: input.adminId,
      })
      .select("id")
      .single();
    if (lineErr || !lineRow) {
      console.warn("[competency open] line insert failed:", r.id, lineErr?.message);
      continue;
    }
    const lineId = (lineRow as { id: string }).id;
    openedLineIds.push(lineId);
    const { data: tgtRow, error: tgtErr } = await supabaseAdmin
      .from("cluster4_line_targets")
      .insert({
        line_id: lineId,
        week_id: input.weekId,
        target_mode: "user",
        target_user_id: r.target_user_id,
        target_rule: {},
        created_by: input.adminId,
        updated_by: input.adminId,
      })
      .select("id")
      .single();
    if (tgtErr) {
      console.warn("[competency open] target insert failed:", r.id, tgtErr.message);
      await supabaseAdmin.from("cluster4_lines").delete().eq("id", lineId);
      continue;
    }
    await supabaseAdmin
      .from("cluster4_competency_applications")
      .update({
        resolution: "opened",
        opened_line_id: lineId,
        opened_target_id: (tgtRow as { id: string } | null)?.id ?? null,
        updated_at: nowIso,
      })
      .eq("id", r.id);
    affected.add(r.target_user_id);
    openedCrews++;
    openedLineKeys.add(lineKey(r));
  }

  return {
    openedCrews,
    openedLines: openedLineKeys.size,
    rejectedCrews,
    affectedUserIds: Array.from(affected),
    openedLineIds,
  };
}

// 현재 "고객 반영(개설)" 상태의 competency 총계 — resolution='opened' 이면서 실제 cluster4_lines row 가
//   존재하는 신청만 센다(고아=라인 소실은 제외). 완료 배너의 "반영 수" SoT 로, 통계 카드(개설 크루/개설
//   라인)와 정합하게 한다. 델타(이번 클릭에 새로 연 수)가 아니라 현재 열려있는 총 상태를 표시하기 위함
//   — 멱등 재개설에서도 "개설 3 vs 0 반영" 모순이 생기지 않는다.
export async function countOpenedCompetencyState(
  org: OrganizationSlug,
  weekId: string,
): Promise<{ crews: number; lines: number }> {
  const { data } = await supabaseAdmin
    .from("cluster4_competency_applications")
    .select("target_user_id,opened_line_id")
    .eq("organization_slug", org)
    .eq("week_id", weekId)
    .eq("resolution", "opened");
  const rows = (data ?? []) as Array<{ target_user_id: string; opened_line_id: string | null }>;
  const lineIds = Array.from(
    new Set(rows.map((r) => r.opened_line_id).filter((id): id is string => !!id)),
  );
  const existing = new Set<string>();
  if (lineIds.length > 0) {
    const { data: lines } = await supabaseAdmin
      .from("cluster4_lines")
      .select("id")
      .in("id", lineIds);
    for (const l of (lines ?? []) as Array<{ id: string }>) existing.add(l.id);
  }
  const crews = new Set(
    rows
      .filter((r) => r.opened_line_id && existing.has(r.opened_line_id))
      .map((r) => r.target_user_id),
  );
  return { crews: crews.size, lines: existing.size };
}

export async function cancelOpenedApplications(input: {
  org: OrganizationSlug;
  weekId: string;
}): Promise<{ affectedUserIds: string[]; removedLines: number }> {
  let opened: Array<{ target_user_id: string; opened_line_id: string | null }> = [];
  try {
    const { data, error } = await supabaseAdmin
      .from("cluster4_competency_applications")
      .select("target_user_id,opened_line_id")
      .eq("organization_slug", input.org)
      .eq("week_id", input.weekId)
      .eq("resolution", "opened");
    if (error) throw error;
    opened = (data ?? []) as Array<{ target_user_id: string; opened_line_id: string | null }>;
  } catch (e) {
    console.warn(
      "[competency cancel] applications load skipped (table missing?):",
      e instanceof Error ? e.message : e,
    );
    return { affectedUserIds: [], removedLines: 0 };
  }
  if (opened.length === 0) return { affectedUserIds: [], removedLines: 0 };

  const lineIds = Array.from(
    new Set(opened.map((r) => r.opened_line_id).filter((id): id is string => !!id)),
  );
  if (lineIds.length > 0) {
    await supabaseAdmin.from("cluster4_line_targets").delete().in("line_id", lineIds);
    await supabaseAdmin.from("cluster4_lines").delete().in("id", lineIds);
  }
  await supabaseAdmin
    .from("cluster4_competency_applications")
    .update({
      resolution: "pending",
      opened_line_id: null,
      opened_target_id: null,
      updated_at: new Date().toISOString(),
    })
    .eq("organization_slug", input.org)
    .eq("week_id", input.weekId)
    .eq("resolution", "opened");

  return {
    affectedUserIds: Array.from(new Set(opened.map((r) => r.target_user_id))),
    removedLines: lineIds.length,
  };
}

// 수동 추가 항목 삭제 — source='manual' 만 허용(고객 신청 customer 는 절대 삭제 금지, fail-closed).
//   이미 개설 완료로 생성된 라인(opened_line_id)이 있으면 함께 제거하고 해당 크루 snapshot 을 stale 표시.
export async function deleteManualCompetencyApplication(
  id: string,
): Promise<{ deleted: boolean }> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_competency_applications")
    .select("id,source,target_user_id,opened_line_id")
    .eq("id", id)
    .maybeSingle();
  if (error) throw Object.assign(new Error(error.message), { status: 500 });
  const row = data as {
    id: string;
    source: "customer" | "manual";
    target_user_id: string;
    opened_line_id: string | null;
  } | null;
  if (!row) throw Object.assign(new Error("항목을 찾을 수 없습니다"), { status: 404 });
  // ⚠ 고객 신청은 X 삭제 금지 — 승인 체크/반려 사유로만 처리.
  if (row.source !== "manual") {
    throw Object.assign(new Error("크루 신청 항목은 삭제할 수 없습니다"), { status: 403 });
  }

  // 개설 완료로 만들어진 라인이 있으면 고객 반영도 정리.
  if (row.opened_line_id) {
    await supabaseAdmin
      .from("cluster4_line_targets")
      .delete()
      .eq("line_id", row.opened_line_id);
    await supabaseAdmin.from("cluster4_lines").delete().eq("id", row.opened_line_id);
  }

  const { error: delErr } = await supabaseAdmin
    .from("cluster4_competency_applications")
    .delete()
    .eq("id", id);
  if (delErr) throw Object.assign(new Error(delErr.message), { status: 500 });

  if (row.opened_line_id) {
    // 마크-스테일만이 아니라 즉시 recompute — 개설 라인 삭제가 고객 weekly-cards 에 바로 반영되게.
    await invalidateWeeklyCardsForUsers([row.target_user_id]);
  }
  return { deleted: true };
}

// 카페 체크 / 승인 체크 / 반려 사유 갱신.
export async function updateCompetencyApplication(
  id: string,
  patch: {
    cafeChecked?: boolean;
    approvalChecked?: boolean;
    rejectionReason?: string | null;
  },
): Promise<void> {
  const upd: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.cafeChecked !== undefined) upd.cafe_checked = patch.cafeChecked;
  if (patch.approvalChecked !== undefined) upd.approval_checked = patch.approvalChecked;
  if (patch.rejectionReason !== undefined) upd.rejection_reason = patch.rejectionReason;
  const { error } = await supabaseAdmin
    .from("cluster4_competency_applications")
    .update(upd)
    .eq("id", id);
  if (error) throw Object.assign(new Error(error.message), { status: 500 });
}

// 실무 역량 [라인 개설] — 데이터 레이어(허브 전체 개설 완료/취소).
//
// 정책(2026-06-11 확정): 역량 라인은 experience 와 달리 [라인 개설] 내부 탭에서 cluster4_lines 로
// 즉시 생성/활성화된다(기존 흐름 무변경). 본 모듈의 허브 전체 [개설 완료]/[개설 취소]는 그 라인들의
// is_active 만 토글하고 snapshot 을 stale 표시한다 — 스테이징 구조를 새로 만들지 않는다.
//
//   개설 완료 : 대상 주차 + org + part_type=competency 라인 is_active=true + markStale
//   개설 취소 : 동일 조건 라인 is_active=false + markStale
//   상태 판단 : 대상 주차에 활성 역량 라인 ≥1 → opened, 없으면 개설 필요
//
// 대상 주차 = 개설 대상(금요일 경계 = openable week, 상태창/로그 API 와 동일 SoT 헬퍼).
// org 스코프 = 라인 org 노출 정책(resolveCluster4LineOrgScope)에서 lineOrg === org 인 "그 조직 소유"
// 라인만(common/판정불가 제외) — 한 조직의 개설/취소가 타 조직(공통 라인) 고객 반영을 건드리지 않도록.
//
// ⚠ snapshot 생성/조회 로직·weekly-card DTO 무변경. 영향 사용자는 invalidateWeeklyCardsForUsers 로
//    개설 직후 recompute(≤10 즉시 / >10 백그라운드) — info/experience 개설과 동일 경로. 마크-스테일만
//    하면 snapshot-only 조회 런타임에서 고객이 옛 snapshot 을 계속 본다(역량만 미반영 버그 방지).
//    로그 기록은 best-effort(본 토글과 분리).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  describeWeekByStartMs,
  getCurrentWeekStartMs,
  getOpenableWeekStartMs,
} from "@/lib/cluster4WeekPolicy";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import {
  collectLineOrgAudience,
  resolveCluster4LineOrgScope,
  invalidateWeeklyCardsForLineOpen,
} from "@/lib/adminCluster4LinesData";
import { invalidateWeeklyCardsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";
import { insertCompetencyOpeningLog } from "@/lib/adminCompetencyOpeningLogs";
import { resolveCluster4TestOpenableWeekStartMs } from "@/lib/cluster4TestWeekPolicy";
import { hasActiveAllLineException } from "@/lib/lineOpeningWindowsData";
import { resolveUserScope } from "@/lib/userScope";
import {
  assertApprovedApplicationsInScope,
  cancelOpenedApplications,
  hasOpenedApplications,
  openApprovedApplications,
} from "@/lib/adminCompetencyApplications";
import type { OrganizationSlug } from "@/lib/organizations";
import type { ScopeMode } from "@/lib/userScopeShared";
import type { StatusWeek } from "@/lib/lineOpeningStatusEngine";

type WeekInfo = NonNullable<ReturnType<typeof describeWeekByStartMs>>;

function toStatusWeek(info: WeekInfo): StatusWeek {
  return {
    year: info.year,
    seasonName: info.seasonName,
    weekNumber: info.weekNumber,
    startDate: info.weekStart,
    endDate: info.weekEnd,
    isOfficialRest: info.isOfficialRest,
  };
}

// 이번 주(N) / 지난 주(개설 대상) StatusWeek + 대상 주차 weeks.id(UUID).
//   mode=test 한정 — 2026 봄 휴식 꼬리에서는 개설 대상을 마지막 활동 주차 W13 으로 고정한다
//   (공통 SoT resolveCluster4TestOpenableWeekStartMs · hub="competency-line"). 운영 모드는 정규 금요일경계 그대로.
async function resolveWeeks(mode: ScopeMode = "operating"): Promise<{
  currentWeek: StatusWeek | null;
  targetWeek: StatusWeek | null;
  targetWeekId: string | null;
}> {
  const todayIso = getCurrentActivityDateIso();
  const currentStartMs = getCurrentWeekStartMs(todayIso);
  const regularOpenableStartMs = getOpenableWeekStartMs(todayIso);
  // 테스트 모드 예외(전 조직, 공통 SoT): 휴식 꼬리면 W13 시작 ms, 아니면 정규 대상 그대로.
  const openableStartMs = resolveCluster4TestOpenableWeekStartMs(
    mode,
    regularOpenableStartMs,
    { hub: "competency-line", organization: null },
  );
  const currentInfo = currentStartMs != null ? describeWeekByStartMs(currentStartMs) : null;
  const targetInfo = openableStartMs != null ? describeWeekByStartMs(openableStartMs) : null;

  let targetWeekId: string | null = null;
  if (targetInfo) {
    const { data: weekRow } = await supabaseAdmin
      .from("weeks")
      .select("id")
      .eq("iso_year", targetInfo.isoYear)
      .eq("iso_week", targetInfo.isoWeek)
      .maybeSingle();
    targetWeekId = (weekRow as { id: string } | null)?.id ?? null;
  }

  return {
    currentWeek: currentInfo ? toStatusWeek(currentInfo) : null,
    targetWeek: targetInfo ? toStatusWeek(targetInfo) : null,
    targetWeekId,
  };
}

function toMs(iso: string): number {
  return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
}

// 개설/취소/상태의 "대상 주차" 확정 — 요청 주차(requestedWeekId)가 있으면
//   (정규 개설 대상 주차와 일치) 또는 (scope=all 활성 예외 주차)일 때만 그 주차를 쓰고,
//   그 외에는 400(fail-closed). 요청이 없으면 정규 개설 대상(금요일 경계, 테스트 W13 예외) 그대로.
//   → /admin/settings/line-opening-windows 에서 허용한 주차를 역량 대시보드에서 선택·개설 가능.
async function resolveEffectiveWeek(
  mode: ScopeMode,
  requestedWeekId?: string | null,
  // 예외 판정 스코프 — 역량 대시보드의 org(조직 진입 시). null=통합/미지정.
  org: string | null = null,
): Promise<{ currentWeek: StatusWeek | null; targetWeek: StatusWeek | null; targetWeekId: string | null }> {
  const base = await resolveWeeks(mode);
  const req = (requestedWeekId ?? "").trim();
  if (!req || req === base.targetWeekId) return base;

  // 요청 주차가 허용(허브 전체) 예외인지 검증(org+역량 스코프) — 아니면 임의 주차 개설 차단.
  if (!(await hasActiveAllLineException(req, org, "competency"))) {
    throw Object.assign(
      new Error("선택한 주차는 개설 대상 주차(또는 허용된 예외 주차)가 아닙니다"),
      { status: 400 },
    );
  }
  const { data: w } = await supabaseAdmin
    .from("weeks")
    .select("start_date")
    .eq("id", req)
    .maybeSingle();
  const startDate = (w as { start_date: string } | null)?.start_date;
  if (!startDate) {
    throw Object.assign(new Error("요청한 주차를 찾을 수 없습니다"), { status: 404 });
  }
  const info = describeWeekByStartMs(toMs(startDate));
  return {
    currentWeek: base.currentWeek,
    targetWeek: info ? toStatusWeek(info) : base.targetWeek,
    targetWeekId: req,
  };
}

type CompetencyLineRow = {
  id: string;
  isActive: boolean;
  outputLink1: string | null;
  outputLinks: unknown;
  outputLink2: string | null;
};

// 대상 주차(targetWeekId)에 타깃이 걸린 part_type=competency 라인 중 lineOrg === org(그 조직 소유)만.
// common(전 조직 공통)/판정불가는 제외 — 한 조직의 토글이 타 조직 고객 반영을 건드리지 않게 한다.
async function loadOrgCompetencyLines(
  org: OrganizationSlug,
  targetWeekId: string,
): Promise<CompetencyLineRow[]> {
  const { data: targetRows, error: targetErr } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("line_id")
    .eq("week_id", targetWeekId);
  if (targetErr) throw new Error(targetErr.message);
  const lineIds = Array.from(
    new Set(
      ((targetRows ?? []) as Array<{ line_id: string | null }>)
        .map((r) => r.line_id)
        .filter((id): id is string => id != null),
    ),
  );
  if (lineIds.length === 0) return [];

  const { data: lineRows, error: lineErr } = await supabaseAdmin
    .from("cluster4_lines")
    .select(
      "id,part_type,line_code,experience_line_master_id,competency_line_master_id,is_active,output_link_1,output_link_2,output_links",
    )
    .eq("part_type", "competency")
    .in("id", lineIds);
  if (lineErr) throw new Error(lineErr.message);

  const out: CompetencyLineRow[] = [];
  for (const row of (lineRows ?? []) as Array<{
    id: string;
    part_type: string;
    line_code: string | null;
    experience_line_master_id: string | null;
    competency_line_master_id: string | null;
    is_active: boolean;
    output_link_1: string | null;
    output_link_2: string | null;
    output_links: unknown;
  }>) {
    const lineOrg = await resolveCluster4LineOrgScope(row);
    if (lineOrg === org) {
      out.push({
        id: row.id,
        isActive: row.is_active,
        outputLink1: row.output_link_1,
        outputLinks: row.output_links,
        outputLink2: row.output_link_2,
      });
    }
  }
  return out;
}

// ── 주차 공통 아웃풋 저장(cluster4_competency_week_output) — best-effort ──
// 폼 prefill 용 현재 적용값 + 개설 취소 원복용 라인별 직전 스냅샷. 테이블 미적용 시 graceful 무시.

type WeekOutputRow = {
  outputLink1: string | null;
  description: string | null;
  priorOutputs: Array<{
    line_id: string;
    output_link_1: string | null;
    output_links: unknown;
    output_link_2: string | null;
  }>;
  applied: boolean;
};

async function loadWeekOutput(
  org: OrganizationSlug,
  weekId: string,
): Promise<WeekOutputRow | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from("cluster4_competency_week_output")
      .select("output_link_1,output_description,prior_outputs,applied")
      .eq("organization_slug", org)
      .eq("week_id", weekId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const d = data as {
      output_link_1: string | null;
      output_description: string | null;
      prior_outputs: unknown;
      applied: boolean;
    };
    return {
      outputLink1: d.output_link_1,
      description: d.output_description,
      priorOutputs: Array.isArray(d.prior_outputs)
        ? (d.prior_outputs as WeekOutputRow["priorOutputs"])
        : [],
      applied: Boolean(d.applied),
    };
  } catch (e) {
    console.warn(
      "[competency week-output] load skipped (table missing?):",
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

async function upsertWeekOutput(input: {
  org: OrganizationSlug;
  weekId: string;
  outputLink1: string | null;
  description: string | null;
  priorOutputs: WeekOutputRow["priorOutputs"];
  applied: boolean;
  adminId: string | null;
}): Promise<void> {
  try {
    const { error } = await supabaseAdmin
      .from("cluster4_competency_week_output")
      .upsert(
        {
          organization_slug: input.org,
          week_id: input.weekId,
          output_link_1: input.outputLink1,
          output_description: input.description,
          prior_outputs: input.priorOutputs,
          applied: input.applied,
          updated_by: input.adminId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "organization_slug,week_id" },
      );
    if (error) throw error;
  } catch (e) {
    console.warn(
      "[competency week-output] upsert skipped (table missing?):",
      e instanceof Error ? e.message : e,
    );
  }
}

// 토글 대상 라인들의 영향 사용자(직접 타깃 ∪ org audience) — snapshot stale 표시 범위.
async function collectAffectedUsers(lineIds: string[]): Promise<string[]> {
  if (lineIds.length === 0) return [];
  const affected = new Set<string>();
  const { data: tgts } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("target_user_id")
    .in("line_id", lineIds);
  for (const t of (tgts ?? []) as Array<{ target_user_id: string | null }>) {
    if (t.target_user_id) affected.add(t.target_user_id);
  }
  // 라인 is_active 변화는 같은 org 분모(synthetic fail)에도 영향 → org audience 도 stale 표시.
  for (const lineId of lineIds) {
    try {
      for (const uid of await collectLineOrgAudience(lineId)) affected.add(uid);
    } catch {
      /* best-effort — 직접 타깃은 이미 수집됨 */
    }
  }
  return Array.from(affected);
}

// snapshot 무효화 대상 스코프 적용 — 현재 모집단(QA_HIDE_REAL_USERS 기준)만 남긴다.
//   QA 기간(스위치 on): mode 무관 test 모집단 → org audience 경로로 실사용자 snapshot 이 무효화/
//     재계산되는 것을 차단(실유저 무접촉 · 개설 대상 크루와 동일 축). 운영 복귀 후: operating 모집단.
//   resolveUserScope 가 마커 조회 실패 시 보수적 fail-safe(test=빈 결과·operating=전체 유지)를 보장.
async function scopeAffectedUsers(
  mode: ScopeMode,
  org: OrganizationSlug,
  affected: ReadonlySet<string>,
): Promise<string[]> {
  const ids = Array.from(affected);
  if (ids.length === 0) return ids;
  const scope = await resolveUserScope(mode, org);
  return scope.filter(ids);
}

export type CompetencyOpeningStatus = {
  currentWeek: StatusWeek | null;
  targetWeek: StatusWeek | null;
  opened: boolean;
  // 폼 prefill — 현재 적용된 주차 공통 아웃풋(링크/설명). 미적용/미저장 시 빈 문자열.
  outputLink1: string;
  outputDescription: string;
};

// 상태창용 — 대상 주차에 활성(그 조직 소유) 역량 라인이 ≥1 이면 opened.
//   mode 는 개설 대상 주차 판정에 사용(테스트 모드 W13 예외와 동일 SoT 라 상태창·개설이 같은 주차를 본다).
export async function getCompetencyOpeningStatus(
  org: OrganizationSlug | null,
  mode: ScopeMode = "operating",
  requestedWeekId?: string | null,
): Promise<CompetencyOpeningStatus> {
  const { currentWeek, targetWeek, targetWeekId } = await resolveEffectiveWeek(
    mode,
    requestedWeekId,
    org,
  );
  let opened = false;
  let outputLink1 = "";
  let outputDescription = "";
  if (org && targetWeekId) {
    const lines = await loadOrgCompetencyLines(org, targetWeekId);
    // opened = 활성 org 라인 ≥1 OR 신청 명단 기반 개설(resolution='opened') ≥1.
    opened = lines.some((l) => l.isActive) || (await hasOpenedApplications(org, targetWeekId));
    const wo = await loadWeekOutput(org, targetWeekId);
    if (wo) {
      outputLink1 = wo.outputLink1 ?? "";
      outputDescription = wo.description ?? "";
    }
  }
  return { currentWeek, targetWeek, opened, outputLink1, outputDescription };
}

export type CompetencyOpeningActionResult = {
  status: "opened" | "closed";
  linesChanged: number;
  linesTotal: number;
  // 신청/승인 명단 반영 결과(개설 완료/취소).
  openedCrews: number;
  openedLines: number;
  rejectedCrews: number;
};

// ── [개설 완료] 허브 전체 역량 라인 is_active=true + 주차 공통 아웃풋(링크/설명) 반영 + markStale + 로그 ──
//   outputLink1 이 비어 있으면 라인 아웃풋은 건드리지 않고 활성화만 한다(설명만 있으면 무시).
export async function openCompetencyHub(input: {
  organization: OrganizationSlug;
  outputLink1?: string | null;
  description?: string | null;
  adminId: string | null;
  // 운영/테스트 모집단 — 신청/승인 명단 기반 라인 타깃 생성 시 fail-closed 가드로 전달.
  mode?: ScopeMode;
  // 대시보드에서 선택한 개설 주차(허용 예외 주차 포함). 미지정=정규 개설 대상 주차.
  weekId?: string | null;
}): Promise<CompetencyOpeningActionResult> {
  const mode: ScopeMode = "operating";
  const { targetWeekId } = await resolveEffectiveWeek(mode, input.weekId, input.organization);
  if (!targetWeekId) {
    throw Object.assign(new Error("개설 대상 주차 정보를 확인할 수 없습니다"), { status: 400 });
  }
  const org = input.organization;
  const link = (input.outputLink1 ?? "").trim() || null;
  const desc = (input.description ?? "").trim() || null;

  // 모집단 스코프 사전 가드(write 0) — 승인 신청 대상이 현재 모집단(QA_HIDE_REAL_USERS 기준)과
  //   어긋나면 어떤 토글보다 먼저 422. 화면에 보인 크루 == 개설 대상이 항상 일치한다.
  await assertApprovedApplicationsInScope(org, targetWeekId, mode);

  const lines = await loadOrgCompetencyLines(org, targetWeekId);
  const lineIds = lines.map((l) => l.id);

  // 1) is_active=true (전체 — 멱등).
  if (lineIds.length > 0) {
    const { error } = await supabaseAdmin
      .from("cluster4_lines")
      .update({ is_active: true, updated_by: input.adminId })
      .in("id", lineIds);
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
  }

  // 2) 링크가 있으면 주차 공통 아웃풋을 모든 라인칸에 반영(output_link_1 + output_links[0]).
  //    덮어쓰기 전 직전값을 prior 로 스냅샷(개설 취소 원복용 — 최초 적용 시점만 캡처).
  if (link && lineIds.length > 0) {
    const existing = await loadWeekOutput(org, targetWeekId);
    const priorOutputs =
      existing?.applied && existing.priorOutputs.length > 0
        ? existing.priorOutputs
        : lines.map((l) => ({
            line_id: l.id,
            output_link_1: l.outputLink1,
            output_links: l.outputLinks,
            output_link_2: l.outputLink2,
          }));

    const { error: outErr } = await supabaseAdmin
      .from("cluster4_lines")
      .update({
        output_link_1: link,
        output_link_2: null,
        output_links: [{ url: link, label: desc ?? "" }],
        updated_by: input.adminId,
      })
      .in("id", lineIds);
    if (outErr) throw Object.assign(new Error(outErr.message), { status: 500 });

    await upsertWeekOutput({
      org,
      weekId: targetWeekId,
      outputLink1: link,
      description: desc,
      priorOutputs,
      applied: true,
      adminId: input.adminId,
    });
  } else {
    // 링크 미입력 — 라인 아웃풋 무변경. 적용값만 기록(있다면)해 prefill 유지.
    await upsertWeekOutput({
      org,
      weekId: targetWeekId,
      outputLink1: null,
      description: desc,
      priorOutputs: (await loadWeekOutput(org, targetWeekId))?.priorOutputs ?? [],
      applied: true,
      adminId: input.adminId,
    });
  }

  // 신청/승인 명단 반영 — approval_checked 신청 → 크루별 라인(link1=공통·link2=제출), 미승인 → 반려.
  let appResult = {
    openedCrews: 0,
    openedLines: 0,
    rejectedCrews: 0,
    affectedUserIds: [] as string[],
    openedLineIds: [] as string[],
  };
  try {
    appResult = await openApprovedApplications({
      org,
      weekId: targetWeekId,
      outputLink1: link,
      description: desc,
      adminId: input.adminId,
      mode,
    });
  } catch (e) {
    // 모드 스코프 위반(422)은 fail-closed — 운영자에게 그대로 노출(라인 타깃 혼입 차단).
    if ((e as { status?: number })?.status === 422) throw e;
    console.warn(
      "[competency open] application reflection skipped:",
      e instanceof Error ? e.message : e,
    );
  }

  // 개설 무효화 = 3허브 통일 헬퍼(배정 타깃 즉시 재계산 + org audience 분모 A stale). info/experience 와 동일 기준.
  //   openedLineIds/lineIds 는 동일 org → 아무 라인 하나로 org audience 산정. 스코프는 헬퍼가 mode 로 처리.
  const auditLineId = appResult.openedLineIds[0] ?? lineIds[0] ?? null;
  if (auditLineId) {
    await invalidateWeeklyCardsForLineOpen(auditLineId, appResult.affectedUserIds, mode);
  } else if (appResult.affectedUserIds.length > 0) {
    const scope = await resolveUserScope(mode, org);
    await invalidateWeeklyCardsForUsers(scope.filter(appResult.affectedUserIds));
  }

  await insertCompetencyOpeningLog({
    action: "open",
    weekId: targetWeekId,
    organizationSlug: org,
    changedBy: input.adminId,
  });

  return {
    status: "opened",
    linesChanged: lineIds.length,
    linesTotal: lines.length,
    openedCrews: appResult.openedCrews,
    openedLines: appResult.openedLines,
    rejectedCrews: appResult.rejectedCrews,
  };
}

// ── [개설 취소] 허브 전체 역량 라인 is_active=false + 아웃풋 원복 + markStale + 로그 ──
//   prior 스냅샷이 있으면 라인별 직전 아웃풋으로 복원, 없으면 적용했던 공통 아웃풋을 제거(원복).
export async function cancelCompetencyHub(input: {
  organization: OrganizationSlug;
  adminId: string | null;
  // 운영/테스트 모드 — 개설(open)과 동일 주차를 대상으로 취소하도록 전달(테스트 모드 W13 예외 정합).
  mode?: ScopeMode;
  // 개설과 동일 주차(허용 예외 포함)를 취소하도록 전달.
  weekId?: string | null;
}): Promise<CompetencyOpeningActionResult> {
  const mode = input.mode ?? "operating";
  const { targetWeekId } = await resolveEffectiveWeek(mode, input.weekId, input.organization);
  if (!targetWeekId) {
    throw Object.assign(new Error("개설 대상 주차 정보를 확인할 수 없습니다"), { status: 400 });
  }
  const org = input.organization;
  const lines = await loadOrgCompetencyLines(org, targetWeekId);
  const lineIds = lines.map((l) => l.id);

  // 1) is_active=false (전체).
  if (lineIds.length > 0) {
    const { error } = await supabaseAdmin
      .from("cluster4_lines")
      .update({ is_active: false, updated_by: input.adminId })
      .in("id", lineIds);
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
  }

  // 2) 아웃풋 원복 — prior 스냅샷이 있으면 라인별 복원, 없으면 적용 라인의 공통 아웃풋 제거.
  const existing = await loadWeekOutput(org, targetWeekId);
  const priorById = new Map(
    (existing?.priorOutputs ?? []).map((p) => [p.line_id, p]),
  );
  if (priorById.size > 0) {
    for (const l of lines) {
      const prior = priorById.get(l.id);
      if (!prior) continue;
      const { error } = await supabaseAdmin
        .from("cluster4_lines")
        .update({
          output_link_1: prior.output_link_1,
          output_link_2: prior.output_link_2,
          output_links: prior.output_links ?? [],
          updated_by: input.adminId,
        })
        .eq("id", l.id);
      if (error) {
        console.warn("[competency cancel] output restore failed:", l.id, error.message);
      }
    }
  } else if (existing?.outputLink1 && lineIds.length > 0) {
    // prior 없음(테이블 미적용 등) — 적용했던 공통 링크만 제거(원복).
    await supabaseAdmin
      .from("cluster4_lines")
      .update({ output_link_1: null, output_links: [], updated_by: input.adminId })
      .in("id", lineIds)
      .eq("output_link_1", existing.outputLink1);
  }

  // 3) 적용 상태/적용값/스냅샷 비우기(원복 완료).
  await upsertWeekOutput({
    org,
    weekId: targetWeekId,
    outputLink1: null,
    description: null,
    priorOutputs: [],
    applied: false,
    adminId: input.adminId,
  });

  // 신청/승인 명단 반영 원복 — opened 라인/타깃 삭제 + resolution='pending'.
  let appCancel = { affectedUserIds: [] as string[], removedLines: 0 };
  try {
    appCancel = await cancelOpenedApplications({ org, weekId: targetWeekId });
  } catch (e) {
    console.warn(
      "[competency cancel] application revert skipped:",
      e instanceof Error ? e.message : e,
    );
  }

  const affected = new Set<string>(appCancel.affectedUserIds);
  if (lineIds.length > 0) {
    for (const u of await collectAffectedUsers(lineIds)) affected.add(u);
  }
  const affectedUsers = await scopeAffectedUsers(mode, org, affected);
  // 마크-스테일만으로는 snapshot-only 조회 런타임에서 고객이 옛 snapshot 을 계속 본다(역량만 미반영
  //   버그의 근본 원인). info/experience 개설과 동일하게 invalidate(≤10 즉시 / >10 백그라운드 recompute)로
  //   개설 직후 고객 weekly-cards 에 반영되게 한다(읽기 경로·DTO·demoUserId 무변경).
  if (affectedUsers.length > 0) await invalidateWeeklyCardsForUsers(affectedUsers);

  await insertCompetencyOpeningLog({
    action: "cancel",
    weekId: targetWeekId,
    organizationSlug: org,
    changedBy: input.adminId,
  });

  return {
    status: "closed",
    linesChanged: lineIds.length,
    linesTotal: lines.length,
    openedCrews: 0,
    openedLines: 0,
    rejectedCrews: 0,
  };
}

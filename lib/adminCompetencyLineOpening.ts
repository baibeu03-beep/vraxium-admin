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
// ⚠ snapshot 생성/조회 로직·weekly-card DTO 무변경. markWeeklyCardsSnapshotStaleMany(저렴) + 기존
//    lazy recompute 경로 위임. 로그 기록은 best-effort(본 토글과 분리).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  describeWeekByStartMs,
  getCurrentWeekStartMs,
  getOpenableWeekStartMs,
} from "@/lib/cluster4WeekPolicy";
import {
  collectLineOrgAudience,
  resolveCluster4LineOrgScope,
} from "@/lib/adminCluster4LinesData";
import { markWeeklyCardsSnapshotStaleMany } from "@/lib/cluster4WeeklyCardsSnapshot";
import { insertCompetencyOpeningLog } from "@/lib/adminCompetencyOpeningLogs";
import type { OrganizationSlug } from "@/lib/organizations";
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
async function resolveWeeks(): Promise<{
  currentWeek: StatusWeek | null;
  targetWeek: StatusWeek | null;
  targetWeekId: string | null;
}> {
  const todayIso = new Date().toISOString().slice(0, 10);
  const currentStartMs = getCurrentWeekStartMs(todayIso);
  const openableStartMs = getOpenableWeekStartMs(todayIso);
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

type CompetencyLineRow = { id: string; isActive: boolean };

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
      "id,part_type,line_code,experience_line_master_id,competency_line_master_id,is_active",
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
  }>) {
    const lineOrg = await resolveCluster4LineOrgScope(row);
    if (lineOrg === org) out.push({ id: row.id, isActive: row.is_active });
  }
  return out;
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

export type CompetencyOpeningStatus = {
  currentWeek: StatusWeek | null;
  targetWeek: StatusWeek | null;
  opened: boolean;
};

// 상태창용 — 대상 주차에 활성(그 조직 소유) 역량 라인이 ≥1 이면 opened.
export async function getCompetencyOpeningStatus(
  org: OrganizationSlug | null,
): Promise<CompetencyOpeningStatus> {
  const { currentWeek, targetWeek, targetWeekId } = await resolveWeeks();
  let opened = false;
  if (org && targetWeekId) {
    const lines = await loadOrgCompetencyLines(org, targetWeekId);
    opened = lines.some((l) => l.isActive);
  }
  return { currentWeek, targetWeek, opened };
}

export type CompetencyOpeningActionResult = {
  status: "opened" | "closed";
  linesChanged: number;
  linesTotal: number;
};

// ── [개설 완료] 허브 전체 역량 라인 is_active=true + markStale + 로그 ──
export async function openCompetencyHub(input: {
  organization: OrganizationSlug;
  adminId: string | null;
}): Promise<CompetencyOpeningActionResult> {
  const { targetWeekId } = await resolveWeeks();
  if (!targetWeekId) {
    throw Object.assign(new Error("개설 대상 주차 정보를 확인할 수 없습니다"), { status: 400 });
  }
  return toggleCompetencyHub({
    organization: input.organization,
    targetWeekId,
    activate: true,
    adminId: input.adminId,
  });
}

// ── [개설 취소] 허브 전체 역량 라인 is_active=false + markStale + 로그 ──
export async function cancelCompetencyHub(input: {
  organization: OrganizationSlug;
  adminId: string | null;
}): Promise<CompetencyOpeningActionResult> {
  const { targetWeekId } = await resolveWeeks();
  if (!targetWeekId) {
    throw Object.assign(new Error("개설 대상 주차 정보를 확인할 수 없습니다"), { status: 400 });
  }
  return toggleCompetencyHub({
    organization: input.organization,
    targetWeekId,
    activate: false,
    adminId: input.adminId,
  });
}

async function toggleCompetencyHub(input: {
  organization: OrganizationSlug;
  targetWeekId: string;
  activate: boolean;
  adminId: string | null;
}): Promise<CompetencyOpeningActionResult> {
  const lines = await loadOrgCompetencyLines(input.organization, input.targetWeekId);
  // 실제 변경 대상 = 현재 상태와 다른 라인만(불필요한 write·stale 방지).
  const toChange = lines.filter((l) => l.isActive !== input.activate).map((l) => l.id);

  if (toChange.length > 0) {
    const { error } = await supabaseAdmin
      .from("cluster4_lines")
      .update({ is_active: input.activate, updated_by: input.adminId })
      .in("id", toChange);
    if (error) {
      throw Object.assign(new Error(error.message), { status: 500 });
    }

    const affected = await collectAffectedUsers(toChange);
    if (affected.length > 0) {
      await markWeeklyCardsSnapshotStaleMany(affected);
    }
  }

  // 로그는 행동 이력 — 변경 0건이어도 실행 사실을 남긴다(append-only).
  await insertCompetencyOpeningLog({
    action: input.activate ? "open" : "cancel",
    weekId: input.targetWeekId,
    organizationSlug: input.organization,
    changedBy: input.adminId,
  });

  return {
    status: input.activate ? "opened" : "closed",
    linesChanged: toChange.length,
    linesTotal: lines.length,
  };
}

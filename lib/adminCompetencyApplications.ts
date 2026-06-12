// 실무 역량 [라인 개설] 신청/승인 명단 — 데이터 레이어 (cluster4_competency_applications).
//
// 고객 신청(source='customer', 추후 고객 UI) + 운영자 수동 추가(source='manual')를 통합 관리한다.
// 표시값(크루명/팀/학교)은 읽기 시점에 loadCrewRecords 로 resolve(번호·이름 변경에도 최신값).
//
// ⚠ 어드민 승인 메타데이터. 고객 반영은 [개설 완료](adminCompetencyLineOpening)가 cluster4_lines 로 수행.
//    테이블 미적용(수동 마이그 전)이면 list/summary 는 빈/0 으로 graceful 동작.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadCrewRecords } from "@/lib/cluster4CafeLineMatch";
import { listCrewsForTargetSelection } from "@/lib/adminExperienceLineData";
import { markWeeklyCardsSnapshotStaleMany } from "@/lib/cluster4WeeklyCardsSnapshot";
import type { OrganizationSlug } from "@/lib/organizations";

export type CompetencyApplicationDto = {
  id: string;
  targetUserId: string;
  crewNo: number | null;
  displayName: string;
  teamName: string | null;
  schoolName: string | null;
  // "0030 - 홍길동 - 콘텐츠 팀 - 한국대"
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
  "id,target_user_id,competency_line_master_id,line_code,line_name,submission_link,cafe_checked,approval_checked,rejection_reason,source,resolution,created_at";

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
  created_at: string;
};

function crewLabel(r: {
  crewNo: number | null;
  name: string;
  teamName: string | null;
  schoolName: string | null;
}): string {
  const no = r.crewNo != null ? String(r.crewNo).padStart(4, "0") : "----";
  return [no, r.name || "-", r.teamName ?? "-", r.schoolName ?? "-"].join(" - ");
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

export async function listCompetencyApplications(
  org: OrganizationSlug,
  weekId: string,
): Promise<CompetencyApplicationDto[]> {
  const rows = await loadApplicationRows(org, weekId);
  if (rows.length === 0) return [];
  const records = await loadCrewRecords();
  const byUser = new Map(records.map((r) => [r.userId, r]));
  return rows.map((r) => {
    const rec = byUser.get(r.target_user_id) ?? null;
    return {
      id: r.id,
      targetUserId: r.target_user_id,
      crewNo: rec?.crewNo ?? null,
      displayName: rec?.name ?? "(이름 없음)",
      teamName: rec?.teamName ?? null,
      schoolName: rec?.schoolName ?? null,
      crewLabel: rec
        ? crewLabel(rec)
        : ["----", "(이름 없음)", "-", "-"].join(" - "),
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

// 테스트 계정(test_user_markers) 제외 — 활동 크루 집계는 운영 계정 기준(전면 제외 정책).
async function loadTestUserSet(): Promise<Set<string>> {
  try {
    const { data } = await supabaseAdmin.from("test_user_markers").select("user_id");
    return new Set(((data ?? []) as Array<{ user_id: string }>).map((m) => m.user_id));
  } catch {
    return new Set();
  }
}

export async function getCompetencyApplicationSummary(
  org: OrganizationSlug,
  weekId: string,
): Promise<CompetencyApplicationSummary> {
  const [rows, activeList, testSet] = await Promise.all([
    loadApplicationRows(org, weekId),
    listCrewsForTargetSelection({ organization: org, status: "active" }).catch(() => []),
    loadTestUserSet(),
  ]);
  // 활동 크루 = 휴식 제외 + 테스트 계정 제외(운영 계정 기준). 강화 결과 분모 = 활동 크루(미신청 포함).
  const activeIds = new Set(
    activeList.filter((c) => !testSet.has(c.userId)).map((c) => c.userId),
  );
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
};

export async function openApprovedApplications(input: {
  org: OrganizationSlug;
  weekId: string;
  outputLink1: string | null;
  description: string | null;
  adminId: string | null;
}): Promise<ApprovalReflectResult> {
  const rows = await loadApplicationRows(input.org, input.weekId);
  // 아직 개설 안 된 신청만 처리(opened 재처리 방지 — 멱등).
  const pending = rows.filter((r) => r.resolution !== "opened");
  if (pending.length === 0) {
    return { openedCrews: 0, openedLines: 0, rejectedCrews: 0, affectedUserIds: [] };
  }

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
  };
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
    throw Object.assign(new Error("고객 신청 항목은 삭제할 수 없습니다"), { status: 403 });
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
    await markWeeklyCardsSnapshotStaleMany([row.target_user_id]);
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

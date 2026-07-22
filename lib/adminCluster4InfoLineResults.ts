// 실무 정보 — "주차별 개설 결과" DTO (read-only).
//
// 선택 주차 + 실무 정보 라인(listInfoLineCatalog · 등록 라인 포함) 기준으로 라인별 개설 결과를
// 산정한다. 순수 조회 —
// 쓰기/snapshot/invalidate/demoUserId 어디에도 관여하지 않는다(고객 DTO 무영향).
//
// status:
//   - opened        : 해당 주차/라인에 실제 개설(활성 라인) 데이터가 있음.
//   - needs_opening : 오픈 대상인데 아직 개설 데이터가 없음. (현재 전 활동유형이 오픈 대상)
//   - not_open      : 오픈 대상 자체가 아님. (오픈 기준 미확정 — DTO 분리만, 현재 미사용)
//
// 2차 기입자(secondInputCount): "개설된 칸에서 크루가 어떤 2차 기입 데이터라도 변경했는지" 기준.
//   cluster4_line_submissions 의 어떤 필드라도 비어있지 않으면(점 하나 "." 포함) 1명으로 센다.
//   제출 성공/강화 판정과 무관 — 기입 여부만 본다.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { fmtDate, seasonLabelOnly, yy2 } from "@/lib/practicalInfoSeasonWeeks";
import { resolveCluster4LineOrgScope } from "@/lib/adminCluster4LinesData";
import { isLineVisibleForUserOrg } from "@/lib/cluster4LineOrg";
import type { OrganizationSlug } from "@/lib/organizations";
import { resolveUserScope, type ScopeMode } from "@/lib/userScope";
import { loadWeekOpeningConfig } from "@/lib/adminTeamPartsInfoWeekDetailData";
import { listInfoLineCatalog } from "@/lib/adminInfoLineCatalog";

export type InfoLineResultStatus = "opened" | "needs_opening" | "not_open";

export type InfoLineResultDto = {
  activityTypeId: string;
  lineName: string;
  // 개설된(opened) 라인의 cluster4_lines.id — "개설 대상 크루 수정" 진입에 사용. 미개설이면 null.
  lineId: string | null;
  status: InfoLineResultStatus;
  // 이번 주 "오픈(개설 대상)" 여부 — 오픈 확인 + practicalInfo[activityTypeId] 체크(weekOpenGate SoT).
  //   false = 미오픈(status='not_open') → 개설 완료 여부와 무관하게 어둡게 표시·집계 제외·개설 차단.
  isOpenThisWeek: boolean;
  openedAt: string | null; // opened_at ?? created_at (개설 완료일 때)
  mainTitle: string | null;
  openedByName: string | null; // 개설자(관리자 display_name ?? email)
  targetCount: number | null; // 개설 해당자(user-mode 타깃 수)
  secondInputCount: number | null; // 2차 기입자(어떤 필드라도 기입한 크루 수)
};

export type InfoLineResultsDto = {
  weekId: string;
  weekLabel: string;
  weekPeriod: string;
  // 주차 시작/종료일(date-only ISO) — "개설 대상 크루 수정" 허용 범위 판정에 사용(클라이언트 게이트).
  weekStartDate: string | null;
  weekEndDate: string | null;
  totalLineCount: number; // 전체 라인(카탈로그 = 정본 9종 + 등록된 신규 라인, org 스코프 적용)
  openLineCount: number; // 오픈 라인 = 이번 주 개설 대상(status != not_open)
  openedLineCount: number; // 개설 라인(실제 개설된 활성 라인 수 = status 'opened')
  needsOpeningCount: number; // 개설 필요(오픈 대상이나 미개설 = status 'needs_opening')
  notOpenCount: number; // 미오픈(이번 주 개설 대상 아님 = status 'not_open')
  lines: InfoLineResultDto[];
};

type LineMeta = {
  id: string;
  activity_type_id: string | null;
  main_title: string | null;
  opened_at: string | null;
  opened_by: string | null;
  created_by: string | null;
  created_at: string | null;
  line_code: string | null;
};

const neStr = (v: unknown): boolean =>
  typeof v === "string" && v.trim().length > 0;
const neArr = (v: unknown): boolean => Array.isArray(v) && v.length > 0;

// 어떤 필드라도 비어있지 않으면 "2차 기입"으로 본다.
function hasSecondInput(sub: Record<string, unknown>): boolean {
  return (
    neStr(sub.subtitle) ||
    neStr(sub.growth_point) ||
    neStr(sub.output_link_2) ||
    neStr(sub.output_link_3) ||
    neStr(sub.output_link_4) ||
    neStr(sub.output_link_5) ||
    neArr(sub.output_links) ||
    neArr(sub.output_images)
  );
}

export async function getInfoLineResultsForWeek(opts: {
  weekId: string;
  // 조직 스코프(통합 ↔ 조직 진입). null/미지정 = 통합(전체). 지정 시 (lineOrg == org) OR common 만 노출
  // — 어드민 라인 목록(filterLineIdsByOrg) · 고객 weekly-cards(isLineVisibleForUserOrg) 와 동일 정책.
  // info 라인 org SoT = line_code 토큰(OK/EC/PX/BS). 토큰 없는 info 는 'common' 으로 전체 노출.
  organization?: OrganizationSlug | null;
  // 운영/테스트 모집단 스코프(QA 누수 차단). 미지정=operating(실유저 라인만).
  //   test → user 대상자가 test_user_markers 인 라인만 "개설된 라인"으로 노출(운영 라인 0건).
  mode?: ScopeMode;
}): Promise<InfoLineResultsDto> {
  const { weekId, organization = null, mode } = opts;
  if (!isUuid(weekId)) throw new Error("week_id must be a UUID");

  // 미오픈 판정(주차별 개설 결과 = 이력 조회 뷰) — "오픈 설정이 실제로 존재하고 확인된(open_confirmed=true)"
  //   주차에서만 적용한다(정책 결정 2026-07-14). 오픈 설정이 없는(open_confirmed=false) 과거 주차는
  //   기존 동작을 보존해 개설 이력/결과가 그대로 보이게 한다(과거 111주차 미오픈 뒤집힘 방지).
  //   ⚠ 이 히스토리 보존은 "조회 뷰" 한정이다 — 실제 라인 개설(POST/폼)은 strict isInfoLineOpenForWeek 로
  //     open_confirmed=true + practicalInfo 체크된 라인만 개설 허용한다(별도, 강제). 통합(org=null)=미적용.
  const { config: openConfig, openConfirmed } = organization
    ? await loadWeekOpeningConfig(weekId, organization)
    : { config: null, openConfirmed: false };
  const gateActive = organization != null && openConfirmed === true;
  const lineOpenThisWeek = (activityTypeId: string): boolean =>
    gateActive ? openConfig?.practicalInfo?.[activityTypeId] === true : true;

  // 조직 지정 시 라인 1건이 그 조직에 노출되는지 — resolveCluster4LineOrgScope(단일 SoT) 로 판정.
  // 후보 라인은 전부 part_type='info' 이므로 line_code 만으로 동기 판정(추가 DB 조회 없음).
  const isOrgVisible = async (line: LineMeta): Promise<boolean> => {
    if (!organization) return true;
    const lineOrg = await resolveCluster4LineOrgScope({
      part_type: "info",
      line_code: line.line_code,
    });
    return isLineVisibleForUserOrg(lineOrg, organization, {
      allowUnknown: false,
    });
  };

  // 1. 주차 라벨/기간 — weeks + season_definitions(라벨).
  const { data: week, error: weekErr } = await supabaseAdmin
    .from("weeks")
    .select("id,week_number,start_date,end_date,season_key")
    .eq("id", weekId)
    .maybeSingle();
  if (weekErr) throw new Error(weekErr.message);
  if (!week) throw new Error("week not found");
  const w = week as {
    week_number: number | null;
    start_date: string | null;
    end_date: string | null;
    season_key: string | null;
  };
  let seasonLabel = w.season_key ?? "";
  if (w.season_key) {
    const { data: sd } = await supabaseAdmin
      .from("season_definitions")
      .select("season_label")
      .eq("season_key", w.season_key)
      .maybeSingle();
    const label = (sd as { season_label: string | null } | null)?.season_label;
    if (label) seasonLabel = label;
  }
  const yLabel = w.start_date ? `${yy2(Number(w.start_date.slice(0, 4)))}년 ` : "";
  const weekLabel = `${yLabel}${seasonLabelOnly(seasonLabel)} ${w.week_number ?? "-"}주차`;
  const weekPeriod =
    w.start_date && w.end_date
      ? `${fmtDate(w.start_date)} ~ ${fmtDate(w.end_date)}`
      : "-";

  // 2. 실무 정보 라인(활동유형) — org 스코프·활성·표시 순서·라인명 전부 카탈로그 단일 SoT.
  //    등록으로 추가된 신규 라인이 여기서 그대로 1행이 된다(practical-info 탭과 동일 목록·동일 ID).
  const typeRows = (await listInfoLineCatalog(organization)).map((l) => ({
    id: l.lineId,
    name: l.lineName,
  }));

  // 3. 해당 주차의 개설(활성) 라인 — 타깃(week_id, 0명 sentinel 포함) ∪ 라인 자체 week_id.
  //    QA 정책(2026-07-01): 라인 자체는 운영 그대로 전부 노출한다(고객앱과 동일 line_id 집합).
  //    scope 는 라인 제외가 아니라 "개설 해당자/2차 기입자 카운트"를 현재 모집단(QA=test)으로
  //    좁히는 데만 쓴다(대상 크루 = T 만). org 축은 별도 isOrgVisible.
  const scope = await resolveUserScope(mode ?? "operating", null);

  // 후보 라인(메타) + 라인별 user 대상자(user_id) + user target.id(2차 기입 카운트용) 를 먼저 모은다.
  //   (라인의 전체 user 대상자를 알아야 every() 판정이 가능 → lineByActivity 확정은 뒤로 미룬다.)
  const candidateLineMeta = new Map<string, LineMeta>(); // lineId → meta (tRows 우선, 그다음 lRows)
  const userIdsByLineId = new Map<string, string[]>(); // lineId → target_user_id[]
  const userTargetIdsByLineId = new Map<string, string[]>(); // lineId → target.id[]

  const { data: tRows, error: tErr } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select(
      "id,target_mode,target_user_id,cluster4_lines!inner(id,activity_type_id,main_title,opened_at,opened_by,created_by,created_at,line_code,part_type,is_active)",
    )
    .eq("week_id", weekId)
    .eq("cluster4_lines.is_active", true)
    .eq("cluster4_lines.part_type", "info");
  if (tErr) throw new Error(tErr.message);
  for (const row of (tRows ?? []) as unknown as Array<{
    id: string;
    target_mode: string;
    target_user_id: string | null;
    cluster4_lines: LineMeta | null;
  }>) {
    const line = row.cluster4_lines;
    if (!line || !line.activity_type_id) continue;
    if (!(await isOrgVisible(line))) continue;
    if (!candidateLineMeta.has(line.id)) candidateLineMeta.set(line.id, line);
    if (row.target_mode === "user" && row.target_user_id) {
      if (!userIdsByLineId.has(line.id)) userIdsByLineId.set(line.id, []);
      if (!userTargetIdsByLineId.has(line.id)) userTargetIdsByLineId.set(line.id, []);
      userIdsByLineId.get(line.id)!.push(row.target_user_id);
      userTargetIdsByLineId.get(line.id)!.push(row.id);
    }
  }

  // 타깃이 전혀 없는 라인 대비 — 라인 자체 week_id 로도 union(0명 sentinel 포함).
  const { data: lRows } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id,activity_type_id,main_title,opened_at,opened_by,created_by,created_at,line_code")
    .eq("part_type", "info")
    .eq("week_id", weekId)
    .eq("is_active", true);
  for (const line of (lRows ?? []) as LineMeta[]) {
    if (!line.activity_type_id) continue;
    if (!(await isOrgVisible(line))) continue;
    if (!candidateLineMeta.has(line.id)) candidateLineMeta.set(line.id, line);
  }

  // activity 별 대표 라인 선정(후보 삽입 순서 = tRows→lRows 유지).
  //   라인은 운영 그대로 전부 노출(개설 라인 목록 = 고객앱과 동일 line_id). 대상자 카운트
  //   (개설 해당자·2차 기입자)만 현재 모집단(QA=test)으로 좁힌다.
  const lineByActivity = new Map<string, LineMeta>();
  const userTargetIdsByLine = new Map<string, string[]>(); // lineId → user-mode target.id[] (현재 모집단만)
  for (const line of candidateLineMeta.values()) {
    if (!line.activity_type_id) continue;
    if (lineByActivity.has(line.activity_type_id)) continue; // 이미 대표 라인 확정
    lineByActivity.set(line.activity_type_id, line);
    const uids = userIdsByLineId.get(line.id) ?? [];
    const tids = userTargetIdsByLineId.get(line.id) ?? [];
    // uids/tids 는 같은 row 에서 함께 push 되어 동일 순서 → index 로 scope(현재 모집단) 필터.
    const scopedTids = tids.filter((_, i) => scope.includes(uids[i]));
    userTargetIdsByLine.set(line.id, scopedTids);
  }

  // 4. 개설자 이름 일괄 resolve (display_name ?? admin email ?? "관리자").
  const openerIds = Array.from(
    new Set(
      [...lineByActivity.values()]
        .map((l) => l.opened_by ?? l.created_by)
        .filter((v): v is string => Boolean(v)),
    ),
  );
  const nameById = new Map<string, string>();
  if (openerIds.length) {
    const { data: profs } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id,display_name")
      .in("user_id", openerIds);
    for (const p of (profs ?? []) as { user_id: string; display_name: string | null }[]) {
      if (p.display_name?.trim()) nameById.set(p.user_id, p.display_name.trim());
    }
    const missing = openerIds.filter((id) => !nameById.has(id));
    if (missing.length) {
      const { data: admins } = await supabaseAdmin
        .from("admin_users")
        .select("id,email")
        .in("id", missing);
      for (const a of (admins ?? []) as { id: string; email: string | null }[]) {
        if (a.email) nameById.set(a.id, a.email);
      }
    }
  }

  // 5. 2차 기입자 — 라인의 user 타깃 제출 중 어떤 필드라도 기입된 target.id 집합.
  const allTargetIds = Array.from(
    new Set([...userTargetIdsByLine.values()].flat()),
  );
  const secondInputTargetIds = new Set<string>();
  for (let i = 0; i < allTargetIds.length; i += 500) {
    const slice = allTargetIds.slice(i, i + 500);
    const { data: subs } = await supabaseAdmin
      .from("cluster4_line_submissions")
      .select(
        "line_target_id,subtitle,growth_point,output_link_2,output_link_3,output_link_4,output_link_5,output_links,output_images",
      )
      .in("line_target_id", slice);
    for (const s of (subs ?? []) as Array<Record<string, unknown> & { line_target_id: string }>) {
      if (hasSecondInput(s)) secondInputTargetIds.add(s.line_target_id);
    }
  }

  // 6. 활동유형별 라인 결과 조립.
  //    미오픈(!isOpenThisWeek) 이면 개설 완료 여부와 무관하게 status='not_open'(미오픈 우선 표시).
  const lines: InfoLineResultDto[] = typeRows.map((t) => {
    const isOpenThisWeek = lineOpenThisWeek(t.id);
    const line = lineByActivity.get(t.id);
    // 미오픈 — 이번 주 개설 대상이 아님. 물리 라인이 있어도 not_open 우선(개설 정보는 노출하지 않음).
    if (!isOpenThisWeek) {
      return {
        activityTypeId: t.id,
        lineName: t.name ?? t.id,
        lineId: line?.id ?? null,
        status: "not_open",
        isOpenThisWeek: false,
        openedAt: null,
        mainTitle: null,
        openedByName: null,
        targetCount: null,
        secondInputCount: null,
      };
    }
    if (!line) {
      return {
        activityTypeId: t.id,
        lineName: t.name ?? t.id,
        lineId: null,
        status: "needs_opening",
        isOpenThisWeek: true,
        openedAt: null,
        mainTitle: null,
        openedByName: null,
        targetCount: null,
        secondInputCount: null,
      };
    }
    const userTargets = userTargetIdsByLine.get(line.id) ?? [];
    const secondInput = userTargets.filter((id) =>
      secondInputTargetIds.has(id),
    ).length;
    const openerId = line.opened_by ?? line.created_by;
    return {
      activityTypeId: t.id,
      lineName: t.name ?? t.id,
      lineId: line.id,
      status: "opened",
      isOpenThisWeek: true,
      openedAt: line.opened_at ?? line.created_at,
      mainTitle: line.main_title ?? null,
      openedByName: openerId ? nameById.get(openerId) ?? "관리자" : null,
      targetCount: userTargets.length,
      secondInputCount: secondInput,
    };
  });

  const openedLineCount = lines.filter((l) => l.status === "opened").length;
  const needsOpeningCount = lines.filter((l) => l.status === "needs_opening").length;
  const notOpenCount = lines.filter((l) => l.status === "not_open").length;
  // 오픈 라인 = 이번 주 개설 대상(미오픈 제외). = 개설 + 개설 필요.
  const openLineCount = lines.filter((l) => l.status !== "not_open").length;

  return {
    weekId,
    weekLabel,
    weekPeriod,
    weekStartDate: w.start_date,
    weekEndDate: w.end_date,
    totalLineCount: lines.length,
    openLineCount,
    openedLineCount,
    needsOpeningCount,
    notOpenCount,
    lines,
  };
}

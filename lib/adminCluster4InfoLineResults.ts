// 실무 정보 — "주차별 개설 결과" DTO (read-only).
//
// 선택 주차 + 실무 정보 활동유형(9종) 기준으로 라인별 개설 결과를 산정한다. 순수 조회 —
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

export type InfoLineResultStatus = "opened" | "needs_opening" | "not_open";

export type InfoLineResultDto = {
  activityTypeId: string;
  lineName: string;
  // 개설된(opened) 라인의 cluster4_lines.id — "개설 대상 크루 수정" 진입에 사용. 미개설이면 null.
  lineId: string | null;
  status: InfoLineResultStatus;
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
  openLineCount: number; // 오픈 라인(임시 = 오픈 대상 라인 수 = status!=not_open). 추후 정의.
  openedLineCount: number; // 개설 라인(실제 개설된 활성 라인 수)
  lines: InfoLineResultDto[];
};

// 표시 순서 — PracticalInfoManager PREFERRED_TAB_ORDER 미러.
const PREFERRED_ORDER = [
  "wisdom",
  "essay",
  "infodesk",
  "calendar",
  "forum",
  "session",
  "practical_lecture",
  "community",
  "etc_a",
];

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
}): Promise<InfoLineResultsDto> {
  const { weekId, organization = null } = opts;
  if (!isUuid(weekId)) throw new Error("week_id must be a UUID");

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

  // 2. 실무 정보 활동유형(9종, 활성) — 표시 순서 적용.
  const { data: typeData, error: typeErr } = await supabaseAdmin
    .from("activity_types")
    .select("id,name")
    .eq("cluster_id", "practical_info")
    .eq("is_active", true);
  if (typeErr) throw new Error(typeErr.message);
  const typeRows = (typeData ?? []) as { id: string; name: string | null }[];
  const orderIdx = (id: string) => {
    const i = PREFERRED_ORDER.indexOf(id);
    return i < 0 ? PREFERRED_ORDER.length : i;
  };
  typeRows.sort((a, b) => orderIdx(a.id) - orderIdx(b.id) || a.id.localeCompare(b.id));

  // 3. 해당 주차의 개설(활성) 라인 — 타깃(week_id, 0명 sentinel 포함) ∪ 라인 자체 week_id.
  const lineByActivity = new Map<string, LineMeta>();
  const userTargetIdsByLine = new Map<string, string[]>(); // lineId → user-mode target.id[]

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
    if (!lineByActivity.has(line.activity_type_id))
      lineByActivity.set(line.activity_type_id, line);
    if (row.target_mode === "user" && row.target_user_id) {
      const arr = userTargetIdsByLine.get(line.id) ?? [];
      arr.push(row.id);
      userTargetIdsByLine.set(line.id, arr);
    }
  }

  // 타깃이 전혀 없는 라인 대비 — 라인 자체 week_id 로도 union.
  const { data: lRows } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id,activity_type_id,main_title,opened_at,opened_by,created_by,created_at,line_code")
    .eq("part_type", "info")
    .eq("week_id", weekId)
    .eq("is_active", true);
  for (const line of (lRows ?? []) as LineMeta[]) {
    if (!line.activity_type_id || lineByActivity.has(line.activity_type_id))
      continue;
    if (!(await isOrgVisible(line))) continue;
    lineByActivity.set(line.activity_type_id, line);
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
  const lines: InfoLineResultDto[] = typeRows.map((t) => {
    const line = lineByActivity.get(t.id);
    if (!line) {
      return {
        activityTypeId: t.id,
        lineName: t.name ?? t.id,
        lineId: null,
        status: "needs_opening",
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
      openedAt: line.opened_at ?? line.created_at,
      mainTitle: line.main_title ?? null,
      openedByName: openerId ? nameById.get(openerId) ?? "관리자" : null,
      targetCount: userTargets.length,
      secondInputCount: secondInput,
    };
  });

  const openedLineCount = lines.filter((l) => l.status === "opened").length;
  // 오픈 라인(임시): 오픈 대상 라인 수 = not_open 아닌 라인. 현재 전 활동유형 오픈 대상이라 = lines.length.
  const openLineCount = lines.filter((l) => l.status !== "not_open").length;

  return {
    weekId,
    weekLabel,
    weekPeriod,
    weekStartDate: w.start_date,
    weekEndDate: w.end_date,
    openLineCount,
    openedLineCount,
    lines,
  };
}

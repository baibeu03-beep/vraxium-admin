import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import {
  describeWeekByStartMs,
  getCurrentWeekStartMs,
} from "@/lib/cluster4WeekPolicy";

// /admin/settings/process-check-windows 전용 server-only 데이터 레이어.
// canonical 테이블: public.process_check_windows.
//   - organization_slug NULL → 전체 조직 · 값 → 그 조직만.
//   - hub NULL               → 전체 프로세스 허브 · 값 → 그 허브만.
//   "활성 예외" = is_active = true AND allow_selection = true.
//
// 판정 규칙(프로세스 체크 주차 선택/편집 가능 여부):
//   기본 정책(현재 시즌 W1~현재주차 · 현재 주차만 편집) 허용  OR  활성 예외 존재.
//   예외는 기본 정책을 "대체"하지 않고 "추가 허용"한다(operating 기준 · mode=test 무관).
//
// line_opening_windows(lib/lineOpeningWindowsData.ts) 와 동형이되, 도메인이 프로세스 체크라
//   테이블/헬퍼/스코프(org·hub)를 분리한다. 고객 앱/snapshot/user_weekly_points 무접촉.

export class ProcessCheckWindowError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ProcessCheckWindowError";
    this.status = status;
  }
}

// 예외가 가리킬 수 있는 프로세스 허브(NULL=전체). 프로세스 체크 5허브 + 변동 액트.
export const PROCESS_CHECK_WINDOW_HUBS = [
  "club",
  "info",
  "experience",
  "competency",
  "career",
  "irregular",
] as const;
export type ProcessCheckWindowHub = (typeof PROCESS_CHECK_WINDOW_HUBS)[number];

export function isProcessCheckWindowHub(v: unknown): v is ProcessCheckWindowHub {
  return (
    typeof v === "string" &&
    (PROCESS_CHECK_WINDOW_HUBS as readonly string[]).includes(v)
  );
}

function toMs(iso: string): number {
  return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
}

// ─────────────────────────────────────────────────────────────────────────
// 타입
// ─────────────────────────────────────────────────────────────────────────

type WindowRow = {
  id: string;
  week_id: string;
  organization_slug: string | null;
  hub: string | null;
  allow_selection: boolean;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type ProcessCheckWindowDto = {
  id: string;
  weekId: string;
  organizationSlug: string | null; // null = 전체 조직
  hub: string | null; // null = 전체 허브
  allowSelection: boolean;
  isActive: boolean;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  // 표시용 파생값(weeks 조인).
  weekLabel: string | null; // "26년 봄 시즌 13주차"
  weekStart: string | null;
  weekEnd: string | null;
};

// 예외 등록 폼 주차 드롭다운 옵션 — weeks 에 존재하는 전 시즌·전 주차.
export type ProcessCheckWindowWeekOption = {
  id: string; // weeks.id
  label: string; // "26년 봄 시즌 13주차"
  year: number;
  seasonName: string;
  weekNumber: number;
  startDate: string;
  endDate: string;
  isCurrent: boolean; // 기본 정책상 현재(편집 가능) 주차
  isOfficialRest: boolean;
};

type WeekRow = {
  id: string;
  iso_year: number;
  iso_week: number;
  start_date: string;
  end_date: string;
};

const WEEK_SELECT = "id,iso_year,iso_week,start_date,end_date";
const WINDOW_SELECT =
  "id,week_id,organization_slug,hub,allow_selection,is_active,created_by,created_at,updated_at";

async function loadWeekRow(weekId: string): Promise<WeekRow> {
  if (!isUuid(weekId)) {
    throw new ProcessCheckWindowError(400, "week_id must be a UUID");
  }
  const { data, error } = await supabaseAdmin
    .from("weeks")
    .select(WEEK_SELECT)
    .eq("id", weekId)
    .maybeSingle();
  if (error) throw new ProcessCheckWindowError(500, error.message);
  if (!data) throw new ProcessCheckWindowError(404, `week not found: ${weekId}`);
  return data as WeekRow;
}

function weekLabelFromRow(row: WeekRow): {
  label: string;
  startDate: string;
  endDate: string;
} | null {
  const info = describeWeekByStartMs(toMs(row.start_date));
  if (!info) return null;
  return {
    label: `${info.year}년 ${info.seasonName} ${info.weekNumber}주차`,
    startDate: info.weekStart,
    endDate: info.weekEnd,
  };
}

function migrationHint(error: { code?: string } | null): ProcessCheckWindowError | null {
  const code = error?.code;
  if (code === "PGRST205" || code === "PGRST204" || code === "42P01") {
    return new ProcessCheckWindowError(
      500,
      "process_check_windows 스키마가 없습니다. db/migrations/2026-07-01_process_check_windows.sql 을 SQL Editor 에서 적용해주세요.",
    );
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// 판정 — 프로세스 체크 read/write 게이트에서 호출.
//   (org NULL ∨ org 일치) AND (hub NULL ∨ hub 일치) 인 활성 예외.
//   nullable 컬럼 매칭은 PostgREST .or() 대신 JS 필터로(작은 테이블 · 안전).
// ─────────────────────────────────────────────────────────────────────────

// 여러 주차를 한 번에 판정(드롭다운) — org+hub 스코프의 활성 예외 week_id 집합.
export async function getActiveProcessCheckExceptionWeekIds(
  organization: string | null,
  hub: string | null,
): Promise<Set<string>> {
  const { data, error } = await supabaseAdmin
    .from("process_check_windows")
    .select("week_id,organization_slug,hub")
    .eq("is_active", true)
    .eq("allow_selection", true);
  if (error) {
    // 스키마 미적용이면 예외 없음으로 degrade(기본 정책만 · 보드 정상 동작).
    if (migrationHint(error)) return new Set();
    throw new ProcessCheckWindowError(500, error.message);
  }
  const rows = (data ?? []) as Array<{
    week_id: string;
    organization_slug: string | null;
    hub: string | null;
  }>;
  const out = new Set<string>();
  for (const r of rows) {
    if (r.organization_slug !== null && r.organization_slug !== organization) continue;
    if (r.hub !== null && r.hub !== hub) continue;
    out.add(r.week_id);
  }
  return out;
}

// 단일 주차 — org+hub 스코프의 활성 예외 존재 여부(write 게이트).
export async function hasActiveProcessCheckException(
  weekId: string,
  organization: string | null,
  hub: string | null,
): Promise<boolean> {
  if (!isUuid(weekId)) return false;
  const ids = await getActiveProcessCheckExceptionWeekIds(organization, hub);
  return ids.has(weekId);
}

// ─────────────────────────────────────────────────────────────────────────
// 목록 — 활성/비활성 모두. 주차 라벨·등록자명 조인.
// ─────────────────────────────────────────────────────────────────────────

export async function listProcessCheckWindows(): Promise<ProcessCheckWindowDto[]> {
  const { data, error } = await supabaseAdmin
    .from("process_check_windows")
    .select(WINDOW_SELECT)
    .order("created_at", { ascending: false });
  if (error) throw migrationHint(error) ?? new ProcessCheckWindowError(500, error.message);
  const rows = (data ?? []) as WindowRow[];
  if (rows.length === 0) return [];

  const weekIds = Array.from(new Set(rows.map((r) => r.week_id)));
  const creatorIds = Array.from(
    new Set(rows.map((r) => r.created_by).filter((v): v is string => !!v)),
  );

  const weekRowById = new Map<string, WeekRow>();
  if (weekIds.length > 0) {
    const { data: weeks, error: wErr } = await supabaseAdmin
      .from("weeks")
      .select(WEEK_SELECT)
      .in("id", weekIds);
    if (wErr) throw new ProcessCheckWindowError(500, wErr.message);
    for (const w of (weeks ?? []) as WeekRow[]) weekRowById.set(w.id, w);
  }

  const creatorNameById = new Map<string, string>();
  if (creatorIds.length > 0) {
    const { data: profiles, error: pErr } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id,display_name")
      .in("user_id", creatorIds);
    if (pErr) throw new ProcessCheckWindowError(500, pErr.message);
    for (const p of (profiles ?? []) as Array<{
      user_id: string;
      display_name: string | null;
    }>) {
      if (p.display_name) creatorNameById.set(p.user_id, p.display_name);
    }
  }

  return rows.map((r) => rowToDto(r, weekRowById.get(r.week_id) ?? null, creatorNameById));
}

function rowToDto(
  r: WindowRow,
  weekRow: WeekRow | null,
  creatorNameById: Map<string, string>,
): ProcessCheckWindowDto {
  const labelInfo = weekRow ? weekLabelFromRow(weekRow) : null;
  return {
    id: r.id,
    weekId: r.week_id,
    organizationSlug: r.organization_slug,
    hub: r.hub,
    allowSelection: r.allow_selection,
    isActive: r.is_active,
    createdBy: r.created_by,
    createdByName: r.created_by ? creatorNameById.get(r.created_by) ?? null : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    weekLabel: labelInfo?.label ?? null,
    weekStart: weekRow?.start_date ?? null,
    weekEnd: weekRow?.end_date ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 생성 — (week_id, org, hub) 조합. 같은 조합 행이 이미 있으면 is_active=true 로 되살린다.
// ─────────────────────────────────────────────────────────────────────────

export async function createProcessCheckWindow(input: {
  weekId: string;
  organizationSlug: string | null; // null = 전체 조직
  hub: string | null; // null = 전체 허브
  createdBy: string | null;
}): Promise<ProcessCheckWindowDto> {
  const weekRow = await loadWeekRow(input.weekId);
  const org = input.organizationSlug ?? null;
  const hub = input.hub ?? null;
  if (hub !== null && !isProcessCheckWindowHub(hub)) {
    throw new ProcessCheckWindowError(400, "유효하지 않은 허브입니다");
  }

  // 기존 행(active/inactive 무관) 탐색 — 중복 방지 + 재활성. NULL 은 .is() 로 매칭.
  let existingQuery = supabaseAdmin
    .from("process_check_windows")
    .select(WINDOW_SELECT)
    .eq("week_id", weekRow.id);
  existingQuery =
    org === null
      ? existingQuery.is("organization_slug", null)
      : existingQuery.eq("organization_slug", org);
  existingQuery =
    hub === null ? existingQuery.is("hub", null) : existingQuery.eq("hub", hub);
  const { data: existingRows, error: exErr } = await existingQuery.limit(1);
  if (exErr) throw migrationHint(exErr) ?? new ProcessCheckWindowError(500, exErr.message);

  const existing = (existingRows ?? [])[0] as WindowRow | undefined;
  const empty = new Map<string, string>();
  if (existing) {
    const { data: updated, error: uErr } = await supabaseAdmin
      .from("process_check_windows")
      .update({ is_active: true, allow_selection: true })
      .eq("id", existing.id)
      .select(WINDOW_SELECT)
      .single();
    if (uErr) throw new ProcessCheckWindowError(500, uErr.message);
    return rowToDto(updated as WindowRow, weekRow, empty);
  }

  const { data: inserted, error: iErr } = await supabaseAdmin
    .from("process_check_windows")
    .insert({
      week_id: weekRow.id,
      organization_slug: org,
      hub,
      allow_selection: true,
      is_active: true,
      created_by: input.createdBy,
    })
    .select(WINDOW_SELECT)
    .single();
  if (iErr) throw migrationHint(iErr) ?? new ProcessCheckWindowError(500, iErr.message);
  return rowToDto(inserted as WindowRow, weekRow, empty);
}

// ─────────────────────────────────────────────────────────────────────────
// 활성/비활성 토글 · 삭제
// ─────────────────────────────────────────────────────────────────────────

export async function setProcessCheckWindowActive(
  id: string,
  isActive: boolean,
): Promise<void> {
  if (!isUuid(id)) throw new ProcessCheckWindowError(400, "id must be a UUID");
  const { data, error } = await supabaseAdmin
    .from("process_check_windows")
    .update({ is_active: isActive })
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) throw new ProcessCheckWindowError(500, error.message);
  if (!data) throw new ProcessCheckWindowError(404, "예외를 찾을 수 없습니다");
}

export async function deleteProcessCheckWindow(id: string): Promise<void> {
  if (!isUuid(id)) throw new ProcessCheckWindowError(400, "id must be a UUID");
  const { error } = await supabaseAdmin
    .from("process_check_windows")
    .delete()
    .eq("id", id);
  if (error) throw new ProcessCheckWindowError(500, error.message);
}

// ─────────────────────────────────────────────────────────────────────────
// 예외 등록 폼 주차 옵션 — weeks 테이블에 존재하는 모든 주차(전 시즌·과거/현재/미래).
//   기본 정책은 현재 시즌 W1~현재만 다루지만, 예외는 미래·타시즌 주차도 열 수 있어야 하므로
//   DB 에 등록된 전 주차를 옵션으로 노출한다(시작일 내림차순 = 최근 상단).
// ─────────────────────────────────────────────────────────────────────────

export async function listProcessCheckWindowWeekOptions(
  todayIso: string,
): Promise<ProcessCheckWindowWeekOption[]> {
  const currentWeekStartMs = getCurrentWeekStartMs(todayIso);

  const { data: weekRows, error } = await supabaseAdmin
    .from("weeks")
    .select(WEEK_SELECT)
    .order("start_date", { ascending: false })
    .limit(1000);
  if (error) throw new ProcessCheckWindowError(500, error.message);

  const options: ProcessCheckWindowWeekOption[] = [];
  for (const row of (weekRows ?? []) as WeekRow[]) {
    const weekStartMs = toMs(row.start_date);
    const info = describeWeekByStartMs(weekStartMs);
    if (!info) continue; // 시즌 캘린더 밖(비정상 행)은 건너뜀.
    options.push({
      id: row.id,
      label: `${info.year}년 ${info.seasonName} ${info.weekNumber}주차`,
      year: info.year,
      seasonName: info.seasonName,
      weekNumber: info.weekNumber,
      startDate: info.weekStart,
      endDate: info.weekEnd,
      isCurrent: weekStartMs === currentWeekStartMs,
      isOfficialRest: info.isOfficialRest,
    });
  }
  return options;
}

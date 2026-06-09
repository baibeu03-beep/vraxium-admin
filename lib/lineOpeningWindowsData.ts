import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import {
  describeWeekByStartMs,
  getCurrentWeekStartMs,
  getOpenableWeekStartMs,
  submissionWindowForWeekStartIso,
} from "@/lib/cluster4WeekPolicy";

// /admin/settings/line-opening-windows 전용 server-only 데이터 레이어.
// canonical 테이블: public.line_opening_windows.
//   - activity_type_id NULL  → 해당 주차 전체 라인 개설 허용.
//   - activity_type_id 값     → 해당 주차의 특정 활동 유형(라인)만 허용.
//   "활성 예외" = is_active = true AND allow_opening = true.
//
// 판정 규칙(라인 개설 가능 여부):
//   자동 정책(목요일 경계 규칙) 허용  OR  활성 예외 존재.
// info-lines POST 게이트가 findActiveLineOpeningException 로 두 번째 항을 평가한다.

export class LineOpeningWindowError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "LineOpeningWindowError";
    this.status = status;
  }
}

const DAY_MS = 86_400_000;

function toMs(iso: string): number {
  return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
}

// ─────────────────────────────────────────────────────────────────────────
// 타입
// ─────────────────────────────────────────────────────────────────────────

type WindowRow = {
  id: string;
  week_id: string;
  activity_type_id: string | null;
  allow_opening: boolean;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type LineOpeningWindowDto = {
  id: string;
  weekId: string;
  activityTypeId: string | null;
  allowOpening: boolean;
  isActive: boolean;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  // 표시용 파생값(weeks/activity_types 조인).
  weekLabel: string | null; // "26년 봄 시즌 13주차"
  weekStart: string | null;
  weekEnd: string | null;
  activityTypeName: string | null; // null = 전체 라인
};

// 예외 등록 폼(화면 2) 주차 드롭다운 옵션. 현재 주차 N 주변 ±N 주.
export type ExceptionWeekFormOption = {
  id: string; // weeks.id
  label: string; // "26년 봄 시즌 13주차 (26.06.01 ~ 26.06.07)"
  year: number;
  seasonName: string;
  weekNumber: number;
  startDate: string;
  endDate: string;
  isCurrent: boolean;
  isOpenTarget: boolean; // 자동 정책 개설 대상(목요일 경계)
  canOpen: boolean; // 휴식 주차면 false (예외로는 열 수 있으나 표시용)
};

// 라인 개설 폼(섹션 0) 연동용 — 활성 예외가 가리키는 주차 서술자 + 허용 라인.
export type ActiveExceptionWeek = {
  id: string; // weeks.id
  year: number;
  seasonName: string;
  weekNumber: number;
  startDate: string;
  endDate: string;
  isOfficialRest: boolean;
  // 예외는 자동 정책(휴식 포함)을 덮어쓴다 → 개설 가능으로 노출(canOpen=true).
  canOpen: boolean;
  submissionOpensAt: string | null;
  submissionClosesAt: string | null;
  // null = 해당 주차 전체 허용, 배열 = 그 활동 유형들만 허용.
  allowedActivityTypeIds: string[] | null;
};

// ─────────────────────────────────────────────────────────────────────────
// 주차 컨텍스트 헬퍼
// ─────────────────────────────────────────────────────────────────────────

type WeekRow = {
  id: string;
  iso_year: number;
  iso_week: number;
  start_date: string;
  end_date: string;
};

const WEEK_SELECT = "id,iso_year,iso_week,start_date,end_date";

async function loadWeekRow(weekId: string): Promise<WeekRow> {
  if (!isUuid(weekId)) {
    throw new LineOpeningWindowError(400, "week_id must be a UUID");
  }
  const { data, error } = await supabaseAdmin
    .from("weeks")
    .select(WEEK_SELECT)
    .eq("id", weekId)
    .maybeSingle();
  if (error) throw new LineOpeningWindowError(500, error.message);
  if (!data) throw new LineOpeningWindowError(404, `week not found: ${weekId}`);
  return data as WeekRow;
}

function weekLabelFromRow(row: WeekRow): {
  label: string;
  year: number;
  seasonName: string;
  weekNumber: number;
  isOfficialRest: boolean;
} | null {
  const info = describeWeekByStartMs(toMs(row.start_date));
  if (!info) return null;
  return {
    label: `${info.year}년 ${info.seasonName} ${info.weekNumber}주차`,
    year: info.year,
    seasonName: info.seasonName,
    weekNumber: info.weekNumber,
    isOfficialRest: info.isOfficialRest,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 판정 — info-lines POST 게이트에서 호출.
// 이 주차 + 이 활동 유형을 지금 개설할 수 있는 "활성 예외"가 존재하는가?
//   (activity_type_id IS NULL = 전체 허용) OR (activity_type_id = 해당 유형)
// ─────────────────────────────────────────────────────────────────────────

export async function findActiveLineOpeningException(
  weekId: string,
  activityTypeId: string,
): Promise<boolean> {
  if (!isUuid(weekId)) return false;
  // activity_type_id 는 text slug('wisdom' 등)이라 PostgREST .or() 문자열에 값을 끼워넣지 않고,
  // 해당 주차의 활성 예외 행만 받아 JS 에서 (전체 NULL ∨ 일치) 를 판정한다(인젝션/이스케이프 회피).
  const { data, error } = await supabaseAdmin
    .from("line_opening_windows")
    .select("activity_type_id")
    .eq("week_id", weekId)
    .eq("is_active", true)
    .eq("allow_opening", true);
  if (error) throw new LineOpeningWindowError(500, error.message);
  const rows = (data ?? []) as Array<{ activity_type_id: string | null }>;
  return rows.some(
    (r) => r.activity_type_id === null || r.activity_type_id === activityTypeId,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 목록(화면 3) — 활성/비활성 모두. 주차 라벨·활동유형명·등록자명 조인.
// ─────────────────────────────────────────────────────────────────────────

export async function listLineOpeningWindows(): Promise<LineOpeningWindowDto[]> {
  const { data, error } = await supabaseAdmin
    .from("line_opening_windows")
    .select(
      "id,week_id,activity_type_id,allow_opening,is_active,created_by,created_at,updated_at",
    )
    .order("created_at", { ascending: false });
  if (error) throw new LineOpeningWindowError(500, error.message);
  const rows = (data ?? []) as WindowRow[];
  if (rows.length === 0) return [];

  const weekIds = Array.from(new Set(rows.map((r) => r.week_id)));
  const activityTypeIds = Array.from(
    new Set(rows.map((r) => r.activity_type_id).filter((v): v is string => !!v)),
  );
  const creatorIds = Array.from(
    new Set(rows.map((r) => r.created_by).filter((v): v is string => !!v)),
  );

  // 주차 라벨
  const weekRowById = new Map<string, WeekRow>();
  if (weekIds.length > 0) {
    const { data: weeks, error: wErr } = await supabaseAdmin
      .from("weeks")
      .select(WEEK_SELECT)
      .in("id", weekIds);
    if (wErr) throw new LineOpeningWindowError(500, wErr.message);
    for (const w of (weeks ?? []) as WeekRow[]) weekRowById.set(w.id, w);
  }

  // 활동유형명
  const activityNameById = new Map<string, string>();
  if (activityTypeIds.length > 0) {
    const { data: types, error: tErr } = await supabaseAdmin
      .from("activity_types")
      .select("id,name")
      .in("id", activityTypeIds);
    if (tErr) throw new LineOpeningWindowError(500, tErr.message);
    for (const t of (types ?? []) as Array<{ id: string; name: string }>) {
      activityNameById.set(t.id, t.name);
    }
  }

  // 등록자명(user_profiles.display_name)
  const creatorNameById = new Map<string, string>();
  if (creatorIds.length > 0) {
    const { data: profiles, error: pErr } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id,display_name")
      .in("user_id", creatorIds);
    if (pErr) throw new LineOpeningWindowError(500, pErr.message);
    for (const p of (profiles ?? []) as Array<{
      user_id: string;
      display_name: string | null;
    }>) {
      if (p.display_name) creatorNameById.set(p.user_id, p.display_name);
    }
  }

  return rows.map((r) => {
    const weekRow = weekRowById.get(r.week_id) ?? null;
    const labelInfo = weekRow ? weekLabelFromRow(weekRow) : null;
    return {
      id: r.id,
      weekId: r.week_id,
      activityTypeId: r.activity_type_id,
      allowOpening: r.allow_opening,
      isActive: r.is_active,
      createdBy: r.created_by,
      createdByName: r.created_by
        ? creatorNameById.get(r.created_by) ?? null
        : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      weekLabel: labelInfo?.label ?? null,
      weekStart: weekRow?.start_date ?? null,
      weekEnd: weekRow?.end_date ?? null,
      activityTypeName: r.activity_type_id
        ? activityNameById.get(r.activity_type_id) ?? null
        : null,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// 생성(화면 2) — 주차 전체(activityTypeIds=null) 또는 특정 라인들.
// 같은 (week_id, activity_type_id) 행이 이미 있으면 is_active=true 로 되살린다.
// ─────────────────────────────────────────────────────────────────────────

export async function createLineOpeningWindows(input: {
  weekId: string;
  // null = 해당 주차 전체. 배열 = 특정 활동 유형들(각 1행).
  activityTypeIds: string[] | null;
  createdBy: string | null;
}): Promise<LineOpeningWindowDto[]> {
  const weekRow = await loadWeekRow(input.weekId);

  // 대상 activity_type_id 집합 결정. null 항목 1개 = 전체.
  let targetActivityTypeIds: Array<string | null>;
  if (input.activityTypeIds === null) {
    targetActivityTypeIds = [null];
  } else {
    const uniq = Array.from(new Set(input.activityTypeIds));
    if (uniq.length === 0) {
      throw new LineOpeningWindowError(
        400,
        "특정 라인 허용 시 최소 1개 활동 유형을 선택해주세요",
      );
    }
    // activity_types.id 는 text slug 이므로 형식 검증(UUID) 대신 존재 검증으로 유효성을 보장한다.
    // 실무 정보 클러스터의 활성 활동 유형만 허용.
    const { data: validTypes, error: vErr } = await supabaseAdmin
      .from("activity_types")
      .select("id")
      .eq("cluster_id", "practical_info")
      .eq("is_active", true)
      .in("id", uniq);
    if (vErr) throw new LineOpeningWindowError(500, vErr.message);
    const validSet = new Set(
      ((validTypes ?? []) as Array<{ id: string }>).map((t) => t.id),
    );
    const invalid = uniq.filter((id) => !validSet.has(id));
    if (invalid.length > 0) {
      throw new LineOpeningWindowError(
        400,
        "유효하지 않은 활동 유형이 포함되어 있습니다",
      );
    }
    targetActivityTypeIds = uniq;
  }

  const results: LineOpeningWindowDto[] = [];
  for (const activityTypeId of targetActivityTypeIds) {
    // 기존 행(active/inactive 무관) 탐색 — 중복 방지 + 재활성.
    const existingQuery = supabaseAdmin
      .from("line_opening_windows")
      .select(
        "id,week_id,activity_type_id,allow_opening,is_active,created_by,created_at,updated_at",
      )
      .eq("week_id", weekRow.id);
    const { data: existingRows, error: exErr } = await (activityTypeId === null
      ? existingQuery.is("activity_type_id", null)
      : existingQuery.eq("activity_type_id", activityTypeId)
    ).limit(1);
    if (exErr) throw new LineOpeningWindowError(500, exErr.message);

    const existing = (existingRows ?? [])[0] as WindowRow | undefined;
    if (existing) {
      // 재활성(이미 활성이면 멱등).
      const { data: updated, error: uErr } = await supabaseAdmin
        .from("line_opening_windows")
        .update({ is_active: true, allow_opening: true })
        .eq("id", existing.id)
        .select(
          "id,week_id,activity_type_id,allow_opening,is_active,created_by,created_at,updated_at",
        )
        .single();
      if (uErr) throw new LineOpeningWindowError(500, uErr.message);
      results.push(rowToBareDto(updated as WindowRow, weekRow));
    } else {
      const { data: inserted, error: iErr } = await supabaseAdmin
        .from("line_opening_windows")
        .insert({
          week_id: weekRow.id,
          activity_type_id: activityTypeId,
          allow_opening: true,
          is_active: true,
          created_by: input.createdBy,
        })
        .select(
          "id,week_id,activity_type_id,allow_opening,is_active,created_by,created_at,updated_at",
        )
        .single();
      if (iErr) throw new LineOpeningWindowError(500, iErr.message);
      results.push(rowToBareDto(inserted as WindowRow, weekRow));
    }
  }
  return results;
}

// 최소 DTO(라벨/이름 조인 없이 — 생성 응답용). 화면은 이후 목록 재조회로 보강.
function rowToBareDto(r: WindowRow, weekRow: WeekRow): LineOpeningWindowDto {
  const labelInfo = weekLabelFromRow(weekRow);
  return {
    id: r.id,
    weekId: r.week_id,
    activityTypeId: r.activity_type_id,
    allowOpening: r.allow_opening,
    isActive: r.is_active,
    createdBy: r.created_by,
    createdByName: null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    weekLabel: labelInfo?.label ?? null,
    weekStart: weekRow.start_date,
    weekEnd: weekRow.end_date,
    activityTypeName: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 활성/비활성 토글 · 삭제
// ─────────────────────────────────────────────────────────────────────────

export async function setLineOpeningWindowActive(
  id: string,
  isActive: boolean,
): Promise<void> {
  if (!isUuid(id)) throw new LineOpeningWindowError(400, "id must be a UUID");
  const { data, error } = await supabaseAdmin
    .from("line_opening_windows")
    .update({ is_active: isActive })
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) throw new LineOpeningWindowError(500, error.message);
  if (!data) throw new LineOpeningWindowError(404, "예외를 찾을 수 없습니다");
}

export async function deleteLineOpeningWindow(id: string): Promise<void> {
  if (!isUuid(id)) throw new LineOpeningWindowError(400, "id must be a UUID");
  const { error } = await supabaseAdmin
    .from("line_opening_windows")
    .delete()
    .eq("id", id);
  if (error) throw new LineOpeningWindowError(500, error.message);
}

// ─────────────────────────────────────────────────────────────────────────
// 예외 등록 폼(화면 2) 주차 옵션 — 현재 주차 N 주변 [-2 … +2].
// 자동 정책은 과거 주차만 다루지만, 예외는 미래/지난 주차 모두 열 수 있어야 하므로
// 양방향으로 제공한다. weeks 테이블에 매칭되는 행만 반환.
// ─────────────────────────────────────────────────────────────────────────

export async function listExceptionWeekFormOptions(
  todayIso: string,
): Promise<ExceptionWeekFormOption[]> {
  const currentWeekStartMs = getCurrentWeekStartMs(todayIso);
  if (currentWeekStartMs == null) return [];

  // 개설 대상(금요일 경계) 주차 시작 — isOpenTarget 표시용. 단일 SoT 함수에서 파생
  //   (중복 계산 금지 — getOpenableWeekStartMs 와 항상 동일).
  const openableWeekStartMs = getOpenableWeekStartMs(todayIso);

  const offsets = [-2, -1, 0, 1, 2]; // 과거 2주 ~ 미래 2주
  const descriptors: Array<{
    weekStartMs: number;
    isCurrent: boolean;
    isOpenTarget: boolean;
    info: NonNullable<ReturnType<typeof describeWeekByStartMs>>;
  }> = [];
  for (const off of offsets) {
    const weekStartMs = currentWeekStartMs + off * 7 * DAY_MS;
    const info = describeWeekByStartMs(weekStartMs);
    if (!info) continue;
    descriptors.push({
      weekStartMs,
      isCurrent: off === 0,
      isOpenTarget: weekStartMs === openableWeekStartMs,
      info,
    });
  }
  if (descriptors.length === 0) return [];

  const orExpr = descriptors
    .map(
      (d) => `and(iso_year.eq.${d.info.isoYear},iso_week.eq.${d.info.isoWeek})`,
    )
    .join(",");
  const { data: weekRows, error } = await supabaseAdmin
    .from("weeks")
    .select(WEEK_SELECT)
    .or(orExpr);
  if (error) throw new LineOpeningWindowError(500, error.message);

  const rowByKey = new Map<string, WeekRow>();
  for (const r of (weekRows ?? []) as WeekRow[]) {
    rowByKey.set(`${r.iso_year}::${r.iso_week}`, r);
  }

  const options: ExceptionWeekFormOption[] = [];
  // 미래→과거 순(15주차, 14주차, 13주차 …)으로 정렬해 보여준다.
  for (const d of [...descriptors].sort((a, b) => b.weekStartMs - a.weekStartMs)) {
    const row = rowByKey.get(`${d.info.isoYear}::${d.info.isoWeek}`);
    if (!row) continue;
    options.push({
      id: row.id,
      label: `${d.info.year}년 ${d.info.seasonName} ${d.info.weekNumber}주차`,
      year: d.info.year,
      seasonName: d.info.seasonName,
      weekNumber: d.info.weekNumber,
      startDate: d.info.weekStart,
      endDate: d.info.weekEnd,
      isCurrent: d.isCurrent,
      isOpenTarget: d.isOpenTarget,
      canOpen: !d.info.isOfficialRest,
    });
  }
  return options;
}

// ─────────────────────────────────────────────────────────────────────────
// 라인 개설 폼(섹션 0) 연동 — 현재 활성 예외가 가리키는 주차 + 허용 라인.
// 같은 주차의 여러 예외 행을 병합: NULL(전체) 1개라도 있으면 allowedActivityTypeIds=null,
// 아니면 특정 활동 유형들의 합집합.
// ─────────────────────────────────────────────────────────────────────────

export async function listActiveExceptionWeeks(): Promise<ActiveExceptionWeek[]> {
  const { data, error } = await supabaseAdmin
    .from("line_opening_windows")
    .select("week_id,activity_type_id")
    .eq("is_active", true)
    .eq("allow_opening", true);
  if (error) throw new LineOpeningWindowError(500, error.message);
  const rows = (data ?? []) as Array<{
    week_id: string;
    activity_type_id: string | null;
  }>;
  if (rows.length === 0) return [];

  // 주차별 병합.
  const byWeek = new Map<
    string,
    { hasAll: boolean; activityTypeIds: Set<string> }
  >();
  for (const r of rows) {
    const entry = byWeek.get(r.week_id) ?? {
      hasAll: false,
      activityTypeIds: new Set<string>(),
    };
    if (r.activity_type_id === null) entry.hasAll = true;
    else entry.activityTypeIds.add(r.activity_type_id);
    byWeek.set(r.week_id, entry);
  }

  const weekIds = Array.from(byWeek.keys());
  const { data: weeks, error: wErr } = await supabaseAdmin
    .from("weeks")
    .select(WEEK_SELECT)
    .in("id", weekIds);
  if (wErr) throw new LineOpeningWindowError(500, wErr.message);
  const weekRowById = new Map<string, WeekRow>();
  for (const w of (weeks ?? []) as WeekRow[]) weekRowById.set(w.id, w);

  const result: ActiveExceptionWeek[] = [];
  for (const [weekId, merged] of byWeek) {
    const row = weekRowById.get(weekId);
    if (!row) continue;
    const info = describeWeekByStartMs(toMs(row.start_date));
    if (!info) continue;
    // 예외는 자동 정책(휴식 포함)을 덮어쓴다 → 기입 기간을 항상 산출(휴식이어도).
    const { submissionOpensAt, submissionClosesAt } =
      submissionWindowForWeekStartIso(row.start_date);
    result.push({
      id: row.id,
      year: info.year,
      seasonName: info.seasonName,
      weekNumber: info.weekNumber,
      startDate: info.weekStart,
      endDate: info.weekEnd,
      isOfficialRest: info.isOfficialRest,
      canOpen: true,
      submissionOpensAt,
      submissionClosesAt,
      allowedActivityTypeIds: merged.hasAll
        ? null
        : Array.from(merged.activityTypeIds),
    });
  }
  // 최신 주차 먼저.
  result.sort((a, b) => toMs(b.startDate) - toMs(a.startDate));
  return result;
}

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { describeWeekByStartMs } from "@/lib/cluster4WeekPolicy";
import { markWeeklyCardsSnapshotStaleMany } from "@/lib/cluster4WeeklyCardsSnapshot";
import {
  matchOfficialRestPeriods,
  resolveOfficialRest,
  type DateRange,
  type OfficialRestPeriodDto,
  type OfficialRestPeriodType,
  type OfficialRestPeriodUpsertInput,
  type OfficialRestSource,
} from "@/lib/officialRestPeriodsTypes";

// /admin/official-rest-periods 전용 server-only 데이터 레이어.
// canonical 테이블: public.official_rest_periods.
// 권한: read 는 ADMIN_READ_ROLES 게이트, write 는 admin_users.role='owner' 게이트.
// 본 모듈은 게이트 통과 후 호출된다는 전제로 동작한다(게이트는 API 라우트 책임).

export class OfficialRestPeriodError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "OfficialRestPeriodError";
    this.status = status;
  }
}

type OfficialRestPeriodRow = {
  id: string;
  name: string;
  type: string;
  start_date: string;
  end_date: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string | null;
};

const SELECT =
  "id,name,type,start_date,end_date,description,is_active,created_at,updated_at";

// official_rest_periods 테이블 미생성(마이그레이션 미적용) 상황을 식별.
// 운영자가 SQL 을 나중에 적용하므로, 읽기 경로는 graceful degrade 한다.
export function isMissingRestPeriodsTable(error: {
  code?: string;
  message?: string;
}) {
  const message = error.message ?? "";
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    /official_rest_periods/i.test(message)
  );
}

function toDto(row: OfficialRestPeriodRow): OfficialRestPeriodDto {
  return {
    id: row.id,
    name: row.name,
    type: row.type as OfficialRestPeriodType,
    startDate: row.start_date,
    endDate: row.end_date,
    description: row.description,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// 활성 기간 조회 — 공식 휴식 판정 레이어가 1회 fetch 후 in-memory overlap 계산.
// 테이블 미생성이면 빈 배열(판정에서 date_period 출처가 비활성화될 뿐).
export async function fetchActiveRestPeriods(): Promise<OfficialRestPeriodDto[]> {
  const { data, error } = await supabaseAdmin
    .from("official_rest_periods")
    .select(SELECT)
    .eq("is_active", true)
    .order("start_date", { ascending: true });

  if (error) {
    if (isMissingRestPeriodsTable(error)) return [];
    throw new OfficialRestPeriodError(500, error.message);
  }
  return ((data ?? []) as OfficialRestPeriodRow[]).map(toDto);
}

// ─────────────────────────────────────────────────────────────────────
// 공식 휴식 판정 helper (Cluster4 운영 로직 공용)
//   최종 = seasonCalendar rule(시험기간) OR official_rest_periods 날짜 overlap.
//   weeks.is_official_rest / official_rest_weeks 는 참조하지 않는다.
// ─────────────────────────────────────────────────────────────────────
function isoToMs(iso: string): number {
  return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
}

function addDaysIso(iso: string, days: number): string {
  return new Date(isoToMs(iso) + days * 86_400_000).toISOString().slice(0, 10);
}

// season_rule: 주차 시작일(월요일) 기준 seasonCalendar 규칙(시험기간/transition).
export function isSeasonRuleRestForWeekStart(weekStartIso: string): boolean {
  const descriptor = describeWeekByStartMs(isoToMs(weekStartIso));
  return descriptor?.isOfficialRest ?? false;
}

export type WeekRestResolution = {
  isOfficialRest: boolean;
  sources: OfficialRestSource[];
  matchedPeriods: OfficialRestPeriodDto[];
  seasonRuleRest: boolean;
};

// 단일 주차 공식 휴식 판정. endDate 미지정 시 startDate+6일로 보정.
// periods 미전달 시 활성 official_rest_periods 를 즉시 fetch(루프에서는 prefetch 권장).
export async function resolveWeekOfficialRest(
  week: { startDate: string; endDate?: string | null },
  periods?: readonly OfficialRestPeriodDto[],
): Promise<WeekRestResolution> {
  const activePeriods = periods ?? (await fetchActiveRestPeriods());
  const range: DateRange = {
    startDate: week.startDate,
    endDate: week.endDate ?? addDaysIso(week.startDate, 6),
  };
  const seasonRuleRest = isSeasonRuleRestForWeekStart(range.startDate);
  const matchedPeriods = matchOfficialRestPeriods(range, activePeriods);
  const { isOfficialRest, sources } = resolveOfficialRest({
    seasonRuleRest,
    matchedDatePeriods: matchedPeriods.length,
  });
  return { isOfficialRest, sources, matchedPeriods, seasonRuleRest };
}

export async function listOfficialRestPeriods(opts: {
  includeInactive?: boolean;
} = {}): Promise<OfficialRestPeriodDto[]> {
  let query = supabaseAdmin
    .from("official_rest_periods")
    .select(SELECT)
    .order("start_date", { ascending: false });

  if (!opts.includeInactive) {
    query = query.eq("is_active", true);
  }

  const { data, error } = await query;
  if (error) {
    if (isMissingRestPeriodsTable(error)) {
      throw new OfficialRestPeriodError(
        503,
        "official_rest_periods 테이블이 아직 생성되지 않았습니다. 마이그레이션을 먼저 적용하세요.",
      );
    }
    throw new OfficialRestPeriodError(500, error.message);
  }
  return ((data ?? []) as OfficialRestPeriodRow[]).map(toDto);
}

export async function getOfficialRestPeriod(
  id: string,
): Promise<OfficialRestPeriodDto> {
  if (!isUuid(id)) {
    throw new OfficialRestPeriodError(400, "Invalid id");
  }
  const { data, error } = await supabaseAdmin
    .from("official_rest_periods")
    .select(SELECT)
    .eq("id", id)
    .maybeSingle();

  if (error) throw new OfficialRestPeriodError(500, error.message);
  if (!data) throw new OfficialRestPeriodError(404, "공식 휴식 기간을 찾을 수 없습니다");
  return toDto(data as OfficialRestPeriodRow);
}

// 공식 휴식 기간 변경은 날짜 overlap 으로 다수(전역) 사용자의 카드 판정에 영향을 준다.
// ⚠ 이번 단계(cron 제거)에서는 즉시 전체 recompute 를 하지 않는다(대량 비용). 대신 영향 주차
//   범위에 속한 사용자의 snapshot 을 markStale 만 하고 warning 을 남긴다.
// 수동 재계산(6-C 구현됨): cron 이 제거되어 stale 표시만으로는 자동 재생성되지 않으므로,
//   운영자가 관리자 화면 '영향 대상 재계산' 버튼 또는
//   POST /api/admin/cluster4/recompute-official-rest-snapshots 로 재계산한다.
async function markOfficialRestAffectedSnapshotsStale(
  startDate: string,
  endDate: string,
  reason: "create" | "update" | "delete",
): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin
      .from("user_week_statuses")
      .select("user_id")
      .gte("week_start_date", startDate)
      .lte("week_start_date", endDate);
    if (error) {
      console.warn("[official-rest-periods] affected scan failed", {
        reason,
        message: error.message,
      });
      return;
    }
    const userIds = Array.from(
      new Set(((data ?? []) as { user_id: string }[]).map((r) => r.user_id)),
    );
    if (userIds.length === 0) return;
    await markWeeklyCardsSnapshotStaleMany(userIds);
    console.warn(
      `[official-rest-periods] ${reason}: 영향 사용자 ${userIds.length}명 snapshot 을 stale 처리함. ` +
        `cron 제거됨 → 자동 재생성 안 됨. 관리자 화면 '영향 대상 재계산' 버튼 또는 ` +
        `POST /api/admin/cluster4/recompute-official-rest-snapshots ` +
        `(start_date=${startDate}, end_date=${endDate}) 로 수동 재계산하세요.`,
    );
  } catch (e) {
    console.warn("[official-rest-periods] markAffected stale failed (non-fatal)", {
      reason,
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

export async function createOfficialRestPeriod(
  input: OfficialRestPeriodUpsertInput,
): Promise<OfficialRestPeriodDto> {
  const { data, error } = await supabaseAdmin
    .from("official_rest_periods")
    .insert({
      name: input.name,
      type: input.type,
      start_date: input.startDate,
      end_date: input.endDate,
      description: input.description,
      is_active: input.isActive,
    })
    .select(SELECT)
    .single();

  if (error) throw mapWriteError(error);
  const dto = toDto(data as OfficialRestPeriodRow);
  await markOfficialRestAffectedSnapshotsStale(dto.startDate, dto.endDate, "create");
  return dto;
}

export async function updateOfficialRestPeriod(
  id: string,
  patch: Partial<OfficialRestPeriodUpsertInput>,
): Promise<OfficialRestPeriodDto> {
  if (!isUuid(id)) {
    throw new OfficialRestPeriodError(400, "Invalid id");
  }

  const update: Record<string, unknown> = {};
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.type !== undefined) update.type = patch.type;
  if (patch.startDate !== undefined) update.start_date = patch.startDate;
  if (patch.endDate !== undefined) update.end_date = patch.endDate;
  if (patch.description !== undefined) update.description = patch.description;
  if (patch.isActive !== undefined) update.is_active = patch.isActive;

  if (Object.keys(update).length === 0) {
    throw new OfficialRestPeriodError(400, "No updatable fields provided");
  }

  const { data, error } = await supabaseAdmin
    .from("official_rest_periods")
    .update(update)
    .eq("id", id)
    .select(SELECT)
    .maybeSingle();

  if (error) throw mapWriteError(error);
  if (!data) throw new OfficialRestPeriodError(404, "공식 휴식 기간을 찾을 수 없습니다");
  const dto = toDto(data as OfficialRestPeriodRow);
  // 갱신된 범위 기준 영향 대상 markStale. (날짜를 옮긴 경우 옛 범위 사용자는 누락될 수 있으므로
  //  TODO(6-C) 수동 재계산 시 전체 범위를 함께 처리할 것.)
  await markOfficialRestAffectedSnapshotsStale(dto.startDate, dto.endDate, "update");
  return dto;
}

export async function deleteOfficialRestPeriod(id: string): Promise<void> {
  if (!isUuid(id)) {
    throw new OfficialRestPeriodError(400, "Invalid id");
  }
  // 삭제 전 날짜 범위 확보(영향 대상 markStale 용).
  const { data: existing } = await supabaseAdmin
    .from("official_rest_periods")
    .select("start_date,end_date")
    .eq("id", id)
    .maybeSingle();
  const { error } = await supabaseAdmin
    .from("official_rest_periods")
    .delete()
    .eq("id", id);
  if (error) throw new OfficialRestPeriodError(500, error.message);
  const row = existing as { start_date: string; end_date: string } | null;
  if (row) {
    await markOfficialRestAffectedSnapshotsStale(row.start_date, row.end_date, "delete");
  }
}

// CHECK 제약(date 순서/type) 위반 등은 400 으로 안내, 그 외는 그대로 500.
function mapWriteError(error: {
  code?: string;
  message?: string;
}): OfficialRestPeriodError {
  if (isMissingRestPeriodsTable(error)) {
    return new OfficialRestPeriodError(
      503,
      "official_rest_periods 테이블이 아직 생성되지 않았습니다. 마이그레이션을 먼저 적용하세요.",
    );
  }
  // 23514 = check_violation
  if (error.code === "23514") {
    return new OfficialRestPeriodError(
      400,
      "제약 조건 위반: end_date >= start_date 이고 type 이 허용값이어야 합니다.",
    );
  }
  return new OfficialRestPeriodError(500, error.message ?? "write failed");
}

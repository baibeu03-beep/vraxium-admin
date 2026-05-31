import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import {
  isEditableResourceKey,
  isWeekScopedResourceKey,
  type EditWindowDto,
  type EditWindowUserRow,
  type ListEditWindowsResult,
  type WeekOption,
} from "@/lib/adminEditWindowsTypes";

// /admin/settings/edit-windows 전용 server-only 데이터 레이어.
// canonical 테이블: public.user_edit_windows.
//   - 비주간 자원: (user_id, resource_key) 단위 1행, week_id = NULL (전역 권한).
//   - 주간 자원(주간 회고/동료/평판): (user_id, resource_key, week_id) 단위 1행.
//     "이 사용자가 이 주차의 이 활동을 수정할 수 있는가?" 는 항상 week_id 를 포함해
//     판정한다. (정책: 주차 필수 — 기간만으로 전 주차를 열지 않는다.)

export class EditWindowError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "EditWindowError";
    this.status = status;
  }
}

type EditWindowRow = {
  id: string;
  user_id: string;
  resource_key: string;
  week_id: string | null;
  season_key: string | null;
  opened_at: string;
  expires_at: string;
  granted_by: string | null;
  note: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type AdminUserRow = {
  id: string;
  email: string | null;
};

type UserProfileRow = {
  user_id: string;
  display_name: string | null;
  auth_email: string | null;
  contact_email: string | null;
  organization_slug: string | null;
};

const WINDOW_SELECT =
  "id,user_id,resource_key,week_id,season_key,opened_at,expires_at,granted_by,note,created_at,updated_at";

const PROFILE_SELECT =
  "user_id,display_name,auth_email,contact_email,organization_slug";

function toDto(row: EditWindowRow): EditWindowDto {
  return {
    id: row.id,
    userId: row.user_id,
    resourceKey: row.resource_key,
    weekId: row.week_id,
    seasonKey: row.season_key,
    openedAt: row.opened_at,
    expiresAt: row.expires_at,
    grantedBy: row.granted_by,
    grantedByEmail: null,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function escapeForIlike(value: string) {
  return value.replace(/[%_,()]/g, "").trim();
}

// ─────────────────────────────────────────────────────────────────────────
// 주차 컨텍스트 — week_id 유효성 검증 + season_key 파생.
// 주간 자원의 권한을 열거나 판정할 때 week_id 가 실제 weeks 행을 가리키는지 확인하고,
// 비정규화 저장할 season_key 를 가져온다.
// ─────────────────────────────────────────────────────────────────────────

type WeekContext = { weekId: string; seasonKey: string | null };

async function resolveWeekContext(weekId: string): Promise<WeekContext> {
  if (!isUuid(weekId)) {
    throw new EditWindowError(400, "week_id must be a UUID");
  }
  const { data, error } = await supabaseAdmin
    .from("weeks")
    .select("id,season_key")
    .eq("id", weekId)
    .maybeSingle();
  if (error) {
    throw new EditWindowError(500, error.message);
  }
  if (!data) {
    throw new EditWindowError(404, `week not found: ${weekId}`);
  }
  const row = data as { id: string; season_key: string | null };
  return { weekId: row.id, seasonKey: row.season_key ?? null };
}

// resource_key + 입력 week_id 를 정책에 맞게 정규화한다.
//   - 주간 자원: week_id 필수. 유효성 검증 + season_key 파생.
//   - 비주간 자원: week_id 는 항상 null 로 강제 (입력값 무시).
async function normalizeWeekScope(
  resourceKey: string,
  weekId: string | null | undefined,
): Promise<{ weekId: string | null; seasonKey: string | null }> {
  if (isWeekScopedResourceKey(resourceKey)) {
    if (!weekId) {
      throw new EditWindowError(
        400,
        `week_id is required for week-scoped resource: ${resourceKey}`,
      );
    }
    const ctx = await resolveWeekContext(weekId);
    return { weekId: ctx.weekId, seasonKey: ctx.seasonKey };
  }
  return { weekId: null, seasonKey: null };
}

// week_id 스코프에 맞는 .eq / .is 필터를 적용한다.
function applyWeekScope<
  T extends {
    eq: (col: string, value: string) => T;
    is: (col: string, value: null) => T;
  },
>(builder: T, weekId: string | null): T {
  return weekId == null
    ? builder.is("week_id", null)
    : builder.eq("week_id", weekId);
}

// ─────────────────────────────────────────────────────────────────────────
// LIST: 검색어 + resource_key (+ 주간이면 week_id) 로 사용자 목록을 가져오면서,
// 같은 스코프의 edit-window 가 있으면 붙여 반환한다.
// ─────────────────────────────────────────────────────────────────────────

export type ListEditWindowsOptions = {
  query?: string | null;
  resourceKey: string;
  weekId?: string | null;
  limit?: number;
  offset?: number;
};

function applyProfileFilters<T extends { or: (s: string) => T }>(
  queryBuilder: T,
  rawQuery: string,
): T {
  const trimmed = rawQuery ? escapeForIlike(rawQuery) : "";
  const filters = [
    ...(trimmed
      ? [
          `display_name.ilike.%${trimmed}%`,
          `auth_email.ilike.%${trimmed}%`,
          `contact_email.ilike.%${trimmed}%`,
          `organization_slug.ilike.%${trimmed}%`,
        ]
      : []),
    ...(isUuid(rawQuery) ? [`user_id.eq.${rawQuery}`] : []),
  ];
  if (filters.length === 0) return queryBuilder;
  return queryBuilder.or(filters.join(","));
}

export async function listEditWindowsWithUsers(
  options: ListEditWindowsOptions,
): Promise<ListEditWindowsResult> {
  if (!isEditableResourceKey(options.resourceKey)) {
    throw new EditWindowError(
      400,
      `Unknown resource_key: ${options.resourceKey}`,
    );
  }

  // 주간 자원이면 week_id 가 있어야 한다 — 없으면 빈 결과(주차 미선택) 로 안내.
  const weekScoped = isWeekScopedResourceKey(options.resourceKey);
  const weekId = options.weekId ?? null;

  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);

  let queryBuilder = supabaseAdmin
    .from("user_profiles")
    .select(PROFILE_SELECT, { count: "exact" });

  const rawQuery = options.query?.trim() ?? "";
  queryBuilder = applyProfileFilters(queryBuilder, rawQuery);

  queryBuilder = queryBuilder
    .order("display_name", { ascending: true, nullsFirst: false })
    .order("user_id", { ascending: true })
    .range(offset, offset + limit - 1);

  const { data, error, count } = await queryBuilder;
  if (error) {
    throw new EditWindowError(500, error.message);
  }

  const profiles = (data ?? []) as unknown as UserProfileRow[];
  const userIds = profiles.map((p) => p.user_id);

  // 주간 자원인데 주차 미선택이면 window 를 붙이지 않는다 (사용자 목록만 노출).
  const windowsByUser = new Map<string, EditWindowRow>();
  if (userIds.length > 0 && !(weekScoped && !weekId)) {
    let winQuery = supabaseAdmin
      .from("user_edit_windows")
      .select(WINDOW_SELECT)
      .eq("resource_key", options.resourceKey)
      .in("user_id", userIds);
    winQuery = applyWeekScope(winQuery, weekScoped ? weekId : null);
    const { data: winData, error: winError } = await winQuery;
    if (winError) {
      throw new EditWindowError(500, winError.message);
    }
    for (const row of (winData ?? []) as unknown as EditWindowRow[]) {
      windowsByUser.set(row.user_id, row);
    }
  }

  const grantedByIds = Array.from(
    new Set(
      Array.from(windowsByUser.values())
        .map((row) => row.granted_by)
        .filter((value): value is string => Boolean(value)),
    ),
  );
  const adminEmailById = new Map<string, string | null>();
  if (grantedByIds.length > 0) {
    const { data: adminRows, error: adminError } = await supabaseAdmin
      .from("admin_users")
      .select("id,email")
      .in("id", grantedByIds);
    if (adminError) {
      throw new EditWindowError(500, adminError.message);
    }
    for (const row of (adminRows ?? []) as unknown as AdminUserRow[]) {
      adminEmailById.set(row.id, row.email);
    }
  }

  const rows: EditWindowUserRow[] = profiles.map((p) => ({
    userId: p.user_id,
    displayName: p.display_name,
    authEmail: p.auth_email,
    contactEmail: p.contact_email,
    organizationSlug: p.organization_slug,
    window: windowsByUser.has(p.user_id)
      ? {
          ...toDto(windowsByUser.get(p.user_id)!),
          grantedByEmail:
            adminEmailById.get(windowsByUser.get(p.user_id)!.granted_by ?? "") ??
            null,
        }
      : null,
  }));

  return {
    resourceKey: options.resourceKey,
    rows,
    total: count ?? 0,
    limit,
    offset,
  };
}

export async function listMatchingEditWindowUserIds(options: {
  query?: string | null;
  resourceKey: string;
  max?: number;
}): Promise<string[]> {
  if (!isEditableResourceKey(options.resourceKey)) {
    throw new EditWindowError(
      400,
      `Unknown resource_key: ${options.resourceKey}`,
    );
  }

  const max = Math.min(Math.max(options.max ?? 5000, 1), 10000);
  let queryBuilder = supabaseAdmin
    .from("user_profiles")
    .select("user_id")
    .order("display_name", { ascending: true, nullsFirst: false })
    .order("user_id", { ascending: true })
    .range(0, max - 1);

  queryBuilder = applyProfileFilters(queryBuilder, options.query?.trim() ?? "");

  const { data, error } = await queryBuilder;
  if (error) {
    throw new EditWindowError(500, error.message);
  }

  return ((data ?? []) as Array<{ user_id: string }>).map((row) => row.user_id);
}

// ─────────────────────────────────────────────────────────────────────────
// 주차 목록 — admin 주차 선택 드롭다운용. weeks ⨝ season_definitions.
// ─────────────────────────────────────────────────────────────────────────

const SEASON_TYPE_KO: Record<string, string> = {
  spring: "봄",
  summer: "여름",
  autumn: "가을",
  winter: "겨울",
};

type WeekRow = {
  id: string;
  week_number: number | null;
  season_key: string | null;
  start_date: string | null;
  end_date: string | null;
};

type SeasonDefRow = {
  season_key: string;
  season_label: string | null;
  season_type: string | null;
  year: number | null;
};

function buildWeekLabel(
  week: WeekRow,
  season: SeasonDefRow | undefined,
): string {
  const weekPart = week.week_number != null ? `${week.week_number}주차` : "주차?";
  if (season) {
    const ko = season.season_type
      ? SEASON_TYPE_KO[season.season_type] ?? null
      : null;
    if (season.year != null && ko) return `${season.year} ${ko} 시즌 ${weekPart}`;
    if (ko) return `${ko} 시즌 ${weekPart}`;
    if (season.season_label) return `${season.season_label} ${weekPart}`;
  }
  if (week.season_key) return `${week.season_key} ${weekPart}`;
  return weekPart;
}

export async function listWeekOptions(): Promise<WeekOption[]> {
  const { data: weekData, error: weekError } = await supabaseAdmin
    .from("weeks")
    .select("id,week_number,season_key,start_date,end_date")
    .not("week_number", "is", null)
    .order("start_date", { ascending: false, nullsFirst: false })
    .limit(600);
  if (weekError) {
    throw new EditWindowError(500, weekError.message);
  }
  const weeks = (weekData ?? []) as unknown as WeekRow[];

  const seasonKeys = Array.from(
    new Set(
      weeks
        .map((w) => w.season_key)
        .filter((k): k is string => Boolean(k)),
    ),
  );
  const seasonByKey = new Map<string, SeasonDefRow>();
  if (seasonKeys.length > 0) {
    const { data: seasonData, error: seasonError } = await supabaseAdmin
      .from("season_definitions")
      .select("season_key,season_label,season_type,year")
      .in("season_key", seasonKeys);
    if (seasonError) {
      throw new EditWindowError(500, seasonError.message);
    }
    for (const row of (seasonData ?? []) as unknown as SeasonDefRow[]) {
      seasonByKey.set(row.season_key, row);
    }
  }

  return weeks.map((week) => {
    const season = week.season_key
      ? seasonByKey.get(week.season_key)
      : undefined;
    return {
      weekId: week.id,
      seasonKey: week.season_key,
      seasonLabel: season?.season_label ?? null,
      weekNumber: week.week_number,
      startDate: week.start_date,
      endDate: week.end_date,
      label: buildWeekLabel(week, season),
    } satisfies WeekOption;
  });
}

// ─────────────────────────────────────────────────────────────────────────
// 단일 (user_id, resource_key, week_id) 스코프 write — select 후 update/insert.
// 부분 unique index 와 supabase upsert onConflict 추론이 잘 맞지 않으므로
// (NULL week 행 / 부분 인덱스) 명시적 select→write 로 처리한다.
// ─────────────────────────────────────────────────────────────────────────

async function writeWindow(input: {
  userId: string;
  resourceKey: string;
  weekId: string | null;
  seasonKey: string | null;
  openedAt: Date;
  expiresAt: Date;
  note: string | null;
  grantedBy: string | null;
}): Promise<EditWindowDto> {
  const nowIso = new Date().toISOString();

  let findQuery = supabaseAdmin
    .from("user_edit_windows")
    .select("id")
    .eq("user_id", input.userId)
    .eq("resource_key", input.resourceKey);
  findQuery = applyWeekScope(findQuery, input.weekId);
  const { data: existing, error: findError } = await findQuery.maybeSingle();
  if (findError) {
    throw new EditWindowError(500, findError.message);
  }

  if (existing) {
    const { data, error } = await supabaseAdmin
      .from("user_edit_windows")
      .update({
        season_key: input.seasonKey,
        opened_at: input.openedAt.toISOString(),
        expires_at: input.expiresAt.toISOString(),
        note: input.note,
        granted_by: input.grantedBy,
        updated_at: nowIso,
      })
      .eq("id", (existing as { id: string }).id)
      .select(WINDOW_SELECT)
      .single();
    if (error || !data) {
      throw new EditWindowError(
        500,
        error?.message ?? "Failed to update user_edit_windows",
      );
    }
    return toDto(data as unknown as EditWindowRow);
  }

  const { data, error } = await supabaseAdmin
    .from("user_edit_windows")
    .insert({
      user_id: input.userId,
      resource_key: input.resourceKey,
      week_id: input.weekId,
      season_key: input.seasonKey,
      opened_at: input.openedAt.toISOString(),
      expires_at: input.expiresAt.toISOString(),
      note: input.note,
      granted_by: input.grantedBy,
      updated_at: nowIso,
    })
    .select(WINDOW_SELECT)
    .single();
  if (error || !data) {
    throw new EditWindowError(
      500,
      error?.message ?? "Failed to insert user_edit_windows",
    );
  }
  return toDto(data as unknown as EditWindowRow);
}

// ─────────────────────────────────────────────────────────────────────────
// UPSERT: 한 사용자 X 한 resource_key (+ 주간이면 week_id) 의 window 를 열거나 갱신.
// ─────────────────────────────────────────────────────────────────────────

export type UpsertEditWindowInput = {
  userId: string;
  resourceKey: string;
  weekId?: string | null;
  openedAt: Date;
  expiresAt: Date;
  note: string | null;
  grantedBy: string | null;
};

function assertValidWindowDates(openedAt: Date, expiresAt: Date) {
  if (Number.isNaN(openedAt.getTime()) || Number.isNaN(expiresAt.getTime())) {
    throw new EditWindowError(400, "opened_at / expires_at must be valid dates");
  }
  if (expiresAt.getTime() <= openedAt.getTime()) {
    throw new EditWindowError(400, "expires_at must be after opened_at");
  }
}

export async function upsertEditWindow(
  input: UpsertEditWindowInput,
): Promise<EditWindowDto> {
  if (!isUuid(input.userId)) {
    throw new EditWindowError(400, "user_id must be a UUID");
  }
  if (!isEditableResourceKey(input.resourceKey)) {
    throw new EditWindowError(400, `Unknown resource_key: ${input.resourceKey}`);
  }
  assertValidWindowDates(input.openedAt, input.expiresAt);

  const scope = await normalizeWeekScope(input.resourceKey, input.weekId);

  // user_profiles 존재 확인 (FK 위반 시 친절한 메시지를 위해).
  const { data: profile, error: profileError } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id")
    .eq("user_id", input.userId)
    .maybeSingle();
  if (profileError) {
    throw new EditWindowError(500, profileError.message);
  }
  if (!profile) {
    throw new EditWindowError(404, "user_profile not found");
  }

  return writeWindow({
    userId: input.userId,
    resourceKey: input.resourceKey,
    weekId: scope.weekId,
    seasonKey: scope.seasonKey,
    openedAt: input.openedAt,
    expiresAt: input.expiresAt,
    note: input.note,
    grantedBy: input.grantedBy,
  });
}

export async function upsertEditWindowsBulk(input: {
  userIds: string[];
  resourceKey: string;
  weekId?: string | null;
  openedAt: Date;
  expiresAt: Date;
  note: string | null;
  grantedBy: string | null;
}): Promise<EditWindowDto[]> {
  const userIds = Array.from(new Set(input.userIds));
  if (userIds.length === 0) return [];
  if (userIds.some((userId) => !isUuid(userId))) {
    throw new EditWindowError(400, "Every user_id must be a UUID");
  }
  if (!isEditableResourceKey(input.resourceKey)) {
    throw new EditWindowError(400, `Unknown resource_key: ${input.resourceKey}`);
  }
  assertValidWindowDates(input.openedAt, input.expiresAt);

  const scope = await normalizeWeekScope(input.resourceKey, input.weekId);

  const { data: profiles, error: profileError } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id")
    .in("user_id", userIds);
  if (profileError) {
    throw new EditWindowError(500, profileError.message);
  }
  const foundIds = new Set(
    ((profiles ?? []) as Array<{ user_id: string }>).map((row) => row.user_id),
  );
  const missing = userIds.filter((userId) => !foundIds.has(userId));
  if (missing.length > 0) {
    throw new EditWindowError(
      404,
      `user_profile not found: ${missing.slice(0, 5).join(", ")}`,
    );
  }

  const nowIso = new Date().toISOString();

  // 같은 스코프에 이미 존재하는 행을 한 번에 조회 → update 대상 / insert 대상 분리.
  let findQuery = supabaseAdmin
    .from("user_edit_windows")
    .select("id,user_id")
    .eq("resource_key", input.resourceKey)
    .in("user_id", userIds);
  findQuery = applyWeekScope(findQuery, scope.weekId);
  const { data: existingRows, error: findError } = await findQuery;
  if (findError) {
    throw new EditWindowError(500, findError.message);
  }
  const existingByUser = new Map(
    ((existingRows ?? []) as Array<{ id: string; user_id: string }>).map(
      (row) => [row.user_id, row.id],
    ),
  );

  const sharedValues = {
    season_key: scope.seasonKey,
    opened_at: input.openedAt.toISOString(),
    expires_at: input.expiresAt.toISOString(),
    note: input.note,
    granted_by: input.grantedBy,
    updated_at: nowIso,
  };

  // 1) UPDATE — 모든 대상이 같은 값으로 갱신되므로 단일 statement 로 처리.
  const updateIds = Array.from(existingByUser.values());
  if (updateIds.length > 0) {
    const { error: updateError } = await supabaseAdmin
      .from("user_edit_windows")
      .update(sharedValues)
      .in("id", updateIds);
    if (updateError) {
      throw new EditWindowError(500, updateError.message);
    }
  }

  // 2) INSERT — 신규 사용자만 단일 insert.
  const insertUserIds = userIds.filter((userId) => !existingByUser.has(userId));
  if (insertUserIds.length > 0) {
    const { error: insertError } = await supabaseAdmin
      .from("user_edit_windows")
      .insert(
        insertUserIds.map((userId) => ({
          user_id: userId,
          resource_key: input.resourceKey,
          week_id: scope.weekId,
          ...sharedValues,
        })),
      );
    if (insertError) {
      throw new EditWindowError(500, insertError.message);
    }
  }

  // 최종 상태를 한 번에 다시 읽어 반환.
  let resultQuery = supabaseAdmin
    .from("user_edit_windows")
    .select(WINDOW_SELECT)
    .eq("resource_key", input.resourceKey)
    .in("user_id", userIds);
  resultQuery = applyWeekScope(resultQuery, scope.weekId);
  const { data: resultData, error: resultError } = await resultQuery;
  if (resultError) {
    throw new EditWindowError(500, resultError.message);
  }
  return ((resultData ?? []) as unknown as EditWindowRow[]).map(toDto);
}

// ─────────────────────────────────────────────────────────────────────────
// CLOSE: expires_at = now 로 즉시 만료 처리 (해당 스코프 한정).
// row 가 없으면 noop.
// ─────────────────────────────────────────────────────────────────────────

export async function closeEditWindow(
  userId: string,
  resourceKey: string,
  weekId: string | null = null,
): Promise<EditWindowDto | null> {
  if (!isUuid(userId)) {
    throw new EditWindowError(400, "user_id must be a UUID");
  }
  if (!isEditableResourceKey(resourceKey)) {
    throw new EditWindowError(400, `Unknown resource_key: ${resourceKey}`);
  }
  const scope = await normalizeWeekScope(resourceKey, weekId);

  const now = new Date().toISOString();
  let updateQuery = supabaseAdmin
    .from("user_edit_windows")
    .update({ expires_at: now, updated_at: now })
    .eq("user_id", userId)
    .eq("resource_key", resourceKey);
  updateQuery = applyWeekScope(updateQuery, scope.weekId);

  const { data, error } = await updateQuery.select(WINDOW_SELECT).maybeSingle();
  if (error) {
    throw new EditWindowError(500, error.message);
  }
  if (!data) return null;
  return toDto(data as unknown as EditWindowRow);
}

export async function closeEditWindowsBulk(
  userIdsInput: string[],
  resourceKey: string,
  weekId: string | null = null,
): Promise<EditWindowDto[]> {
  const userIds = Array.from(new Set(userIdsInput));
  if (userIds.length === 0) return [];
  if (userIds.some((userId) => !isUuid(userId))) {
    throw new EditWindowError(400, "Every user_id must be a UUID");
  }
  if (!isEditableResourceKey(resourceKey)) {
    throw new EditWindowError(400, `Unknown resource_key: ${resourceKey}`);
  }
  const scope = await normalizeWeekScope(resourceKey, weekId);

  const now = new Date().toISOString();
  let updateQuery = supabaseAdmin
    .from("user_edit_windows")
    .update({ expires_at: now, updated_at: now })
    .eq("resource_key", resourceKey)
    .in("user_id", userIds);
  updateQuery = applyWeekScope(updateQuery, scope.weekId);

  const { data, error } = await updateQuery.select(WINDOW_SELECT);
  if (error) {
    throw new EditWindowError(500, error.message);
  }
  return ((data ?? []) as unknown as EditWindowRow[]).map(toDto);
}

// ─────────────────────────────────────────────────────────────────────────
// 단일 사용자 + resource (+ 주간이면 week_id) 조회 — 사용자 앱(Front repo)이
// "현재 이 사용자가 이 주차의 이 활동을 수정할 수 있나?" 를 판정할 때 사용.
// ─────────────────────────────────────────────────────────────────────────

export async function getEditWindowForUser(
  userId: string,
  resourceKey: string,
  weekId: string | null = null,
): Promise<EditWindowDto | null> {
  if (!isUuid(userId)) return null;
  if (!isEditableResourceKey(resourceKey)) return null;

  // 주간 자원인데 week_id 가 없으면 매칭할 행이 없다 (정책: 주차 필수).
  if (isWeekScopedResourceKey(resourceKey) && !weekId) return null;
  const effectiveWeekId = isWeekScopedResourceKey(resourceKey) ? weekId : null;

  let query = supabaseAdmin
    .from("user_edit_windows")
    .select(WINDOW_SELECT)
    .eq("user_id", userId)
    .eq("resource_key", resourceKey);
  query = applyWeekScope(query, effectiveWeekId);

  const { data, error } = await query.maybeSingle();
  if (error) {
    throw new EditWindowError(500, error.message);
  }
  if (!data) return null;
  return toDto(data as unknown as EditWindowRow);
}

export function isWindowActive(
  window: EditWindowDto | null,
  now: Date = new Date(),
): boolean {
  if (!window) return false;
  const opened = new Date(window.openedAt);
  const expires = new Date(window.expiresAt);
  if (Number.isNaN(opened.getTime()) || Number.isNaN(expires.getTime())) {
    return false;
  }
  return now >= opened && now <= expires;
}

export type EditWindowPermissionReason =
  | "open"
  | "not_granted"
  | "not_started"
  | "expired"
  | "admin"
  | "week_required";

export type EditWindowPermission = {
  resourceKey: string;
  weekId: string | null;
  canEdit: boolean;
  reason: EditWindowPermissionReason;
  openedAt: string | null;
  expiresAt: string | null;
};

// 권한 판정. window 는 호출자가 (user_id, resource_key, week_id) 스코프로 이미
// 조회해 넘긴다. 주간 자원인데 week_id 가 없으면 "week_required" 로 막는다.
export function evaluateEditWindowPermission(
  resourceKey: string,
  window: EditWindowDto | null,
  options: {
    isAdmin?: boolean;
    now?: Date;
    requiresWeek?: boolean;
    weekId?: string | null;
  } = {},
): EditWindowPermission {
  const weekId = options.weekId ?? window?.weekId ?? null;

  if (options.isAdmin) {
    return {
      resourceKey,
      weekId,
      canEdit: true,
      reason: "admin",
      openedAt: window?.openedAt ?? null,
      expiresAt: window?.expiresAt ?? null,
    };
  }

  // 주간 자원인데 어느 주차인지 지정되지 않으면 판정 불가 — 전 주차를 열지 않는다.
  if (options.requiresWeek && !options.weekId) {
    return {
      resourceKey,
      weekId: null,
      canEdit: false,
      reason: "week_required",
      openedAt: null,
      expiresAt: null,
    };
  }

  if (!window) {
    return {
      resourceKey,
      weekId,
      canEdit: false,
      reason: "not_granted",
      openedAt: null,
      expiresAt: null,
    };
  }

  const now = options.now ?? new Date();
  const opened = new Date(window.openedAt);
  const expires = new Date(window.expiresAt);
  if (Number.isNaN(opened.getTime()) || Number.isNaN(expires.getTime())) {
    return {
      resourceKey,
      weekId,
      canEdit: false,
      reason: "not_granted",
      openedAt: window.openedAt,
      expiresAt: window.expiresAt,
    };
  }
  if (now < opened) {
    return {
      resourceKey,
      weekId,
      canEdit: false,
      reason: "not_started",
      openedAt: window.openedAt,
      expiresAt: window.expiresAt,
    };
  }
  if (now > expires) {
    return {
      resourceKey,
      weekId,
      canEdit: false,
      reason: "expired",
      openedAt: window.openedAt,
      expiresAt: window.expiresAt,
    };
  }

  return {
    resourceKey,
    weekId,
    canEdit: true,
    reason: "open",
    openedAt: window.openedAt,
    expiresAt: window.expiresAt,
  };
}

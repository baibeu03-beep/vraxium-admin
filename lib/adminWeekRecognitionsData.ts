// Server-only data layer for the admin "주차 인정 결과" 조회 화면.
//
// 조회 전용(read-only). 기준 테이블은 user_week_statuses 이고, weeks 를
// (iso_year, iso_week) 로 매칭해 시즌/주차 메타를 붙이고 user_profiles 로 이름/조직을
// 붙인다. 기존 계산 로직(성장 지표/승인 주차 등)은 일절 변경하지 않는다.
//
// 필터:
//   - status            : user_week_statuses.status 직접 매칭(DB).
//   - week_id           : weeks 1건 → 해당 (iso_year, iso_week) 로 매칭(DB).
//   - season_key        : season_definitions 날짜창(week_start_date 범위)으로 매칭(DB).
//                         날짜창이 없으면 해당 시즌 weeks 의 iso 집합으로 in-memory 폴백.
//   - organization_slug : user_profiles 에서 user_id 집합을 먼저 좁힘.
//   - search            : user_profiles.display_name ilike.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isTransitionWeekStart } from "@/lib/seasonCalendar";
import { isWeekRecognitionStatus } from "@/lib/adminWeekRecognitionsTypes";
import type {
  WeekRecognitionFilterOptions,
  WeekRecognitionRow,
  WeekRecognitionsDto,
  WeekRecognitionUpdateInput,
  WeekRecognitionUpdateResult,
  WeekRecognitionUpdatedRow,
  WeekResultPublishResult,
} from "@/lib/adminWeekRecognitionsTypes";
import { recalcUserGrowthStats } from "@/lib/userGrowthStatsData";

// 안전 상한. 앱 규모상 충분하지만 무한정 로드를 막기 위해 캡을 둔다.
const MAX_ROWS = 5000;

type SeasonDefinitionRow = {
  season_key: string;
  season_label: string | null;
  season_type: string | null;
  start_date: string | null;
  end_date: string | null;
};

type WeekRow = {
  id: string;
  season_key: string | null;
  week_number: number | null;
  start_date: string | null;
  end_date: string | null;
  iso_year: number | null;
  iso_week: number | null;
  result_published_at: string | null;
};

type UserWeekStatusRow = {
  id: string;
  user_id: string;
  year: number | null;
  week_number: number | null;
  week_start_date: string | null;
  status: string;
  is_official_rest_override: boolean | null;
  note: string | null;
  updated_at: string | null;
};

type ProfileRow = {
  user_id: string;
  display_name: string | null;
  organization_slug: string | null;
};

const SEASON_TYPE_LABEL: Record<string, string> = {
  spring: "봄 시즌",
  summer: "여름 시즌",
  autumn: "가을 시즌",
  winter: "겨울 시즌",
};

function seasonName(season: SeasonDefinitionRow): string {
  return (
    season.season_label ??
    (season.season_type ? SEASON_TYPE_LABEL[season.season_type] : null) ??
    season.season_key
  );
}

function isoKey(year: number | null, week: number | null): string | null {
  if (year == null || week == null) return null;
  return `${year}::${week}`;
}

function weekLabelOf(week: WeekRow | null, fallbackIsoWeek: number | null) {
  if (week?.week_number != null) return `${week.week_number}주차`;
  if (fallbackIsoWeek != null) return `${fallbackIsoWeek}주(ISO)`;
  return "주차 미지정";
}

export async function getWeekRecognitions(
  options: WeekRecognitionFilterOptions,
): Promise<WeekRecognitionsDto> {
  const seasonKey = options.seasonKey?.trim() || null;
  const weekId = options.weekId?.trim() || null;
  const organizationSlug = options.organizationSlug?.trim() || null;
  const status = isWeekRecognitionStatus(options.status) ? options.status : null;
  const search = options.search?.trim() || null;

  // 1) 시즌/주차 메타.
  const [seasonRes, weekRes] = await Promise.all([
    supabaseAdmin
      .from("season_definitions")
      .select("season_key,season_label,season_type,start_date,end_date")
      .order("start_date", { ascending: true }),
    supabaseAdmin
      .from("weeks")
      .select("id,season_key,week_number,start_date,end_date,iso_year,iso_week,result_published_at")
      .order("start_date", { ascending: true }),
  ]);

  if (seasonRes.error) throw new Error(seasonRes.error.message);
  if (weekRes.error) throw new Error(weekRes.error.message);

  const seasons = (seasonRes.data ?? []) as SeasonDefinitionRow[];
  const weeks = (weekRes.data ?? []) as WeekRow[];

  const seasonByKey = new Map<string, SeasonDefinitionRow>();
  for (const s of seasons) seasonByKey.set(s.season_key, s);

  const weekByIso = new Map<string, WeekRow>();
  for (const w of weeks) {
    const k = isoKey(w.iso_year, w.iso_week);
    if (k && !weekByIso.has(k)) weekByIso.set(k, w);
  }
  const weekById = new Map<string, WeekRow>();
  for (const w of weeks) weekById.set(w.id, w);

  // 2) week_id / season_key 필터를 (year, week_number) 또는 날짜창으로 변환.
  const targetWeek = weekId ? weekById.get(weekId) ?? null : null;
  // weekId 가 주어졌는데 매칭 weeks 가 없으면 결과 없음.
  if (weekId && !targetWeek) {
    return emptyResult(seasons, weeks);
  }

  const season = seasonKey ? seasonByKey.get(seasonKey) ?? null : null;
  // season_key 가 주어졌는데 정의가 없으면 결과 없음.
  if (seasonKey && !season) {
    return emptyResult(seasons, weeks);
  }

  // season 날짜창이 없을 때만 사용하는 iso 집합 폴백.
  let seasonIsoFallback: Set<string> | null = null;
  if (season && (!season.start_date || !season.end_date)) {
    seasonIsoFallback = new Set(
      weeks
        .filter((w) => w.season_key === season.season_key)
        .map((w) => isoKey(w.iso_year, w.iso_week))
        .filter((k): k is string => Boolean(k)),
    );
  }

  // 3) organization_slug / search 가 있으면 user_id 집합을 먼저 좁힌다.
  let restrictUserIds: string[] | null = null;
  if (organizationSlug || search) {
    let profileQuery = supabaseAdmin
      .from("user_profiles")
      .select("user_id,display_name,organization_slug");
    if (organizationSlug) {
      profileQuery = profileQuery.eq("organization_slug", organizationSlug);
    }
    if (search) {
      profileQuery = profileQuery.ilike("display_name", `%${search}%`);
    }
    const { data, error } = await profileQuery.limit(MAX_ROWS);
    if (error) throw new Error(error.message);
    restrictUserIds = ((data ?? []) as ProfileRow[]).map((p) => p.user_id);
    if (restrictUserIds.length === 0) {
      return emptyResult(seasons, weeks);
    }
  }

  // 4) user_week_statuses 조회 — 가능한 필터는 DB 에서 적용.
  let statusQuery = supabaseAdmin
    .from("user_week_statuses")
    .select(
      "id,user_id,year,week_number,week_start_date,status,is_official_rest_override,note,updated_at",
    )
    .order("week_start_date", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(MAX_ROWS + 1);

  if (status) statusQuery = statusQuery.eq("status", status);

  if (targetWeek) {
    // 특정 주차: 그 주차의 ISO (year, week) 로 한정.
    statusQuery = statusQuery
      .eq("year", targetWeek.iso_year)
      .eq("week_number", targetWeek.iso_week);
  } else if (season && season.start_date && season.end_date) {
    // 시즌 날짜창: week_start_date 가 시즌 기간 안.
    statusQuery = statusQuery
      .gte("week_start_date", season.start_date)
      .lte("week_start_date", season.end_date);
  }

  if (restrictUserIds) {
    statusQuery = statusQuery.in("user_id", restrictUserIds);
  }

  const { data: statusData, error: statusError } = await statusQuery;
  if (statusError) throw new Error(statusError.message);

  let statusRows = (statusData ?? []) as UserWeekStatusRow[];

  // season iso 폴백(날짜창 없는 시즌)일 때 in-memory 로 한정.
  if (seasonIsoFallback) {
    statusRows = statusRows.filter((r) => {
      const k = isoKey(r.year, r.week_number);
      return k != null && seasonIsoFallback!.has(k);
    });
  }

  const truncated = statusRows.length > MAX_ROWS;
  if (truncated) statusRows = statusRows.slice(0, MAX_ROWS);

  // 5) 프로필 조회(이름/조직). 이미 좁힌 경우에도 표시값을 위해 한 번 더 모은다.
  const userIds = Array.from(new Set(statusRows.map((r) => r.user_id)));
  const profileMap = new Map<string, ProfileRow>();
  if (userIds.length > 0) {
    const { data: profData, error: profErr } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id,display_name,organization_slug")
      .in("user_id", userIds);
    if (profErr) throw new Error(profErr.message);
    for (const p of (profData ?? []) as ProfileRow[]) {
      profileMap.set(p.user_id, p);
    }
  }

  // 6) rows 조립.
  const rows: WeekRecognitionRow[] = statusRows.map((uws) => {
    const k = isoKey(uws.year, uws.week_number);
    const week = k ? weekByIso.get(k) ?? null : null;

    let rowSeason: SeasonDefinitionRow | null = null;
    if (week?.season_key) rowSeason = seasonByKey.get(week.season_key) ?? null;
    if (!rowSeason && uws.week_start_date) {
      rowSeason =
        seasons.find(
          (s) =>
            s.start_date != null &&
            s.end_date != null &&
            s.start_date <= uws.week_start_date! &&
            uws.week_start_date! <= s.end_date,
        ) ?? null;
    }

    const profile = profileMap.get(uws.user_id) ?? null;

    return {
      user_week_status_id: uws.id,
      user_id: uws.user_id,
      user_name: profile?.display_name ?? null,
      organization_slug: profile?.organization_slug ?? null,
      season_key: rowSeason?.season_key ?? week?.season_key ?? null,
      season_label: rowSeason ? seasonName(rowSeason) : null,
      week_id: week?.id ?? null,
      week_label: weekLabelOf(week, uws.week_number),
      week_start_date: week?.start_date ?? uws.week_start_date ?? null,
      week_end_date: week?.end_date ?? null,
      status: uws.status,
      is_official_rest_override: uws.is_official_rest_override === true,
      note: uws.note ?? null,
      updated_at: uws.updated_at ?? null,
      week_result_published_at: week?.result_published_at ?? null,
    };
  });

  // 안정 정렬: 주차 시작일 desc → 조직 → 이름.
  rows.sort((a, b) => {
    const aw = a.week_start_date ?? "";
    const bw = b.week_start_date ?? "";
    if (aw !== bw) return aw < bw ? 1 : -1;
    const ao = a.organization_slug ?? "";
    const bo = b.organization_slug ?? "";
    if (ao !== bo) return ao < bo ? -1 : 1;
    const an = a.user_name ?? "";
    const bn = b.user_name ?? "";
    return an < bn ? -1 : an > bn ? 1 : 0;
  });

  // 전환 주차는 인정 집계에서 제외(공식 휴식·성공 어느 카운트에도 포함하지 않음).
  const countedRows = rows.filter(
    (r) => !(r.week_start_date && isTransitionWeekStart(r.week_start_date)),
  );
  const summary = {
    total_count: countedRows.length,
    success_count: countedRows.filter((r) => r.status === "success").length,
    fail_count: countedRows.filter((r) => r.status === "fail").length,
    personal_rest_count: countedRows.filter((r) => r.status === "personal_rest").length,
    official_rest_count: countedRows.filter((r) => r.status === "official_rest").length,
  };

  return {
    rows,
    summary,
    seasons: seasons.map((s) => ({
      season_key: s.season_key,
      season_label: seasonName(s),
    })),
    weeks: weeks.map((w) => ({
      week_id: w.id,
      season_key: w.season_key,
      week_label: weekLabelOf(w, w.iso_week),
      week_start_date: w.start_date,
      week_end_date: w.end_date,
      result_published_at: w.result_published_at ?? null,
    })),
    truncated,
    generated_at: new Date().toISOString(),
  };
}

// ─── 단건 상태 수정(PATCH) ───────────────────────────────────────────
//
// user_week_statuses 단일 row 의 status / note / is_official_rest_override 를 수정한 뒤,
// user_growth_stats(approved_weeks/cumulative_weeks) 캐시를 해당 사용자만 재집계한다
// (lib/userGrowthStatsData.recalcUserGrowthStats).
//
// 실패 처리(요구사항 6 결정):
//   status 수정(user_week_statuses)이 SoT 이고 user_growth_stats 는 파생 캐시이므로,
//   재집계가 실패해도 status 수정을 롤백하지 않는다. status 수정은 유지하고
//   recalculation_skipped=true + recalculation_note(warning) 로 알린다.
//   (Supabase JS 는 두 테이블에 걸친 단일 트랜잭션을 보장하지 못하므로, 보상 롤백을
//    시도하면 그 롤백마저 실패해 상태가 더 나빠질 수 있어 warning 방식을 택한다.)

export class WeekRecognitionUpdateError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "WeekRecognitionUpdateError";
    this.status = status;
  }
}

type UpdatedStatusRow = {
  id: string;
  user_id: string;
  year: number | null;
  week_number: number | null;
  week_start_date: string | null;
  status: string;
  is_official_rest_override: boolean | null;
  note: string | null;
  updated_at: string | null;
};

const UPDATED_SELECT =
  "id,user_id,year,week_number,week_start_date,status,is_official_rest_override,note,updated_at";

export async function updateWeekRecognition(
  userWeekStatusId: string,
  input: WeekRecognitionUpdateInput,
): Promise<WeekRecognitionUpdateResult> {
  const id = String(userWeekStatusId ?? "").trim();
  if (!id) {
    throw new WeekRecognitionUpdateError(400, "user_week_status_id is required.");
  }

  // 수정 가능한 필드만 추출(부분 수정). 허용 외 키는 무시.
  const patch: Record<string, unknown> = {};
  if (input.status !== undefined) {
    if (!isWeekRecognitionStatus(input.status)) {
      throw new WeekRecognitionUpdateError(
        400,
        `Unknown status: ${String(input.status)}`,
      );
    }
    patch.status = input.status;
  }
  if (input.note !== undefined) {
    patch.note =
      input.note === null ? null : String(input.note);
  }
  if (input.is_official_rest_override !== undefined) {
    if (typeof input.is_official_rest_override !== "boolean") {
      throw new WeekRecognitionUpdateError(
        400,
        "is_official_rest_override must be a boolean.",
      );
    }
    patch.is_official_rest_override = input.is_official_rest_override;
  }

  if (Object.keys(patch).length === 0) {
    throw new WeekRecognitionUpdateError(400, "No updatable fields provided.");
  }

  // 5) 수정 전 기존 row 확인 — 없으면 404.
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("user_week_statuses")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (existingError) {
    throw new WeekRecognitionUpdateError(500, existingError.message);
  }
  if (!existing) {
    throw new WeekRecognitionUpdateError(404, "user_week_statuses row not found.");
  }

  // updated_at 은 DB 트리거(touch_user_week_statuses_updated_at)가 갱신한다.
  const { data: updated, error: updateError } = await supabaseAdmin
    .from("user_week_statuses")
    .update(patch)
    .eq("id", id)
    .select(UPDATED_SELECT)
    .maybeSingle();

  if (updateError) {
    throw new WeekRecognitionUpdateError(500, updateError.message);
  }
  if (!updated) {
    // 업데이트 직후 row 가 사라진 극단 케이스.
    throw new WeekRecognitionUpdateError(404, "user_week_statuses row not found.");
  }

  const row = updated as UpdatedStatusRow;
  const updatedRow: WeekRecognitionUpdatedRow = {
    user_week_status_id: row.id,
    user_id: row.user_id,
    year: row.year ?? null,
    week_number: row.week_number ?? null,
    week_start_date: row.week_start_date ?? null,
    status: row.status,
    is_official_rest_override: row.is_official_rest_override === true,
    note: row.note ?? null,
    updated_at: row.updated_at ?? null,
  };

  // 해당 사용자만 user_growth_stats 재집계. 실패해도 status 수정은 유지(롤백 안 함).
  try {
    const stats = await recalcUserGrowthStats(row.user_id);
    return {
      row: updatedRow,
      recalculation_skipped: false,
      recalculation_note: `user_growth_stats 재집계 완료: approved_weeks=${stats.approved_weeks}, cumulative_weeks=${stats.cumulative_weeks}.`,
      growth_stats: stats,
    };
  } catch (recalcError) {
    const message =
      recalcError instanceof Error ? recalcError.message : String(recalcError);
    console.error("[week-recognitions] user_growth_stats recalc failed", {
      userId: row.user_id,
      message,
    });
    return {
      row: updatedRow,
      recalculation_skipped: true,
      recalculation_note: `상태 수정은 저장되었으나 user_growth_stats 재집계에 실패했습니다: ${message}. approved_weeks/cumulative_weeks 캐시가 실제 값과 어긋날 수 있습니다.`,
      growth_stats: null,
    };
  }
}

// ─── 주차 결과 공표(publish) ──────────────────────────────────────────
//
// weeks.result_published_at 을 now() 로 세팅한다. 이 값이 채워지면 고객 페이지의
// 해당 주차 카드가 "성장(집계 중)"(tallying)에서 user_week_statuses.status 기준
// success(성장 성공)/fail(성장 실패)로 전환된다.
//
// 불변식:
//   - user_week_statuses 는 절대 건드리지 않는다 (status 는 별도 SoT).
//   - result_published_at IS NULL 인 주차만 갱신 (.is("result_published_at", null) 가드).
//     → 이미 공표된 주차는 중복 공표되지 않는다 (멱등 + 공표 취소 미지원 정책 보호).

export class WeekResultPublishError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "WeekResultPublishError";
    this.status = status;
  }
}

type PublishWeekRow = {
  id: string;
  week_number: number | null;
  iso_week: number | null;
  start_date: string | null;
  end_date: string | null;
  result_published_at: string | null;
};

export async function publishWeekResult(
  weekId: string,
): Promise<WeekResultPublishResult> {
  const id = String(weekId ?? "").trim();
  if (!id) {
    throw new WeekResultPublishError(400, "week_id is required.");
  }

  // 1) 대상 주차 확인 — 없으면 404, 이미 공표돼 있으면 409(중복 방지).
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("weeks")
    .select("id,week_number,iso_week,start_date,end_date,result_published_at")
    .eq("id", id)
    .maybeSingle();
  if (existingError) {
    throw new WeekResultPublishError(500, existingError.message);
  }
  if (!existing) {
    throw new WeekResultPublishError(404, "weeks row not found.");
  }
  const week = existing as PublishWeekRow;
  if (week.result_published_at) {
    throw new WeekResultPublishError(409, "이미 공표된 주차입니다.");
  }

  // 2) result_published_at IS NULL 가드로 갱신 (동시 공표 race 방어 + 멱등).
  const nowIso = new Date().toISOString();
  const { data: updated, error: updateError } = await supabaseAdmin
    .from("weeks")
    .update({ result_published_at: nowIso })
    .eq("id", id)
    .is("result_published_at", null)
    .select("id,week_number,iso_week,start_date,end_date,result_published_at")
    .maybeSingle();

  if (updateError) {
    throw new WeekResultPublishError(500, updateError.message);
  }
  if (!updated) {
    // 가드에 걸렸다 = 그 사이 다른 요청이 먼저 공표함.
    throw new WeekResultPublishError(409, "이미 공표된 주차입니다.");
  }

  const row = updated as PublishWeekRow;
  const label =
    row.week_number != null
      ? `${row.week_number}주차`
      : row.iso_week != null
        ? `${row.iso_week}주(ISO)`
        : "주차 미지정";
  return {
    week_id: row.id,
    week_label: label,
    week_start_date: row.start_date ?? null,
    week_end_date: row.end_date ?? null,
    result_published_at: row.result_published_at ?? nowIso,
  };
}

function emptyResult(
  seasons: SeasonDefinitionRow[],
  weeks: WeekRow[],
): WeekRecognitionsDto {
  return {
    rows: [],
    summary: {
      total_count: 0,
      success_count: 0,
      fail_count: 0,
      personal_rest_count: 0,
      official_rest_count: 0,
    },
    seasons: seasons.map((s) => ({
      season_key: s.season_key,
      season_label: seasonName(s),
    })),
    weeks: weeks.map((w) => ({
      week_id: w.id,
      season_key: w.season_key,
      week_label: weekLabelOf(w, w.iso_week),
      week_start_date: w.start_date,
      week_end_date: w.end_date,
      result_published_at: w.result_published_at ?? null,
    })),
    truncated: false,
    generated_at: new Date().toISOString(),
  };
}

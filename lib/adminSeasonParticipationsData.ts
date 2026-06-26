// Server-only data layer for the admin "시즌 참여/휴식" 조회 화면.
//
// 조회 전용(read-only). 기준 테이블은 user_season_statuses 이고, season_definitions /
// user_profiles 를 조합하며 user_week_statuses 를 (user_id, season_key) 로 집계한다.
// 기존 시즌 휴식 로직(cluster3 성장 지표 등)은 일절 변경하지 않는다.
//
// 필터:
//   - season_key        : user_season_statuses.season_key eq (DB).
//   - status            : user_season_statuses.status eq (DB). 허용값 success/rest.
//   - organization_slug : user_profiles 에서 user_id 집합을 먼저 좁힘.
//   - search            : user_profiles.display_name ilike.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isTransitionWeekStart } from "@/lib/seasonCalendar";
import { isSeasonParticipationStatus } from "@/lib/adminSeasonParticipationsTypes";
import type {
  SeasonParticipationFilterOptions,
  SeasonParticipationRow,
  SeasonParticipationsDto,
  SeasonParticipationUpdateInput,
  SeasonParticipationUpdateResult,
  SeasonParticipationUpdatedRow,
  SeasonPhase,
} from "@/lib/adminSeasonParticipationsTypes";

const MAX_ROWS = 5000;

type SeasonDefinitionRow = {
  season_key: string;
  season_label: string | null;
  season_type: string | null;
  start_date: string | null;
  end_date: string | null;
};

type SeasonStatusRow = {
  id: string;
  user_id: string;
  season_key: string;
  status: string;
  note: string | null;
  updated_at: string | null;
};

type ProfileRow = {
  user_id: string;
  display_name: string | null;
  organization_slug: string | null;
};

type WeekStatusRow = {
  user_id: string;
  season_key: string | null;
  status: string;
  week_start_date: string | null;
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

// 파생 분류. 규칙은 adminSeasonParticipationsTypes 주석 참조.
function deriveSeasonPhase(
  status: string,
  endDate: string | null,
  today: string,
): SeasonPhase {
  if (status === "rest") return "rest";
  if (status === "stopped") return "stopped";
  if (status === "active") return "active";
  if (status === "success") {
    if (endDate && endDate < today) return "completed";
    return "active";
  }
  return "unknown";
}

type WeekAgg = {
  total: number;
  success: number;
  fail: number;
  personal_rest: number;
  official_rest: number;
};

function emptyAgg(): WeekAgg {
  return { total: 0, success: 0, fail: 0, personal_rest: 0, official_rest: 0 };
}

// user_id 청크 단위 .in() 조회 — GET URL 길이 한도 회피(읽기 전용).
const ID_CHUNK = 150;

async function fetchProfilesByIds(ids: string[]): Promise<ProfileRow[]> {
  const out: ProfileRow[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const { data, error } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id,display_name,organization_slug")
      .in("user_id", chunk);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as ProfileRow[]));
  }
  return out;
}

// user_week_statuses 는 사용자당 다수 행 → 청크별 order+range 페이지네이션으로 1000행 cap 도 우회.
async function fetchWeekStatusesByIds(
  ids: string[],
  seasonKey: string | null,
): Promise<WeekStatusRow[]> {
  const out: WeekStatusRow[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    for (let from = 0; ; from += 1000) {
      let q = supabaseAdmin
        .from("user_week_statuses")
        .select("user_id,season_key,status,week_start_date")
        .in("user_id", chunk)
        .order("user_id", { ascending: true })
        .range(from, from + 999);
      if (seasonKey) q = q.eq("season_key", seasonKey);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as WeekStatusRow[];
      out.push(...rows);
      if (rows.length < 1000) break;
    }
  }
  return out;
}

export async function getSeasonParticipations(
  options: SeasonParticipationFilterOptions,
): Promise<SeasonParticipationsDto> {
  const seasonKey = options.seasonKey?.trim() || null;
  const organizationSlug = options.organizationSlug?.trim() || null;
  const status = isSeasonParticipationStatus(options.status)
    ? options.status
    : null;
  const search = options.search?.trim() || null;

  // 1) 시즌 정의.
  const { data: seasonData, error: seasonError } = await supabaseAdmin
    .from("season_definitions")
    .select("season_key,season_label,season_type,start_date,end_date")
    .order("start_date", { ascending: true });
  if (seasonError) throw new Error(seasonError.message);

  const seasons = (seasonData ?? []) as SeasonDefinitionRow[];
  const seasonByKey = new Map<string, SeasonDefinitionRow>();
  for (const s of seasons) seasonByKey.set(s.season_key, s);

  const seasonOptions = seasons.map((s) => ({
    season_key: s.season_key,
    season_label: seasonName(s),
  }));

  // 2) organization_slug / search 가 있으면 user_id 집합을 먼저 좁힌다.
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
      return emptyResult(seasonOptions);
    }
  }

  // 3) user_season_statuses 조회.
  let statusQuery = supabaseAdmin
    .from("user_season_statuses")
    .select("id,user_id,season_key,status,note,updated_at")
    .order("updated_at", { ascending: false })
    .limit(MAX_ROWS + 1);

  if (seasonKey) statusQuery = statusQuery.eq("season_key", seasonKey);
  if (status) statusQuery = statusQuery.eq("status", status);
  if (restrictUserIds) statusQuery = statusQuery.in("user_id", restrictUserIds);

  const { data: statusData, error: statusError } = await statusQuery;
  if (statusError) throw new Error(statusError.message);

  let seasonStatusRows = (statusData ?? []) as SeasonStatusRow[];
  const truncated = seasonStatusRows.length > MAX_ROWS;
  if (truncated) seasonStatusRows = seasonStatusRows.slice(0, MAX_ROWS);

  if (seasonStatusRows.length === 0) {
    return emptyResult(seasonOptions);
  }

  const userIds = Array.from(new Set(seasonStatusRows.map((r) => r.user_id)));

  // 4) 프로필(이름/조직) + 주차 상태 집계를 병렬 조회.
  //    ⚠ userIds 가 수백~수천이면 .in() 한 번에 넣을 때 PostgREST GET URL 길이 한도를 넘어
  //    "fetch failed" 로 터진다(전체/무필터 조회에서 발생). user_id 청크 + range 페이지네이션으로
  //    분할 조회한다(읽기 전용, 결과 동일).
  const [profiles, weekRows] = await Promise.all([
    fetchProfilesByIds(userIds),
    fetchWeekStatusesByIds(userIds, seasonKey),
  ]);

  const profileMap = new Map<string, ProfileRow>();
  for (const p of profiles) {
    profileMap.set(p.user_id, p);
  }

  // (user_id::season_key) → 주차 집계.
  const weekAgg = new Map<string, WeekAgg>();
  for (const w of weekRows) {
    if (!w.season_key) continue;
    // 전환 주차는 시즌 참여/휴식 집계에서 제외(공식 휴식·성공 어느 쪽도 아님).
    if (w.week_start_date && isTransitionWeekStart(w.week_start_date)) continue;
    const key = `${w.user_id}::${w.season_key}`;
    const agg = weekAgg.get(key) ?? emptyAgg();
    agg.total += 1;
    if (w.status === "success") agg.success += 1;
    else if (w.status === "fail") agg.fail += 1;
    else if (w.status === "personal_rest") agg.personal_rest += 1;
    else if (w.status === "official_rest") agg.official_rest += 1;
    weekAgg.set(key, agg);
  }

  const today = new Date().toISOString().slice(0, 10);

  // 5) rows 조립.
  const rows: SeasonParticipationRow[] = seasonStatusRows.map((ss) => {
    const season = seasonByKey.get(ss.season_key) ?? null;
    const profile = profileMap.get(ss.user_id) ?? null;
    const agg = weekAgg.get(`${ss.user_id}::${ss.season_key}`) ?? emptyAgg();

    return {
      user_season_status_id: ss.id,
      user_id: ss.user_id,
      user_name: profile?.display_name ?? null,
      organization_slug: profile?.organization_slug ?? null,
      season_key: ss.season_key,
      season_label: season ? seasonName(season) : null,
      season_start_date: season?.start_date ?? null,
      season_end_date: season?.end_date ?? null,
      status: ss.status,
      season_phase: deriveSeasonPhase(
        ss.status,
        season?.end_date ?? null,
        today,
      ),
      note: ss.note ?? null,
      updated_at: ss.updated_at ?? null,
      total_weeks: agg.total,
      success_weeks: agg.success,
      fail_weeks: agg.fail,
      personal_rest_weeks: agg.personal_rest,
      official_rest_weeks: agg.official_rest,
    };
  });

  // 안정 정렬: 시즌 시작일 desc → 조직 → 이름.
  rows.sort((a, b) => {
    const as = a.season_start_date ?? "";
    const bs = b.season_start_date ?? "";
    if (as !== bs) return as < bs ? 1 : -1;
    const ao = a.organization_slug ?? "";
    const bo = b.organization_slug ?? "";
    if (ao !== bo) return ao < bo ? -1 : 1;
    const an = a.user_name ?? "";
    const bn = b.user_name ?? "";
    return an < bn ? -1 : an > bn ? 1 : 0;
  });

  const summary = {
    total_count: rows.length,
    active_count: rows.filter((r) => r.season_phase === "active").length,
    rest_count: rows.filter((r) => r.season_phase === "rest").length,
    stopped_count: rows.filter((r) => r.season_phase === "stopped").length,
    completed_count: rows.filter((r) => r.season_phase === "completed").length,
    unknown_count: rows.filter((r) => r.season_phase === "unknown").length,
  };

  return {
    rows,
    summary,
    seasons: seasonOptions,
    truncated,
    generated_at: new Date().toISOString(),
  };
}

// ─── 단건 상태 수정(PATCH) ───────────────────────────────────────────
//
// user_season_statuses 단일 row 의 status / note 만 수정한다.
// user_week_statuses(주차 상태)·user_growth_stats(성장 캐시)는 의도적으로 건드리지 않는다.
//
// seasonRestValidation.ts 와의 관계(조사 결과):
//   - 시즌 휴식 "정책" 경로(requestSeasonRest)는 deadline 검증 + 1주차 personal_rest 전환 +
//     growth_stats 재집계를 함께 수행한다. 그러나 season→week 를 연쇄하는 DB 트리거는 없으므로,
//     이 admin UPDATE(status/note)와 DB 레벨에서 충돌하지 않는다(서로 독립 경로).
//   - 따라서 admin 이 rest/success 로 바꿔도 주차 상태는 자동 동기화되지 않는다. 그 사실을
//     결과의 week_status_sync_skipped=true + week_status_sync_note 로 명시한다(요구사항 7/8).

export class SeasonParticipationUpdateError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SeasonParticipationUpdateError";
    this.status = status;
  }
}

type UpdatedSeasonStatusRow = {
  id: string;
  user_id: string;
  season_key: string;
  status: string;
  note: string | null;
  updated_at: string | null;
};

const UPDATED_SELECT = "id,user_id,season_key,status,note,updated_at";

const WEEK_STATUS_SYNC_NOTE =
  "시즌 상태(user_season_statuses)만 수정되었습니다. 주차 상태(user_week_statuses)는 " +
  "자동으로 변경되지 않았으며, 필요하면 주차 인정 결과 화면에서 개별 조정해야 합니다.";

export async function updateSeasonParticipation(
  userSeasonStatusId: string,
  input: SeasonParticipationUpdateInput,
): Promise<SeasonParticipationUpdateResult> {
  const id = String(userSeasonStatusId ?? "").trim();
  if (!id) {
    throw new SeasonParticipationUpdateError(
      400,
      "user_season_status_id is required.",
    );
  }

  // 수정 가능한 필드만 추출(부분 수정). 허용 외 키는 무시.
  const patch: Record<string, unknown> = {};
  if (input.status !== undefined) {
    if (!isSeasonParticipationStatus(input.status)) {
      throw new SeasonParticipationUpdateError(
        400,
        `Unknown status: ${String(input.status)} (allowed: success, active, rest, stopped)`,
      );
    }
    patch.status = input.status;
  }
  if (input.note !== undefined) {
    patch.note = input.note === null ? null : String(input.note);
  }

  if (Object.keys(patch).length === 0) {
    throw new SeasonParticipationUpdateError(
      400,
      "No updatable fields provided.",
    );
  }

  // 5) 수정 전 기존 row 확인 — 없으면 404.
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("user_season_statuses")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (existingError) {
    throw new SeasonParticipationUpdateError(500, existingError.message);
  }
  if (!existing) {
    throw new SeasonParticipationUpdateError(
      404,
      "user_season_statuses row not found.",
    );
  }

  // updated_at 은 DB 트리거(touch_user_season_statuses_updated_at)가 갱신한다.
  const { data: updated, error: updateError } = await supabaseAdmin
    .from("user_season_statuses")
    .update(patch)
    .eq("id", id)
    .select(UPDATED_SELECT)
    .maybeSingle();

  if (updateError) {
    throw new SeasonParticipationUpdateError(500, updateError.message);
  }
  if (!updated) {
    // 업데이트 직후 row 가 사라진 극단 케이스.
    throw new SeasonParticipationUpdateError(
      404,
      "user_season_statuses row not found.",
    );
  }

  const row = updated as UpdatedSeasonStatusRow;
  const updatedRow: SeasonParticipationUpdatedRow = {
    user_season_status_id: row.id,
    user_id: row.user_id,
    season_key: row.season_key,
    status: row.status,
    note: row.note ?? null,
    updated_at: row.updated_at ?? null,
  };

  return {
    row: updatedRow,
    week_status_sync_skipped: true,
    week_status_sync_note: WEEK_STATUS_SYNC_NOTE,
  };
}

function emptyResult(
  seasonOptions: { season_key: string; season_label: string | null }[],
): SeasonParticipationsDto {
  return {
    rows: [],
    summary: {
      total_count: 0,
      active_count: 0,
      rest_count: 0,
      stopped_count: 0,
      completed_count: 0,
      unknown_count: 0,
    },
    seasons: seasonOptions,
    truncated: false,
    generated_at: new Date().toISOString(),
  };
}

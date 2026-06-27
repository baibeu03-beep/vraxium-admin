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
import { fetchOperationalSeasonParticipants } from "@/lib/operationalSeasonParticipants";
import { resolveUserScope } from "@/lib/userScope";
import { isWeekRecognitionStatus } from "@/lib/adminWeekRecognitionsTypes";
import type {
  WeekRecognitionFilterOptions,
  WeekRecognitionRow,
  WeekRecognitionsDto,
  WeekRecognitionUpdateInput,
  WeekRecognitionUpdateResult,
  WeekRecognitionUpdatedRow,
  WeekResultPublishResult,
  WeekCheckThresholdUpdateInput,
  WeekCheckThresholdUpdateResult,
} from "@/lib/adminWeekRecognitionsTypes";
import { DEFAULT_WEEK_CHECK_THRESHOLD } from "@/lib/cluster4Enhancement";
import { recalcUserGrowthStats } from "@/lib/userGrowthStatsData";
import {
  refreshWeeklyCardsSnapshotSafe,
  recomputeWeeklyCardsSnapshotsForUsers,
} from "@/lib/cluster4WeeklyCardsSnapshot";

// 안전 상한. 앱 규모상 충분하지만 무한정 로드를 막기 위해 캡을 둔다.
const MAX_ROWS = 5000;

// .in("user_id", ids) 의 id 들은 PostgREST 가 GET URL 쿼리스트링에 그대로 나열한다.
// 모집단(현재 시즌 참여자 ~300명)이라도 한 번에 넣으면 URL 이 길어져 엣지가 400(또는
// undici "fetch failed")으로 거부할 수 있으므로, 모든 user_id .in 조회는 이 크기로 청크 분할한다.
// (lib/adminMembersData·adminCrewData 등 다른 데이터 레이어와 동일한 방어 패턴.)
const ID_CHUNK = 150;

function chunkIds(ids: string[], size = ID_CHUNK): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

// PostgREST max-rows(1000) 때문에 .limit(N>1000) 은 조용히 1000 으로 잘려, "1000행 초과 = 절단"
// 감지(truncated)가 영영 안 잡힌다(예: user_week_statuses 9.7k행이 무필터 조회 시 1000행만 노출).
// .range() 페이지네이션으로 실제로 끝까지(또는 stopAfter 초과까지) 읽는다. 결과 순서는 호출부에서
// 다시 정렬하므로, 페이지 경계 안정성을 위해 호출 측이 고유 tiebreaker(예: id)로 정렬해야 한다.
async function collectRowsPaged<T>(
  runPage: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  opts: { pageSize?: number; stopAfter?: number } = {},
): Promise<T[]> {
  const pageSize = opts.pageSize ?? 1000;
  const stopAfter = opts.stopAfter ?? Number.POSITIVE_INFINITY;
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await runPage(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < pageSize) break; // 더 없음(마지막 페이지)
    if (rows.length > stopAfter) break; // 절단 감지에 충분(호출부가 truncated 판정·slice)
  }
  return rows;
}

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
  // 주차 인정 point.check 기준값. NULL=기본값. 마이그레이션 미적용 DB 폴백 시 undefined.
  check_threshold?: number | null;
};

// weeks 조회 — check_threshold 컬럼 미적용 DB(마이그레이션 전) 방어 폴백 포함.
async function fetchWeekRows(): Promise<WeekRow[]> {
  const WITH_THRESHOLD =
    "id,season_key,week_number,start_date,end_date,iso_year,iso_week,result_published_at,check_threshold";
  const { data, error } = await supabaseAdmin
    .from("weeks")
    .select(WITH_THRESHOLD)
    .order("start_date", { ascending: true });
  if (!error) return (data ?? []) as WeekRow[];

  console.warn(
    "[week-recognitions] weeks.check_threshold select failed — fallback without column",
    { message: error.message },
  );
  const { data: fallback, error: fallbackError } = await supabaseAdmin
    .from("weeks")
    .select(
      "id,season_key,week_number,start_date,end_date,iso_year,iso_week,result_published_at",
    )
    .order("start_date", { ascending: true });
  if (fallbackError) throw new Error(fallbackError.message);
  return (fallback ?? []) as WeekRow[];
}

function weekOptionOf(w: WeekRow) {
  const threshold = w.check_threshold ?? null;
  return {
    week_id: w.id,
    season_key: w.season_key,
    week_label: weekLabelOf(w, w.iso_week),
    week_start_date: w.start_date,
    week_end_date: w.end_date,
    result_published_at: w.result_published_at ?? null,
    check_threshold: threshold,
    effective_check_threshold: threshold ?? DEFAULT_WEEK_CHECK_THRESHOLD,
    check_threshold_is_default: threshold == null,
  };
}

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

// DTO 출력용 — 시즌/주차 옵션을 최신순(start_date desc)으로 내보낸다.
//   드롭다운·check 기준 관리 탭 목록이 최신 시즌/주차를 위에 보이도록. 내부 매칭용 weeks/seasons
//   배열 순서(weekByIso "first wins" 등)는 건드리지 않고 출력 사본만 정렬한다.
function seasonStartMs(s: SeasonDefinitionRow): number {
  return s.start_date ? Date.parse(s.start_date) : Number.NEGATIVE_INFINITY;
}
function weekStartMs(w: WeekRow): number {
  return w.start_date ? Date.parse(w.start_date) : Number.NEGATIVE_INFINITY;
}
function toSeasonOptionsLatestFirst(seasons: SeasonDefinitionRow[]) {
  return [...seasons]
    .sort((a, b) => seasonStartMs(b) - seasonStartMs(a))
    .map((s) => ({ season_key: s.season_key, season_label: seasonName(s) }));
}
function toWeekOptionsLatestFirst(weeks: WeekRow[]) {
  return [...weeks].sort((a, b) => weekStartMs(b) - weekStartMs(a)).map(weekOptionOf);
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
  const [seasonRes, weeks] = await Promise.all([
    supabaseAdmin
      .from("season_definitions")
      .select("season_key,season_label,season_type,start_date,end_date")
      .order("start_date", { ascending: true }),
    fetchWeekRows(),
  ]);

  if (seasonRes.error) throw new Error(seasonRes.error.message);

  const seasons = (seasonRes.data ?? []) as SeasonDefinitionRow[];

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

  // 3) 모집단 한정 — 운영 기준 시즌 참여자(user_season_statuses)만.
  //   /admin/members 명부와 동일 기준. 종전엔 전체 user_week_statuses(전 시즌 9.7k행 → 고유
  //   사용자 719명)에서 user_id 를 모아 user_profiles 를 한 번에 .in() 조회해 URL 이 폭주,
  //   "fetch failed"(또는 엣지 400)가 났다. 이제 최초 조회 단계부터 현재 시즌 대상자(~318명)만 본다.
  //   org/search 필터가 있으면 그 결과와 교집합한다.
  const [op, scope] = await Promise.all([
    // 공통 SoT(lib/operationalSeasonParticipants) — /admin/members 명부와 동일 모집단 기준.
    fetchOperationalSeasonParticipants(),
    // 테스터(test_user_markers) 제외 — operating 스코프 단일 SoT.
    //   이름 '%T%' 휴리스틱이 아니라 마커 테이블 기준(이유나 등 'T' 없는 테스터까지 제외).
    //   mode 분기 없음 → demoUserId 테스트/일반 모드가 동일 DTO·조회 기준.
    resolveUserScope("operating", null),
  ]);
  const opSeasonKey = op.seasonKey;
  // seasonKey 미해소(off-season 등)면 null → 아래에서 전수 폴백(.in 청크 유지). 해소 시 참여자 id 배열.
  const participantIds: string[] | null = opSeasonKey ? op.ids : null;

  // opSeasonKey 가 해소됐는데 참여자가 0명이면(시즌 참여행 미구성) 빈 목록.
  if (opSeasonKey && participantIds && participantIds.length === 0) {
    return emptyResult(seasons, weeks);
  }

  // restrictUserIds: 참여자 집합(미해소면 null=전수 폴백). org/search 가 있으면 교집합.
  let restrictUserIds: string[] | null = participantIds;
  if (organizationSlug || search) {
    // PostgREST 1000행 cap 회피 — .range() 페이지네이션(stable order: user_id).
    const profileRows = await collectRowsPaged<ProfileRow>(
      (from, to) => {
        let q = supabaseAdmin
          .from("user_profiles")
          .select("user_id,display_name,organization_slug")
          .order("user_id", { ascending: true })
          .range(from, to);
        if (organizationSlug) q = q.eq("organization_slug", organizationSlug);
        if (search) q = q.ilike("display_name", `%${search}%`);
        return q;
      },
      { pageSize: 1000, stopAfter: MAX_ROWS },
    );
    const filteredIds = profileRows.map((p) => p.user_id);
    if (restrictUserIds) {
      const participantSet = new Set(restrictUserIds);
      restrictUserIds = filteredIds.filter((id) => participantSet.has(id));
    } else {
      restrictUserIds = filteredIds;
    }
    if (restrictUserIds.length === 0) {
      return emptyResult(seasons, weeks);
    }
  }

  // 테스터 제외 — 참여자 목록에서 미리 제거(쿼리 비용·URL 길이 절감). 폴백(restrictUserIds=null)
  //   경로는 아래 statusRows 단계에서 방어적으로 한 번 더 거른다.
  if (restrictUserIds) {
    restrictUserIds = restrictUserIds.filter((id) => scope.includes(id));
    if (restrictUserIds.length === 0) {
      return emptyResult(seasons, weeks);
    }
  }

  // 4) user_week_statuses 조회 — 참여자(restrictUserIds) 한정 + 가능한 필터는 DB 에서 적용.
  //   ⚠ PostgREST max-rows(1000) 때문에 .limit(MAX_ROWS+1) 은 조용히 1000 으로 잘려 truncated 가
  //     영영 false 였다. .range() 페이지네이션으로 실제로 끝까지(또는 MAX_ROWS 초과까지) 읽는다.
  //   ⚠ user_id .in 은 ID_CHUNK(150) 로 청크 분할해 URL 길이 폭주를 막는다(참여자 수가 줄어도 유지).
  //     결과 순서는 호출부에서 다시 정렬하므로 청크 간 순서는 무관.
  const buildStatusPage =
    (chunk: string[] | null) => (from: number, to: number) => {
      let q = supabaseAdmin
        .from("user_week_statuses")
        .select(
          "id,user_id,year,week_number,week_start_date,status,is_official_rest_override,note,updated_at",
        )
        .order("week_start_date", { ascending: false })
        .order("updated_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to);

      if (status) q = q.eq("status", status);

      if (targetWeek) {
        // 특정 주차: 그 주차의 ISO (year, week) 로 한정.
        q = q
          .eq("year", targetWeek.iso_year)
          .eq("week_number", targetWeek.iso_week);
      } else if (season && season.start_date && season.end_date) {
        // 시즌 날짜창: week_start_date 가 시즌 기간 안.
        q = q
          .gte("week_start_date", season.start_date)
          .lte("week_start_date", season.end_date);
      }

      if (chunk) q = q.in("user_id", chunk);
      return q;
    };

  let statusRows: UserWeekStatusRow[];
  if (restrictUserIds) {
    // 참여자 id 를 150개 청크로 나눠 각각 페이지네이션 조회 후 합친다.
    statusRows = [];
    for (const chunk of chunkIds(restrictUserIds)) {
      const part = await collectRowsPaged<UserWeekStatusRow>(
        buildStatusPage(chunk),
        { pageSize: 1000, stopAfter: MAX_ROWS },
      );
      statusRows.push(...part);
      if (statusRows.length > MAX_ROWS) break; // 절단 감지에 충분
    }
  } else {
    // opSeasonKey 미해소 폴백(전수) — 그래도 페이지네이션으로 끝까지 읽는다.
    statusRows = await collectRowsPaged<UserWeekStatusRow>(
      buildStatusPage(null),
      { pageSize: 1000, stopAfter: MAX_ROWS },
    );
  }

  // season iso 폴백(날짜창 없는 시즌)일 때 in-memory 로 한정.
  if (seasonIsoFallback) {
    statusRows = statusRows.filter((r) => {
      const k = isoKey(r.year, r.week_number);
      return k != null && seasonIsoFallback!.has(k);
    });
  }

  // 테스터 최종 제외(방어적) — restrictUserIds 미적용 폴백 경로 및 drift 대비.
  //   목록·집계(summary) 모두 이 필터 이후의 rows 에서 파생되므로 화면/카운트 동시 제외된다.
  statusRows = statusRows.filter((r) => scope.includes(r.user_id));

  // 청크 합산은 전역 순서를 보장하지 않으므로, 절단(slice) 전에 주차 시작일 desc 로 안정 정렬해
  //   "최근 주차 우선"으로 자른다(종전 단일 정렬 쿼리 + slice 와 동일 의미).
  statusRows.sort((a, b) => {
    const aw = a.week_start_date ?? "";
    const bw = b.week_start_date ?? "";
    if (aw !== bw) return aw < bw ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const truncated = statusRows.length > MAX_ROWS;
  if (truncated) statusRows = statusRows.slice(0, MAX_ROWS);

  // 5) 프로필 조회(이름/조직). user_id .in 은 ID_CHUNK(150) 청크 분할(URL 길이 방어).
  const userIds = Array.from(new Set(statusRows.map((r) => r.user_id)));
  const profileMap = new Map<string, ProfileRow>();
  for (const chunk of chunkIds(userIds)) {
    const { data: profData, error: profErr } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id,display_name,organization_slug")
      .in("user_id", chunk);
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
    // 시즌/주차 옵션은 최신순(start_date desc) — 드롭다운·check 기준 관리 탭 목록 최신 우선.
    seasons: toSeasonOptionsLatestFirst(seasons),
    weeks: toWeekOptionsLatestFirst(weeks),
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

  // 쓰기 시점 snapshot 갱신: uws 변경 → 해당 사용자 카드 즉시 재계산(best-effort, 롤백 안 함).
  await refreshWeeklyCardsSnapshotSafe(row.user_id);

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

// 주차 코호트(= 해당 week_start_date 의 user_week_statuses 보유자) 전원의 weekly-cards
// snapshot 을 재계산한다. 공표(tallying→success/fail)·check 기준 변경·집계 확정 등
// "그 주차 참여자 카드가 달라지는" 모든 쓰기 경로의 공통 재계산 헬퍼.
//   - best-effort: 사용자별 실패는 격리되고 throw 하지 않는다(본 쓰기 응답 보호).
//   - start_date 가 없으면 no-op(zeros).
// 반환 shape 은 publish-result/check-threshold 응답의 snapshot_recompute 와 동일.
export async function recomputeCohortSnapshots(
  weekStartDate: string | null,
): Promise<{ requested: number; recomputed: number; failed: number }> {
  if (!weekStartDate) return { requested: 0, recomputed: 0, failed: 0 };
  const { data, error } = await supabaseAdmin
    .from("user_week_statuses")
    .select("user_id")
    .eq("week_start_date", weekStartDate);
  if (error) {
    console.warn("[recomputeCohortSnapshots] cohort scan failed", {
      weekStartDate,
      message: error.message,
    });
    return { requested: 0, recomputed: 0, failed: 0 };
  }
  const userIds = Array.from(
    new Set(((data ?? []) as { user_id: string }[]).map((p) => p.user_id)),
  );
  const r = await recomputeWeeklyCardsSnapshotsForUsers(userIds, {
    concurrency: 3,
  });
  if (r.failed > 0) {
    console.warn("[recomputeCohortSnapshots] partial fail", {
      weekStartDate,
      failedUserIds: r.failedUserIds,
    });
  }
  return { requested: r.requested, recomputed: r.recomputed, failed: r.failed };
}

type PublishWeekRow = {
  id: string;
  week_number: number | null;
  iso_week: number | null;
  start_date: string | null;
  end_date: string | null;
  result_published_at: string | null;
};

// 공표 SoT 쓰기만 수행한다(스냅샷 재계산 없음) — weeks.result_published_at 세팅.
//   publishWeekResult(= 공표 + 전체 코호트 재계산)와, weekly-card-finalization(= 공표 +
//   테스트 제외 코호트 재계산)이 공통으로 쓰는 단일 공표 진입점. 가드/멱등은 여기 한 곳.
//   - 없으면 404, 이미 공표돼 있으면 409(중복 방지), IS NULL 가드로 race 방어.
export async function markWeekResultPublished(
  weekId: string,
): Promise<{ row: PublishWeekRow; label: string; nowIso: string }> {
  const id = String(weekId ?? "").trim();
  if (!id) {
    throw new WeekResultPublishError(400, "week_id is required.");
  }

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
  return { row, label, nowIso };
}

export async function publishWeekResult(
  weekId: string,
): Promise<WeekResultPublishResult> {
  // 1~2) 공표 SoT 쓰기(가드/멱등)는 공통 진입점에 위임.
  const { row, label, nowIso } = await markWeekResultPublished(weekId);

  // 쓰기 시점 snapshot 갱신: 공표로 해당 주차 카드가 tallying→success/fail 로 전환되므로,
  // 그 주차 참여자(user_week_statuses 보유) 전원의 snapshot 을 즉시 재계산한다.
  // best-effort — 실패해도 공표(weeks.result_published_at)는 롤백하지 않고 로그만 남긴다.
  let snapshotRecompute: WeekResultPublishResult["snapshot_recompute"];
  try {
    snapshotRecompute = await recomputeCohortSnapshots(row.start_date);
  } catch (e) {
    console.warn("[publish-result] snapshot recompute hook failed (publish kept)", {
      weekId: row.id,
      message: e instanceof Error ? e.message : String(e),
    });
  }

  return {
    week_id: row.id,
    week_label: label,
    week_start_date: row.start_date ?? null,
    week_end_date: row.end_date ?? null,
    result_published_at: row.result_published_at ?? nowIso,
    snapshot_recompute: snapshotRecompute,
  };
}

// ─── 주차 인정 check 기준값 수정(PATCH) ──────────────────────────────
//
// weeks.check_threshold 를 수정한다 (null = 기본값 사용). 이 값은 레거시(허브 도입 전)
// 통합 라인 주차의 "주차 성공" read-time 판정(평점 ≥4 AND check >= 기준값)에 쓰인다.
//   - user_week_statuses 는 절대 건드리지 않는다 (read-time 판정 — uws 원본 보존).
//   - 변경 직후 그 주차 참여자(user_week_statuses 보유) 전원의 weekly-cards snapshot 을
//     재계산한다 (publish-result 와 동일 패턴, best-effort).

export class WeekCheckThresholdUpdateError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "WeekCheckThresholdUpdateError";
    this.status = status;
  }
}

export async function updateWeekCheckThreshold(
  weekId: string,
  input: WeekCheckThresholdUpdateInput,
): Promise<WeekCheckThresholdUpdateResult> {
  const id = String(weekId ?? "").trim();
  if (!id) {
    throw new WeekCheckThresholdUpdateError(400, "week_id is required.");
  }

  const raw = input?.check_threshold;
  let nextValue: number | null;
  if (raw === null || raw === undefined) {
    nextValue = null; // 기본값 사용으로 되돌리기
  } else if (
    typeof raw === "number" &&
    Number.isInteger(raw) &&
    raw >= 0 &&
    raw <= 10000
  ) {
    nextValue = raw;
  } else {
    throw new WeekCheckThresholdUpdateError(
      400,
      "check_threshold must be an integer between 0 and 10000, or null (use default).",
    );
  }

  // 1) 대상 주차 확인 — 없으면 404.
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("weeks")
    .select("id,week_number,iso_week,start_date")
    .eq("id", id)
    .maybeSingle();
  if (existingError) {
    throw new WeekCheckThresholdUpdateError(500, existingError.message);
  }
  if (!existing) {
    throw new WeekCheckThresholdUpdateError(404, "weeks row not found.");
  }

  // 2) 갱신. check_threshold 컬럼 미적용 DB 면 명시적 에러로 안내.
  const { data: updated, error: updateError } = await supabaseAdmin
    .from("weeks")
    .update({ check_threshold: nextValue })
    .eq("id", id)
    .select("id,week_number,iso_week,start_date,check_threshold")
    .maybeSingle();
  if (updateError) {
    const missingColumn = /check_threshold/.test(updateError.message);
    throw new WeekCheckThresholdUpdateError(
      missingColumn ? 409 : 500,
      missingColumn
        ? "weeks.check_threshold 컬럼이 없습니다. db/migrations/2026-06-05_weeks_check_threshold.sql 을 Supabase SQL Editor 에서 먼저 적용하세요."
        : updateError.message,
    );
  }
  if (!updated) {
    throw new WeekCheckThresholdUpdateError(404, "weeks row not found.");
  }

  const row = updated as {
    id: string;
    week_number: number | null;
    iso_week: number | null;
    start_date: string | null;
    check_threshold: number | null;
  };
  const label =
    row.week_number != null
      ? `${row.week_number}주차`
      : row.iso_week != null
        ? `${row.iso_week}주(ISO)`
        : "주차 미지정";

  // 3) 쓰기 시점 snapshot 갱신: 기준값 변경 → 그 주차 참여자 전원의 read-time 판정이
  //    달라질 수 있으므로 snapshot 재계산 (publish-result 와 동일 패턴, best-effort).
  let snapshotRecompute: WeekCheckThresholdUpdateResult["snapshot_recompute"];
  try {
    if (row.start_date) {
      const { data: parts } = await supabaseAdmin
        .from("user_week_statuses")
        .select("user_id")
        .eq("week_start_date", row.start_date);
      const userIds = Array.from(
        new Set(((parts ?? []) as { user_id: string }[]).map((p) => p.user_id)),
      );
      const r = await recomputeWeeklyCardsSnapshotsForUsers(userIds, {
        concurrency: 3,
      });
      snapshotRecompute = {
        requested: r.requested,
        recomputed: r.recomputed,
        failed: r.failed,
      };
      if (r.failed > 0) {
        console.warn("[check-threshold] snapshot recompute partial fail", {
          weekId: row.id,
          failedUserIds: r.failedUserIds,
        });
      }
    }
  } catch (e) {
    console.warn(
      "[check-threshold] snapshot recompute hook failed (update kept)",
      {
        weekId: row.id,
        message: e instanceof Error ? e.message : String(e),
      },
    );
  }

  return {
    week_id: row.id,
    week_label: label,
    week_start_date: row.start_date ?? null,
    check_threshold: row.check_threshold ?? null,
    effective_check_threshold:
      row.check_threshold ?? DEFAULT_WEEK_CHECK_THRESHOLD,
    check_threshold_is_default: row.check_threshold == null,
    snapshot_recompute: snapshotRecompute,
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
    seasons: toSeasonOptionsLatestFirst(seasons),
    weeks: toWeekOptionsLatestFirst(weeks),
    truncated: false,
    generated_at: new Date().toISOString(),
  };
}

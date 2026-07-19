// 클럽 정보 > 주차 내역 — 클럽(조직)별 주차 목록 + 액트/라인 요약 + 주차 검수 여부 (read-only).
//
// 라우트(GET /api/admin/team-parts/info/weeks)와 검증 스크립트가 동일하게 이 함수를 호출해
// "direct == HTTP" 를 보장한다. 인증/HTTP 포장은 라우트가, DB 조회/집계는 여기서 한다.
//
// 집계 기준(2026-07-02 개정): info 만이 아니라 **모든 라인 허브**(정보·실무 경험·역량)를 포함한다.
//   LINE_HUBS = ['info','experience','competency']. (career=테스트 1건·미운영 → 제외, 요구사항 3허브와 일치.)
//
// 데이터 원천(전부 live 조회 — 고객 weekly-card snapshot 무접촉):
//   · 주차/시즌/공식휴식/현재주차 = loadSeasonWeeks (season_definitions + weeks + official_rest_periods)
//   · 액트 전체/가동/체크/미체크/변동/**액트 체크 신청율**
//       = `loadActCheckApplicationInputsByWeek` + `buildActCheckApplicationSummary`
//         (= 상세 [액트 체크 관리] 탭과 **완전히 동일한 로더·빌더** — 목록 전용 산식 금지).
//     ⚠ 2026-07-17 개정 전 이 화면은 상세와 다른 산식을 써서 구조적으로 발산했다(실측):
//         ① 허브 범위 : LINE_HUBS(info/exp/comp) → club 누락 → 전체 11 vs 상세 19
//         ② 가동      : check_target='check' 카탈로그 상수(주차 무관) → 가동 11 vs 상세 0
//         ③ 체크      : status='completed' 만 → "완료율"이었음(신청율 아님). pending 은 미집계
//         ④ 변동 액트 : 전혀 미포함
//       → 위 4건 모두 공통 SoT 로 흡수. 상세와 동일 값이 보장된다.
//   · 전체 라인(라인칸)            = 허브별 카탈로그 합(org):
//                                     info=activity_types(practical_info, 공통 9)
//                                     + experience=cluster4_experience_line_masters(org)
//                                     + competency=cluster4_competency_line_masters(org)
//   · 오픈 라인 / 라인칸 개설율    = 주차에 개설된 활성 라인(org 노출)의 서로 다른 카탈로그 단위 수
//                                     info=activity_type_id · exp=experience_line_master_id · comp=competency_line_master_id
//                                     주차 링크 = cluster4_line_targets.week_id(전 허브 공통) ∪ cluster4_lines.week_id(info 전용)
//                                     org 노출 = info: line_code 토큰 / exp·comp: 마스터 organization_slug
//   · 주차 검수 상태(집계중/검수중/검수완료) = cluster4_week_org_result_states[(week_id, org)]
//       가 단일 SoT. 행 없으면 resolveWeekOrgResultState 로 레거시 폴백(<2026-06-29 & result_reviewed_at
//       → 검수완료). weeks.result_reviewed_at(전역 컬럼)은 레거시 폴백 입력으로만 쓰고 직접 표시하지 않는다.
//       (2026-07-19 이전엔 전역 result_reviewed_at 을 그대로 봤기에, 한 조직만 검수해도 세 조직 모두
//        "검수 완료"로 표시되는 버그가 있었다 — 조직별 상태로 통일.)
//
// mode(operating/test):
//   주차·시즌·라인칸·개설 라인 목록·검수 여부·정규 액트 카탈로그는 사용자 모집단과 무관해 mode 불변이다.
//   ⚠ 단 **변동 액트는 scope_mode 로 갈린다**(process_irregular_acts.scope_mode) → 액트 요약(전체/가동/
//     체크/미체크/변동/신청율)은 mode 에 따라 값이 달라질 수 있다. 이는 상세 화면과 동일한 스코프 규칙이며
//     (상세도 scope_mode=mode 로 변동을 필터), 목록==상세 파리티를 위해 필수다.
//     산식·DTO 구조는 두 모드가 완전히 동일하다(스코프 어댑터만 다름 — 요구).
//     2026-07-17 이전엔 변동을 아예 안 세어 "값까지 동일"했다(= 변동 누락 버그의 부작용).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadSeasonWeeks, type SeasonWeekDto } from "@/lib/adminSeasonWeeksData";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import { formatClubDate } from "@/lib/clubDate";
import {
  parseLineCodeOrg,
  normalizeLineOrg,
  isLineVisibleForUserOrg,
  type LineOrgScope,
} from "@/lib/cluster4LineOrg";
import {
  buildActCheckApplicationSummary,
  type ActCheckApplicationSummary,
} from "@/lib/actCheckApplicationSummary";
import { loadActCheckApplicationInputsByWeek } from "@/lib/adminActCheckApplicationInputs";
import type { OrganizationSlug } from "@/lib/organizations";
import type { ScopeMode } from "@/lib/userScopeShared";
import {
  loadWeekOrgResultStates,
  resolveWeekOrgResultState,
  resolveOrgResultScope,
  type WeekOrgResultStatus,
  type OrgResultScope,
} from "@/lib/weekOrgResultState";

// 라인 허브 = cluster4_lines.part_type 중 운영 라인 3종(career 제외). **라인(라인칸) 집계 전용 축**.
//   ⚠ 액트 집계에는 쓰지 않는다 — 액트 허브 범위는 상세 기준(ACT_CHECK_HUBS, club 포함)으로 통일했다.
const LINE_HUBS = ["info", "experience", "competency"] as const;

export type ClubActivityStatus = "official_activity" | "official_rest";

export type TeamPartsInfoWeekItem = {
  weekId: string;
  weekName: string;
  clubActivityStatus: ClubActivityStatus;
  // 액트 체크 신청 요약 — 상세 탭과 동일 타입/동일 빌더 산출값(원본 count 포함).
  //   구 평면 필드(actCheckRate/totalActs/activeActs)는 제거했다(어드민 내부 전용 API·외부 소비자 없음).
  //   프론트는 이미 반올림된 값을 재계산하지 말고 이 DTO 값을 그대로 표시한다.
  actCheck: ActCheckApplicationSummary;
  lineOpenRate: number; // 0~100 (%)
  totalLines: number;
  openLines: number;
  // 조직별 검수 상태(cluster4_week_org_result_states) — aggregating(집계 중)/reviewing(검수 중)/published(검수 완료).
  //   현재 선택 조직(organization) 기준 단일 값. 전역 result_reviewed_at 은 직접 노출하지 않는다.
  reviewStatus: WeekOrgResultStatus;
  // 하위호환·정렬용 파생값(= reviewStatus === "published"). 신규 소비자는 reviewStatus 를 쓴다.
  weekReviewed: boolean;
  // UI 하이라이트 편의용(양 모드 공통 — DTO 구조/값 파리티 유지).
  isCurrentWeek: boolean;
};

export type TeamPartsInfoCurrentWeek = {
  todayLabel: string; // "2026년 7/14(화)"
  seasonWeekName: string | null; // "26년 여름 시즌 3주차"
  weekRangeLabel: string | null; // "26 - 07 - 13 (월) ~ 26 - 07 - 19 (일)"
  clubActivityStatus: ClubActivityStatus | null;
};

export type TeamPartsInfoWeeksPagination = {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
};

export type TeamPartsInfoWeeksData = {
  organization: OrganizationSlug;
  currentWeek: TeamPartsInfoCurrentWeek;
  items: TeamPartsInfoWeekItem[];
  pagination: TeamPartsInfoWeeksPagination;
};

export const DEFAULT_WEEKS_PAGE_SIZE = 20;
const MAX_WEEKS_PAGE_SIZE = 100;

// ── 정렬(서버사이드) ─────────────────────────────────────────────────────────
// 이 목록은 서버사이드 페이지네이션(162주차/9페이지)이라 "현재 페이지"만 정렬하면
// 전체 목록 기준이 아니다 → 전체 주차를 정렬한 뒤 페이지를 나눈다.
//   · meta 키(주차명·클럽활동)   = loadSeasonWeeks 로 이미 전량 확보 → 저비용 전체 정렬.
//   · aggregate 키(체크율·개설율·오픈라인·검수) = 주차별 집계 필요 → 전 주차 집계 후 정렬(cap-safe).
//   · 상수 컬럼(전체 액트·가동 액트·전체 라인)은 전 주차 동일값(카탈로그 크기)이라 정렬 무의미 → 제외.
// 클라이언트 입력은 semantic 키만 허용(whitelist). DB 컬럼명을 그대로 받지 않는다.
export type WeeksSortKey =
  | "weekName"
  | "clubActivityStatus"
  | "actCheckApplicationRate"
  | "lineOpenRate"
  | "openLines"
  | "weekReviewed";
export type WeeksSortDir = "asc" | "desc";
export type WeeksSort = { key: WeeksSortKey; dir: WeeksSortDir };

export const WEEKS_SORTABLE_KEYS: readonly WeeksSortKey[] = [
  "weekName",
  "clubActivityStatus",
  "actCheckApplicationRate",
  "lineOpenRate",
  "openLines",
  "weekReviewed",
];
export function isWeeksSortKey(v: string): v is WeeksSortKey {
  return (WEEKS_SORTABLE_KEYS as readonly string[]).includes(v);
}
// meta 키만 이 집합. 나머지 sortable 키는 aggregate(전 주차 집계 필요).
const META_SORT_KEYS: ReadonlySet<WeeksSortKey> = new Set<WeeksSortKey>([
  "weekName",
  "clubActivityStatus",
]);

// 클럽 활동 상태 업무 순서(공식 활동 → 공식 휴식). 오름차순 기준 인덱스.
const CLUB_ACTIVITY_ORDER: Record<ClubActivityStatus, number> = {
  official_activity: 0,
  official_rest: 1,
};

// PostgREST 1000행 cap 회피: order + range 로 전량 페이징(전 주차 집계 시 필수).
const PG_RANGE = 1000;
async function selectAllPaged<T>(
  makeOrderedQuery: () => {
    range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
  },
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PG_RANGE) {
    const { data, error } = await makeOrderedQuery().range(from, from + PG_RANGE - 1);
    if (error) throw new Error(error.message);
    const chunk = data ?? [];
    out.push(...chunk);
    if (chunk.length < PG_RANGE) break;
  }
  return out;
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

// season_key("2026-summer") → 한글 시즌명("여름"). cluster4PeriodLabel 미러.
const SEASON_KEY_TO_KO: Record<string, string> = {
  spring: "봄",
  summer: "여름",
  autumn: "가을",
  fall: "가을",
  winter: "겨울",
};
function seasonKoFromKey(seasonKey: string | null): string | null {
  if (!seasonKey) return null;
  for (const part of seasonKey.toLowerCase().split("-")) {
    const ko = SEASON_KEY_TO_KO[part];
    if (ko) return ko;
  }
  return null;
}

function yy(iso: string | null): string | null {
  if (!iso || iso.length < 4) return null;
  const year = Number(iso.slice(0, 4));
  if (!Number.isFinite(year)) return null;
  return String(((year % 100) + 100) % 100).padStart(2, "0");
}

// 표 주차명: "26 - 여름 - 3" (활동 관리 페이지의 관리 주차명 공용).
export function weekTableName(r: SeasonWeekDto): string {
  const year = yy(r.week_end_date ?? r.week_start_date ?? r.season_start_date);
  const season = seasonKoFromKey(r.season_key) ?? r.season_name ?? "-";
  const n = r.week_number ?? "-";
  return `${year ?? "--"} - ${season} - ${n}`;
}

// 배너 주차명: "26년 여름 시즌 3주차"
export function weekBannerName(r: SeasonWeekDto): string {
  const year = yy(r.week_end_date ?? r.week_start_date ?? r.season_start_date);
  const season = seasonKoFromKey(r.season_key) ?? r.season_name ?? "-";
  const n = r.week_number ?? "-";
  return `${year ?? "--"}년 ${season} 시즌 ${n}주차`;
}

export function weekRangeLabel(r: SeasonWeekDto): string {
  if (!r.week_start_date || !r.week_end_date) return "-";
  return `${formatClubDate(r.week_start_date)} ~ ${formatClubDate(r.week_end_date)}`;
}

// 오늘 라벨: "2026년 7/14(화)" — date-only ISO 를 그대로 달력 날짜로 해석.
export function formatTodayLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  return `${y}년 ${mo}/${d}(${weekday})`;
}

// 최신 주차가 최상단(week_start_date desc, null 은 최하단).
function cmpWeekStartDesc(a: SeasonWeekDto, b: SeasonWeekDto): number {
  const av = a.week_start_date;
  const bv = b.week_start_date;
  if (av === bv) return 0;
  if (!av) return 1;
  if (!bv) return -1;
  return av < bv ? 1 : -1;
}

// ── 전역 카탈로그 ────────────────────────────────────────────────────────────
//
// (구 loadActCatalog 제거 — 액트 전체/가동은 더 이상 "org·주차 무관 카탈로그 상수"가 아니다.
//  주차별 오픈 게이트 + 변동 액트가 반영되므로 공통 로더(loadActCheckApplicationInputsByWeek)가 산출한다.)

// 전체 라인(라인칸) = 허브별 카탈로그 합(org 기준).
//   info=activity_types(practical_info, 공통) + experience/competency 마스터(organization_slug=org).
//   테이블 미적용 시 해당 허브만 0 으로 graceful degrade.
async function loadTotalLines(org: OrganizationSlug): Promise<number> {
  const [info, exp, comp] = await Promise.all([
    supabaseAdmin
      .from("activity_types")
      .select("*", { count: "exact", head: true })
      .eq("cluster_id", "practical_info")
      .eq("is_active", true),
    supabaseAdmin
      .from("cluster4_experience_line_masters")
      .select("*", { count: "exact", head: true })
      .eq("organization_slug", org)
      .eq("is_active", true),
    supabaseAdmin
      .from("cluster4_competency_line_masters")
      .select("*", { count: "exact", head: true })
      .eq("organization_slug", org)
      .eq("is_active", true),
  ]);
  const n = (r: { count: number | null; error: unknown }) => (r.error ? 0 : r.count ?? 0);
  return n(info) + n(exp) + n(comp);
}

// id → organization_slug 벌크 조회(마스터 테이블 공용).
async function loadMasterOrgs(
  table: "cluster4_experience_line_masters" | "cluster4_competency_line_masters",
  ids: Set<string>,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.size === 0) return map;
  const { data, error } = await supabaseAdmin
    .from(table)
    .select("id,organization_slug")
    .in("id", [...ids]);
  if (error) {
    console.warn(`[team-parts/info/weeks] ${table} org read unavailable:`, error.message);
    return map;
  }
  for (const r of (data ?? []) as Array<{ id: string; organization_slug: string | null }>) {
    if (r.organization_slug) map.set(r.id, r.organization_slug);
  }
  return map;
}

// ── 주차별 집계(페이지 주차만) ────────────────────────────────────────────────

// (구 loadCompletedActsByWeek 제거 — status='completed' 만 세던 "완료율" 산식이었다.
//  신청율 = status ∈ {pending, completed} 이며, 판정·집계는 공통 로더/빌더가 담당한다.)

type OpenLineRow = {
  part_type: string | null;
  line_code: string | null;
  activity_type_id: string | null;
  experience_line_master_id: string | null;
  competency_line_master_id: string | null;
};

// 라인 org 판정(전 허브 공용): info=line_code 토큰, exp·comp=마스터 organization_slug.
//   canonical resolveLineScope 와 동치(code → master org). 마스터 org 는 벌크 맵으로 미리 조회.
function resolveLineOrg(
  line: OpenLineRow,
  expOrg: Map<string, string>,
  compOrg: Map<string, string>,
): LineOrgScope | null {
  const codeOrg = parseLineCodeOrg(line.line_code);
  if (codeOrg) return codeOrg;
  if (line.part_type === "experience" && line.experience_line_master_id) {
    return normalizeLineOrg(expOrg.get(line.experience_line_master_id));
  }
  if (line.part_type === "competency" && line.competency_line_master_id) {
    return normalizeLineOrg(compOrg.get(line.competency_line_master_id));
  }
  return null;
}

// 개설 라인의 카탈로그 단위 키(전체 라인 분모와 동일 단위 → 개설율 ≤100%).
//   info=activity_type_id · exp=experience_line_master_id · comp=competency_line_master_id.
function openLineKey(line: OpenLineRow): string | null {
  if (line.part_type === "info") return line.activity_type_id ? `info:${line.activity_type_id}` : null;
  if (line.part_type === "experience") {
    return line.experience_line_master_id ? `exp:${line.experience_line_master_id}` : null;
  }
  if (line.part_type === "competency") {
    return line.competency_line_master_id ? `comp:${line.competency_line_master_id}` : null;
  }
  return null;
}

// 주차별 오픈 라인 = 개설된 활성 라인(org 노출)의 서로 다른 카탈로그 단위 수(전 허브).
//   주차 링크: cluster4_line_targets.week_id(전 허브 공통) ∪ cluster4_lines.week_id(info 전용 excel).
async function loadOpenLinesByWeek(
  organization: OrganizationSlug,
  weekIds: string[],
): Promise<Map<string, number>> {
  if (weekIds.length === 0) return new Map();

  const rows: Array<{ weekId: string; line: OpenLineRow }> = [];

  const LINE_SELECT =
    "id,part_type,line_code,activity_type_id,experience_line_master_id,competency_line_master_id,is_active";

  // 1) 타깃(week_id) → 라인 (info·experience·competency 전부). cap-safe 페이징.
  try {
    const tRows = await selectAllPaged<{
      week_id: string | null;
      cluster4_lines: OpenLineRow | null;
    }>(() =>
      supabaseAdmin
        .from("cluster4_line_targets")
        .select(`week_id,cluster4_lines!inner(${LINE_SELECT})`)
        .in("week_id", weekIds)
        .eq("cluster4_lines.is_active", true)
        .in("cluster4_lines.part_type", LINE_HUBS as unknown as string[])
        .order("week_id") as unknown as {
        range: (from: number, to: number) => PromiseLike<{
          data: Array<{ week_id: string | null; cluster4_lines: OpenLineRow | null }> | null;
          error: { message: string } | null;
        }>;
      },
    );
    for (const row of tRows) {
      if (!row.week_id || !row.cluster4_lines) continue;
      rows.push({ weekId: row.week_id, line: row.cluster4_lines });
    }
  } catch (tErr) {
    console.warn(
      "[team-parts/info/weeks] cluster4_line_targets read unavailable:",
      tErr instanceof Error ? tErr.message : tErr,
    );
  }

  // 2) 타깃 없는 info 라인 대비 — cluster4_lines.week_id union(info 전용; 타 허브는 week_id NULL).
  try {
    const lRows = await selectAllPaged<OpenLineRow & { week_id: string | null }>(() =>
      supabaseAdmin
        .from("cluster4_lines")
        .select("part_type,line_code,activity_type_id,experience_line_master_id,competency_line_master_id,week_id")
        .eq("part_type", "info")
        .eq("is_active", true)
        .in("week_id", weekIds)
        .order("week_id"),
    );
    for (const line of lRows) {
      if (!line.week_id) continue;
      rows.push({ weekId: line.week_id, line });
    }
  } catch (lErr) {
    console.warn(
      "[team-parts/info/weeks] cluster4_lines read unavailable:",
      lErr instanceof Error ? lErr.message : lErr,
    );
  }

  // 마스터 org 벌크 조회(exp·comp).
  const expIds = new Set<string>();
  const compIds = new Set<string>();
  for (const { line } of rows) {
    if (line.experience_line_master_id) expIds.add(line.experience_line_master_id);
    if (line.competency_line_master_id) compIds.add(line.competency_line_master_id);
  }
  const [expOrg, compOrg] = await Promise.all([
    loadMasterOrgs("cluster4_experience_line_masters", expIds),
    loadMasterOrgs("cluster4_competency_line_masters", compIds),
  ]);

  const perWeek = new Map<string, Set<string>>();
  for (const { weekId, line } of rows) {
    const lineOrg = resolveLineOrg(line, expOrg, compOrg);
    if (!isLineVisibleForUserOrg(lineOrg, organization, { allowUnknown: false })) continue;
    const key = openLineKey(line);
    if (!key) continue;
    if (!perWeek.has(weekId)) perWeek.set(weekId, new Set());
    perWeek.get(weekId)!.add(key);
  }

  const counts = new Map<string, number>();
  for (const [weekId, set] of perWeek) counts.set(weekId, set.size);
  return counts;
}

// 레거시 폴백 입력 — weeks.result_reviewed_at != null(전역). 조직별 상태 행이 없는(대개 <2026-06-29)
//   주차의 "검수 완료" 폴백 판정용으로만 쓴다. QA overlay 는 쓰지 않는다(operating/test 동일 값 유지).
async function loadLegacyReviewed(weekIds: string[]): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>();
  if (weekIds.length === 0) return map;
  const { data, error } = await supabaseAdmin
    .from("weeks")
    .select("id,result_reviewed_at")
    .in("id", weekIds);
  if (error) {
    console.warn("[team-parts/info/weeks] weeks.result_reviewed_at read unavailable:", error.message);
    return map;
  }
  for (const row of (data ?? []) as Array<{
    id: string;
    result_reviewed_at: string | null;
  }>) {
    map.set(row.id, row.result_reviewed_at != null);
  }
  return map;
}

// 주차별 조직 검수 상태 — (week_id, organization) 조직별 상태 테이블이 SoT.
//   행 없으면 resolveWeekOrgResultState 로 판정(레거시 주차는 result_reviewed_at 폴백, 그 외 aggregating).
//   ⚠ operating/test 동일 값(조직별 상태는 모집단과 무관 — 검수 이벤트는 org 단위 1건).
async function loadWeekReviewStatus(
  metaRows: SeasonWeekDto[],
  organization: OrganizationSlug,
  scope: OrgResultScope,
): Promise<Map<string, WeekOrgResultStatus>> {
  const map = new Map<string, WeekOrgResultStatus>();
  const weekIds = metaRows.map((r) => r.week_id);
  if (weekIds.length === 0) return map;
  const [orgStates, legacyReviewed] = await Promise.all([
    loadWeekOrgResultStates(weekIds, organization, scope),
    loadLegacyReviewed(weekIds),
  ]);
  for (const r of metaRows) {
    const status = resolveWeekOrgResultState(
      orgStates.get(r.week_id),
      r.week_start_date ?? "",
      legacyReviewed.get(r.week_id) === true,
    ).status;
    map.set(r.week_id, status);
  }
  return map;
}

// 주차 메타 rows(페이지 또는 전체)에 대해 집계 아이템을 만든다.
//   전역 카탈로그(액트·전체 라인)는 주차와 무관, 주차별 집계(체크율·오픈라인·검수)는 weekIds 기준.
async function buildItems(
  organization: OrganizationSlug,
  metaRows: SeasonWeekDto[],
  mode: ScopeMode,
): Promise<TeamPartsInfoWeekItem[]> {
  const weekIds = metaRows.map((r) => r.week_id);
  // 액트 요약 = 상세와 동일한 공통 로더(주차별 오픈 게이트·신청 판정·변동 포함)를 1회 벌크 호출.
  //   ⚠ 액트 카탈로그/상태행/변동/오픈설정은 로더가 한 번에 모아 오므로 주차 수만큼 N+1 이 생기지 않는다.
  const [totalLines, actInputsByWeek, openLinesByWeek, reviewStatusByWeek] = await Promise.all([
    loadTotalLines(organization),
    loadActCheckApplicationInputsByWeek({ weekIds, organization, mode }),
    loadOpenLinesByWeek(organization, weekIds),
    loadWeekReviewStatus(metaRows, organization, resolveOrgResultScope(mode)),
  ]);

  return metaRows.map((r) => {
    const openLines = openLinesByWeek.get(r.week_id) ?? 0;
    const inputs = actInputsByWeek.get(r.week_id) ?? { regular: [], variable: [] };
    const reviewStatus = reviewStatusByWeek.get(r.week_id) ?? "aggregating";
    return {
      weekId: r.week_id,
      weekName: weekTableName(r),
      clubActivityStatus: r.is_official_rest ? "official_rest" : "official_activity",
      // 목록 전용 산식 금지 — 상세와 동일 빌더.
      actCheck: buildActCheckApplicationSummary(inputs.regular, inputs.variable),
      lineOpenRate: totalLines > 0 ? Math.round((openLines / totalLines) * 100) : 0,
      totalLines,
      openLines,
      reviewStatus,
      weekReviewed: reviewStatus === "published",
      isCurrentWeek: r.is_current_week,
    };
  });
}

// 빈값(방향 무관 최하단) 처리 후 base 비교값에 방향 적용.
function directionWithEmptyLast(
  aEmpty: boolean,
  bEmpty: boolean,
  base: number,
  dir: WeeksSortDir,
): number {
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  return dir === "asc" ? base : -base;
}

// meta 정렬(전 주차) — 주차명=시작일 기준 연대순(주차/연도 숫자 정합), 클럽활동=업무 순서.
//   동률은 기본순(최신 최상단)으로 안정화.
function sortMeta(metaRows: SeasonWeekDto[], sort: WeeksSort): SeasonWeekDto[] {
  const arr = [...metaRows];
  arr.sort((a, b) => {
    if (sort.key === "weekName") {
      const av = a.week_start_date;
      const bv = b.week_start_date;
      const base = av === bv ? 0 : (av ?? "") < (bv ?? "") ? -1 : 1;
      const r = directionWithEmptyLast(!av, !bv, base, sort.dir);
      return r !== 0 ? r : cmpWeekStartDesc(a, b);
    }
    // clubActivityStatus — CLUB_ACTIVITY_ORDER(활동 → 휴식).
    const ao = a.is_official_rest ? CLUB_ACTIVITY_ORDER.official_rest : CLUB_ACTIVITY_ORDER.official_activity;
    const bo = b.is_official_rest ? CLUB_ACTIVITY_ORDER.official_rest : CLUB_ACTIVITY_ORDER.official_activity;
    const base = ao - bo;
    const r = sort.dir === "asc" ? base : -base;
    return r !== 0 ? r : cmpWeekStartDesc(a, b);
  });
  return arr;
}

// aggregate 정렬(전 주차 집계 아이템) — 숫자/불리언 실제 값 기준, 빈값 최하단, 동률=기본순 안정.
function sortAggregateItems(
  items: TeamPartsInfoWeekItem[],
  sort: WeeksSort,
): TeamPartsInfoWeekItem[] {
  const valueOf = (it: TeamPartsInfoWeekItem): number | null => {
    switch (sort.key) {
      case "actCheckApplicationRate":
        return it.actCheck.applicationRate;
      case "lineOpenRate":
        return it.lineOpenRate;
      case "openLines":
        return it.openLines;
      case "weekReviewed":
        // 집계 중(0) < 검수 중(1) < 검수 완료(2) 순위로 정렬.
        return it.reviewStatus === "published" ? 2 : it.reviewStatus === "reviewing" ? 1 : 0;
      default:
        return null;
    }
  };
  // items 는 이미 기본순(최신 최상단) — 안정 정렬이라 동률은 기본순 유지.
  const arr = [...items];
  arr.sort((a, b) => {
    const av = valueOf(a);
    const bv = valueOf(b);
    const base = (av ?? 0) === (bv ?? 0) ? 0 : (av ?? 0) < (bv ?? 0) ? -1 : 1;
    return directionWithEmptyLast(av == null, bv == null, base, sort.dir);
  });
  return arr;
}

// ── 메인 로더 ────────────────────────────────────────────────────────────────

export async function loadTeamPartsInfoWeeks(opts: {
  organization: OrganizationSlug;
  page: number;
  pageSize: number;
  // 변동 액트 스코프(process_irregular_acts.scope_mode). 상세와 동일 규칙 — 미지정 시 operating.
  //   ⚠ 액트 요약만 mode 스코프를 탄다(정규 카탈로그·라인·검수 메타는 mode 불변).
  mode?: ScopeMode;
  // 서버사이드 정렬(전체 목록 기준). 미지정 시 기본순(최신 주차 최상단).
  sort?: WeeksSort | null;
  // 검증용 오늘 고정 훅(미지정 시 서버 활동 기준일).
  today?: string;
}): Promise<TeamPartsInfoWeeksData> {
  const { organization, today } = opts;
  const mode: ScopeMode = opts.mode ?? "operating";
  const sort = opts.sort ?? null;
  const page = Math.max(1, Math.floor(opts.page) || 1);
  const pageSize = Math.min(
    MAX_WEEKS_PAGE_SIZE,
    Math.max(1, Math.floor(opts.pageSize) || DEFAULT_WEEKS_PAGE_SIZE),
  );

  // 1) 전 주차 목록(전역) — 기본순 = 최신 주차 최상단.
  const { rows } = await loadSeasonWeeks(today);
  const defaultOrdered = [...rows].sort(cmpWeekStartDesc);

  const totalCount = defaultOrdered.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const startIdx = (page - 1) * pageSize;

  // 2) 정렬 방식 분기 — 전체 목록 기준으로 정렬한 뒤 페이지를 나눈다.
  let items: TeamPartsInfoWeekItem[];
  if (sort && !META_SORT_KEYS.has(sort.key)) {
    // aggregate 키: 전 주차 집계 → 정렬 → 페이지 슬라이스(집계 cap-safe).
    const allItems = await buildItems(organization, defaultOrdered, mode);
    items = sortAggregateItems(allItems, sort).slice(startIdx, startIdx + pageSize);
  } else {
    // 기본/meta 키: meta 전체 정렬 → 페이지 슬라이스 → 페이지 주차만 집계(기존 저비용 경로).
    const orderedMeta = sort ? sortMeta(defaultOrdered, sort) : defaultOrdered;
    const pageRows = orderedMeta.slice(startIdx, startIdx + pageSize);
    items = await buildItems(organization, pageRows, mode);
  }

  // 3) 현재 주차 배너 — is_current_week 행(전역).
  const currentRow = rows.find((r) => r.is_current_week) ?? null;
  const todayIso = today ?? getCurrentActivityDateIso();
  const currentWeek: TeamPartsInfoCurrentWeek = {
    todayLabel: formatTodayLabel(todayIso),
    seasonWeekName: currentRow ? weekBannerName(currentRow) : null,
    weekRangeLabel: currentRow ? weekRangeLabel(currentRow) : null,
    clubActivityStatus: currentRow
      ? currentRow.is_official_rest
        ? "official_rest"
        : "official_activity"
      : null,
  };

  return {
    organization,
    currentWeek,
    items,
    pagination: { page, pageSize, totalCount, totalPages },
  };
}

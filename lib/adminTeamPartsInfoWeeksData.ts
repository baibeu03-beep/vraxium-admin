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
//   · 전체 액트 / 가동 액트        = process_acts (hub ∈ LINE_HUBS) 카탈로그 (전역 상수·org 무관)
//   · 액트 체크율                  = process_check_statuses(org, hub ∈ LINE_HUBS, week) 의
//                                     COUNT(DISTINCT act_id, status=completed ∩ 가동 액트) / 가동 액트
//                                     (experience 는 팀/파트별 다중행 → DISTINCT act_id 로 ≤100% 보장)
//   · 전체 라인(라인칸)            = 허브별 카탈로그 합(org):
//                                     info=activity_types(practical_info, 공통 9)
//                                     + experience=cluster4_experience_line_masters(org)
//                                     + competency=cluster4_competency_line_masters(org)
//   · 오픈 라인 / 라인칸 개설율    = 주차에 개설된 활성 라인(org 노출)의 서로 다른 카탈로그 단위 수
//                                     info=activity_type_id · exp=experience_line_master_id · comp=competency_line_master_id
//                                     주차 링크 = cluster4_line_targets.week_id(전 허브 공통) ∪ cluster4_lines.week_id(info 전용)
//                                     org 노출 = info: line_code 토큰 / exp·comp: 마스터 organization_slug
//   · 주차 검수                    = weeks.result_reviewed_at != null (주차 전역 — org 무관)
//
// mode(operating/test)는 이 메타/카탈로그 집계에 영향을 주지 않는다:
//   주차·시즌·액트 카탈로그·라인칸·개설 라인 목록·검수 여부는 사용자 모집단과 무관하므로,
//   operating 과 test 는 구조뿐 아니라 값까지 동일한 DTO 를 돌려준다(요구사항: 두 경로 동일 DTO).

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
import type { OrganizationSlug } from "@/lib/organizations";

// 라인 허브 = cluster4_lines.part_type 중 운영 라인 3종(career 제외). 액트/라인 집계 공통 축.
const LINE_HUBS = ["info", "experience", "competency"] as const;

export type ClubActivityStatus = "official_activity" | "official_rest";

export type TeamPartsInfoWeekItem = {
  weekId: string;
  weekName: string;
  clubActivityStatus: ClubActivityStatus;
  actCheckRate: number; // 0~100 (%)
  totalActs: number;
  activeActs: number;
  lineOpenRate: number; // 0~100 (%)
  totalLines: number;
  openLines: number;
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

// 액트 카탈로그(전 라인 허브·org 무관 상수).
//   totalActs = 활성 액트, activeActIds = 그중 체크 대상(check_target='check') id 집합.
async function loadActCatalog(): Promise<{ totalActs: number; activeActIds: Set<string> }> {
  const { data, error } = await supabaseAdmin
    .from("process_acts")
    .select("id,check_target")
    .in("hub", LINE_HUBS as unknown as string[])
    .eq("is_active", true);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{ id: string; check_target: string | null }>;
  const activeActIds = new Set(
    rows.filter((r) => r.check_target === "check").map((r) => r.id),
  );
  return { totalActs: rows.length, activeActIds };
}

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

// 주차별 완료(completed) 액트 수 — (org, hub ∈ LINE_HUBS, week) 상태행 기준.
//   experience 는 팀/파트별 다중행이라 COUNT(DISTINCT act_id) 로 접는다(정보/역량은 단일행이라 no-op).
//   가동 액트(activeActIds)와 교집합만 세어 체크율 ≤100% 를 보장한다.
async function loadCompletedActsByWeek(
  organization: OrganizationSlug,
  weekIds: string[],
  activeActIds: Set<string>,
): Promise<Map<string, number>> {
  if (weekIds.length === 0) return new Map();
  const { data, error } = await supabaseAdmin
    .from("process_check_statuses")
    .select("week_id,act_id")
    .eq("organization_slug", organization)
    .in("hub", LINE_HUBS as unknown as string[])
    .eq("status", "completed")
    .in("week_id", weekIds);
  if (error) {
    // 마이그레이션 미적용 등 → 빈 집계로 graceful degrade(전부 0%).
    console.warn("[team-parts/info/weeks] process_check_statuses read unavailable:", error.message);
    return new Map();
  }
  const perWeek = new Map<string, Set<string>>();
  for (const row of (data ?? []) as Array<{ week_id: string | null; act_id: string | null }>) {
    if (!row.week_id || !row.act_id) continue;
    if (!activeActIds.has(row.act_id)) continue;
    if (!perWeek.has(row.week_id)) perWeek.set(row.week_id, new Set());
    perWeek.get(row.week_id)!.add(row.act_id);
  }
  const counts = new Map<string, number>();
  for (const [weekId, set] of perWeek) counts.set(weekId, set.size);
  return counts;
}

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

  // 1) 타깃(week_id) → 라인 (info·experience·competency 전부).
  const { data: tRows, error: tErr } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select(`week_id,cluster4_lines!inner(${LINE_SELECT})`)
    .in("week_id", weekIds)
    .eq("cluster4_lines.is_active", true)
    .in("cluster4_lines.part_type", LINE_HUBS as unknown as string[]);
  if (tErr) {
    console.warn("[team-parts/info/weeks] cluster4_line_targets read unavailable:", tErr.message);
  } else {
    for (const row of (tRows ?? []) as unknown as Array<{
      week_id: string | null;
      cluster4_lines: OpenLineRow | null;
    }>) {
      if (!row.week_id || !row.cluster4_lines) continue;
      rows.push({ weekId: row.week_id, line: row.cluster4_lines });
    }
  }

  // 2) 타깃 없는 info 라인 대비 — cluster4_lines.week_id union(info 전용; 타 허브는 week_id NULL).
  const { data: lRows, error: lErr } = await supabaseAdmin
    .from("cluster4_lines")
    .select("part_type,line_code,activity_type_id,experience_line_master_id,competency_line_master_id,week_id")
    .eq("part_type", "info")
    .eq("is_active", true)
    .in("week_id", weekIds);
  if (lErr) {
    console.warn("[team-parts/info/weeks] cluster4_lines read unavailable:", lErr.message);
  } else {
    for (const line of (lRows ?? []) as Array<OpenLineRow & { week_id: string | null }>) {
      if (!line.week_id) continue;
      rows.push({ weekId: line.week_id, line });
    }
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

// 주차별 검수 여부 — weeks.result_reviewed_at != null(주차 전역). QA overlay 는 쓰지 않는다
//   (operating/test 동일 값 유지). 컬럼 미적용 환경이면 전부 false 로 graceful degrade.
async function loadWeekReviewed(weekIds: string[]): Promise<Map<string, boolean>> {
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

// ── 메인 로더 ────────────────────────────────────────────────────────────────

export async function loadTeamPartsInfoWeeks(opts: {
  organization: OrganizationSlug;
  page: number;
  pageSize: number;
  // 검증용 오늘 고정 훅(미지정 시 서버 활동 기준일).
  today?: string;
}): Promise<TeamPartsInfoWeeksData> {
  const { organization, today } = opts;
  const page = Math.max(1, Math.floor(opts.page) || 1);
  const pageSize = Math.min(
    MAX_WEEKS_PAGE_SIZE,
    Math.max(1, Math.floor(opts.pageSize) || DEFAULT_WEEKS_PAGE_SIZE),
  );

  // 1) 전 주차 목록(전역) — 최신 주차 최상단.
  const { rows } = await loadSeasonWeeks(today);
  const sorted = [...rows].sort(cmpWeekStartDesc);

  const totalCount = sorted.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const startIdx = (page - 1) * pageSize;
  const pageRows = sorted.slice(startIdx, startIdx + pageSize);
  const weekIds = pageRows.map((r) => r.week_id);

  // 2) 전역 카탈로그 + 주차별 집계(페이지 주차만).
  const actCatalog = await loadActCatalog();
  const totalActs = actCatalog.totalActs;
  const activeActs = actCatalog.activeActIds.size;
  const [totalLines, completedByWeek, openLinesByWeek, reviewedByWeek] =
    await Promise.all([
      loadTotalLines(organization),
      loadCompletedActsByWeek(organization, weekIds, actCatalog.activeActIds),
      loadOpenLinesByWeek(organization, weekIds),
      loadWeekReviewed(weekIds),
    ]);

  const items: TeamPartsInfoWeekItem[] = pageRows.map((r) => {
    const completed = completedByWeek.get(r.week_id) ?? 0;
    const openLines = openLinesByWeek.get(r.week_id) ?? 0;
    return {
      weekId: r.week_id,
      weekName: weekTableName(r),
      clubActivityStatus: r.is_official_rest ? "official_rest" : "official_activity",
      actCheckRate: activeActs > 0 ? Math.round((completed / activeActs) * 100) : 0,
      totalActs,
      activeActs,
      lineOpenRate: totalLines > 0 ? Math.round((openLines / totalLines) * 100) : 0,
      totalLines,
      openLines,
      weekReviewed: reviewedByWeek.get(r.week_id) === true,
      isCurrentWeek: r.is_current_week,
    };
  });

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

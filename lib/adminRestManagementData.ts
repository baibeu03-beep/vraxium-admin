import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { OrganizationSlug } from "@/lib/organizations";
import {
  getCurrentActivityDateIso,
  operationalSeasonDbKey,
} from "@/lib/seasonCalendar";

// ─────────────────────────────────────────────────────────────────────
// /admin/rest-management 상단 요약 데이터 소스.
//
// 데이터: vacation_requests (크루 주차 휴식 신청). org + season_key 기준 집계.
//   - 전체(total)  : 해당 시즌 신청 건수 (week 기준 = row 수)
//   - 정상(normal) : request_type = 'normal'
//   - 긴급(urgent) : request_type = 'urgent'
//   - 크루(crews)  : distinct user_id (동일 크루가 여러 주차 신청해도 1명)
//
// request_type 컬럼(2026-07-09 마이그레이션)이 아직 적용되지 않은 환경(42703)에서는
//   전부 normal 로 폴백해 페이지가 깨지지 않게 한다(마이그레이션 적용 후 정상 동작).
//
// mode(operating/test)는 이 페이지 집계 모집단을 바꾸지 않는다 — URL 로만 보존(스펙: org·mode
//   여부와 무관하게 동일 구조·실제 DB 기준). 추후 test 계정 필터가 필요하면 여기서 확장한다.
// ─────────────────────────────────────────────────────────────────────

export type RestManagementSeasonOption = {
  season_key: string;
  season_label: string;
};

export type RestManagementSummary = {
  total: number;
  normal: number;
  urgent: number;
  crews: number;
};

export type RestManagementOverview = {
  seasons: RestManagementSeasonOption[];
  seasonKey: string;
  summary: RestManagementSummary;
};

const EMPTY_SUMMARY: RestManagementSummary = {
  total: 0,
  normal: 0,
  urgent: 0,
  crews: 0,
};

// season_key("2026-summer") → 표시 라벨("2026 여름"). season_definitions.season_label 이
//   없을 때의 폴백. front/admin 공용 시즌 코드 규칙(seasonCalendar)과 동일.
const SEASON_CODE_KO: Record<string, string> = {
  winter: "겨울",
  spring: "봄",
  summer: "여름",
  autumn: "가을",
};

function seasonKeyLabel(seasonKey: string): string {
  const [year, code] = seasonKey.split("-");
  const ko = code ? SEASON_CODE_KO[code] : undefined;
  return ko ? `${year} ${ko}` : seasonKey;
}

type SeasonDefinitionRow = {
  season_key: string;
  season_label: string | null;
  start_date: string | null;
};

function seasonStartMs(row: SeasonDefinitionRow): number {
  return row.start_date ? Date.parse(row.start_date) : 0;
}

// vacation_requests 를 org+season_key 로 페이지네이션 조회(PostgREST 1000행 cap 회피).
//   withType=true → request_type 포함, false → user_id 만(42703 폴백 경로).
type VacationRow = { user_id: string; request_type?: string | null };

async function fetchVacationRows(
  org: OrganizationSlug,
  seasonKey: string,
  withType: boolean,
): Promise<VacationRow[]> {
  const PAGE = 1000;
  const cols = withType ? "user_id,request_type" : "user_id";
  const out: VacationRow[] = [];
  let from = 0;
  for (;;) {
    const res = await supabaseAdmin
      .from("vacation_requests")
      .select(cols)
      .eq("org", org)
      .eq("season_key", seasonKey)
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (res.error) {
      throw Object.assign(new Error(res.error.message), {
        code: res.error.code,
      });
    }
    const batch = (res.data ?? []) as unknown as VacationRow[];
    out.push(...batch);
    if (batch.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

function isMissingColumn(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "42703"
  );
}

async function computeSummary(
  org: OrganizationSlug,
  seasonKey: string,
): Promise<RestManagementSummary> {
  let rows: VacationRow[];
  let hasType = true;
  try {
    rows = await fetchVacationRows(org, seasonKey, true);
  } catch (error) {
    if (!isMissingColumn(error)) throw error;
    // request_type 미적용(마이그레이션 전) → 전부 정상으로 폴백.
    rows = await fetchVacationRows(org, seasonKey, false);
    hasType = false;
  }

  const users = new Set<string>();
  let normal = 0;
  let urgent = 0;
  for (const row of rows) {
    users.add(row.user_id);
    if (hasType && row.request_type === "urgent") urgent += 1;
    else normal += 1;
  }

  return {
    total: rows.length,
    normal,
    urgent,
    crews: users.size,
  };
}

// 시즌 드롭다운 옵션 + 선택 시즌 + 요약을 한 번에 반환한다.
//   seasonKeyParam 이 유효(옵션에 존재)하면 그 시즌, 아니면 현재(운영) 시즌으로 기본 선택한다.
export async function loadRestManagementOverview(
  org: OrganizationSlug,
  seasonKeyParam: string | null,
): Promise<RestManagementOverview> {
  const seasonRes = await supabaseAdmin
    .from("season_definitions")
    .select("season_key,season_label,start_date")
    .order("start_date", { ascending: false });
  if (seasonRes.error) throw new Error(seasonRes.error.message);

  const defRows = (seasonRes.data ?? []) as SeasonDefinitionRow[];
  const seasons: RestManagementSeasonOption[] = [...defRows]
    .sort((a, b) => seasonStartMs(b) - seasonStartMs(a))
    .map((s) => ({
      season_key: s.season_key,
      season_label: s.season_label ?? seasonKeyLabel(s.season_key),
    }));

  // 현재(운영) 시즌 — 전환 주차면 다음 시즌. 드롭다운 기본 선택값.
  const currentKey = operationalSeasonDbKey(getCurrentActivityDateIso());

  // 현재 시즌이 season_definitions 에 없더라도 선택 가능하도록 최상단에 보강.
  if (currentKey && !seasons.some((s) => s.season_key === currentKey)) {
    seasons.unshift({
      season_key: currentKey,
      season_label: seasonKeyLabel(currentKey),
    });
  }

  const seasonKey =
    (seasonKeyParam && seasons.some((s) => s.season_key === seasonKeyParam)
      ? seasonKeyParam
      : null) ??
    currentKey ??
    seasons[0]?.season_key ??
    "";

  const summary = seasonKey
    ? await computeSummary(org, seasonKey)
    : EMPTY_SUMMARY;

  return { seasons, seasonKey, summary };
}

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { OrganizationSlug } from "@/lib/organizations";
import {
  getCurrentActivityDateIso,
  getSeasonForDate,
  hasWeekStartedKst,
  operationalSeasonDbKey,
} from "@/lib/seasonCalendar";
import { classLabel, memberStatusLabel } from "@/lib/adminMembersTypes";
import { formatBannerPeriod } from "@/lib/practicalInfoSection0Format";
import { revokeForAct } from "@/lib/processPointAccrual";
import { invalidateWeeklyCardsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";

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

// ─────────────────────────────────────────────────────────────────────
// 신청 목록(Table) — org+season 기준 전체 행(요약과 동일 데이터 소스/기준).
//
// 한 행 = 1개 주차 + 1명 크루. 정렬 = 주차 최신순 → 같은 주차 내 신청 시점 최신순.
// 페이지네이션은 클라이언트에서 20개/페이지로 슬라이스(전체 행 반환).
//
// 진행 상태(displayStatus):
//   - 대상 주차가 이미 종료(week_start_date < 이번 주 월요일) → "fulfilled"(휴식 이행)
//   - 그 외 approved → "approved"(휴식 승인) / pending → "pending"(휴식 신청)
// 크루/소속 팀/클래스는 /admin/members 와 동일 resolver(현재 소속·등급, mode 무관)로 파생한다.
// ─────────────────────────────────────────────────────────────────────

export type RestRequestDisplayStatus = "pending" | "approved" | "fulfilled";

export type RestRequestListRow = {
  id: string;
  displayStatus: RestRequestDisplayStatus; // 진행 상태
  ended: boolean; // 대상 주차 종료 여부(이행)
  weekLabel: string; // 주차 "26년, 여름, 7주차"
  weekStartDate: string | null;
  requestType: "normal" | "urgent"; // 분류
  crewName: string | null; // 크루
  teamName: string | null; // 소속 팀
  classLabel: string; // 클래스
  reason: string | null; // 사유(전체 — 표시 절단은 UI)
  // 긴급 휴식을 대신 신청한 운영진(requested_by_user_id). 일반 신청은 null.
  requestedByName: string | null;
  requestedByRoleLabel: string | null; // 팀장/앰배서더/관리자
  createdAt: string | null;
  createdAtLabel: string; // "2026년 7월 14일 오전 9:00"(KST)
};

export type RestManagementListResult = {
  rows: RestRequestListRow[];
  total: number;
};

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

function isoToUtcMs(iso: string): number {
  return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
}

// 시즌 내 상대 주차(1..N). backfill 산식(=(start_date − season_start)/7 + 1)과 동일.
function weekNumberInSeason(weekStartIso: string): number | null {
  const season = getSeasonForDate(weekStartIso);
  if (!season) return null;
  const n =
    Math.floor((isoToUtcMs(weekStartIso) - isoToUtcMs(season.startDate)) / WEEK_MS) + 1;
  return n >= 1 ? n : null;
}

// "26년, 여름, 7주차" — season_key(연도·시즌명) + week_start_date(상대 주차).
function restWeekLabel(seasonKey: string | null, weekStartDate: string | null): string {
  if (!seasonKey || !weekStartDate) return "기간 미상";
  const [yearStr, code] = seasonKey.split("-");
  const seasonName = code ? SEASON_CODE_KO[code] : undefined;
  const year = Number(yearStr);
  const weekNumber = weekNumberInSeason(weekStartDate);
  if (!seasonName || !Number.isFinite(year) || weekNumber == null) return "기간 미상";
  return formatBannerPeriod({ year, seasonName, weekNumber });
}

// 이번 주 월요일(KST 활동일 기준) ISO. 주차 종료 판정 경계.
function currentWeekMondayIso(): string {
  const ms = isoToUtcMs(getCurrentActivityDateIso());
  const dow = new Date(ms).getUTCDay(); // 0=일 … 6=토
  const offset = (dow + 6) % 7; // 월요일까지 되돌릴 일수
  return new Date(ms - offset * DAY_MS).toISOString().slice(0, 10);
}

// 대상 주차가 이미 종료됐는가(= 대상 월요일이 이번 주 월요일보다 과거). null=판정 불가→미종료.
function isWeekEnded(weekStartDate: string | null, currentMonday: string): boolean {
  if (!weekStartDate) return false;
  return weekStartDate < currentMonday;
}

// "2026년 7월 14일 오전 9:00" — timestamptz 를 KST 기준으로. (지역 무관 — timeZone 고정)
const KST_DATETIME_FMT = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});
function formatKstDateTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : KST_DATETIME_FMT.format(d);
}

// ── 크루 표시(크루명·소속 팀·클래스) — /admin/members 와 동일 SoT ─────────────
//   team = user_memberships(pickBestMembership) → user_profiles.current_team_name 폴백.
//   class = classLabel(user_profiles.role, membership_level). mode 무관(현재 소속/등급).
type MembershipRow = {
  user_id: string;
  team_name: string | null;
  membership_level: string | null;
  is_current: boolean | null;
  updated_at: string | null;
};

function membershipRank(r: MembershipRow): number {
  const isCurrent = Boolean(r.is_current);
  const hasTeam = typeof r.team_name === "string" && r.team_name.trim() !== "";
  if (isCurrent && hasTeam) return 0;
  if (hasTeam) return 1;
  if (isCurrent) return 2;
  return 3;
}

function pickBestMembership(rows: MembershipRow[]): MembershipRow | undefined {
  return [...rows].sort((a, b) => {
    const d = membershipRank(a) - membershipRank(b);
    if (d !== 0) return d;
    return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
  })[0];
}

function preferString(...vals: Array<string | null | undefined>): string | null {
  for (const v of vals) if (typeof v === "string" && v.trim()) return v;
  return null;
}

type CrewInfo = { crewName: string | null; teamName: string | null; classLabel: string };

async function resolveCrewInfo(userIds: string[]): Promise<Map<string, CrewInfo>> {
  const out = new Map<string, CrewInfo>();
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length === 0) return out;

  const ID_CHUNK = 100; // IN() URL 길이 방어
  const profileById = new Map<
    string,
    { display_name: string | null; role: string | null; current_team_name: string | null }
  >();
  const membershipsByUser = new Map<string, MembershipRow[]>();

  for (let i = 0; i < unique.length; i += ID_CHUNK) {
    const chunk = unique.slice(i, i + ID_CHUNK);
    const [pRes, mRes] = await Promise.all([
      supabaseAdmin
        .from("user_profiles")
        .select("user_id,display_name,role,current_team_name")
        .in("user_id", chunk),
      supabaseAdmin
        .from("user_memberships")
        .select("user_id,team_name,membership_level,is_current,updated_at")
        .in("user_id", chunk),
    ]);
    if (pRes.error) throw new Error(pRes.error.message);
    if (mRes.error) throw new Error(mRes.error.message);
    for (const p of (pRes.data ?? []) as Array<{
      user_id: string;
      display_name: string | null;
      role: string | null;
      current_team_name: string | null;
    }>) {
      profileById.set(p.user_id, {
        display_name: p.display_name,
        role: p.role,
        current_team_name: p.current_team_name,
      });
    }
    for (const m of (mRes.data ?? []) as MembershipRow[]) {
      const arr = membershipsByUser.get(m.user_id) ?? [];
      arr.push(m);
      membershipsByUser.set(m.user_id, arr);
    }
  }

  for (const uid of unique) {
    const p = profileById.get(uid);
    const best = pickBestMembership(membershipsByUser.get(uid) ?? []);
    out.set(uid, {
      crewName: p?.display_name ?? null,
      teamName: preferString(best?.team_name ?? null, p?.current_team_name ?? null),
      classLabel: classLabel(p?.role ?? null, best?.membership_level ?? null),
    });
  }
  return out;
}

type VacationListRow = {
  id: string;
  user_id: string;
  season_key: string | null;
  week_start_date: string | null;
  reason: string | null;
  status: string | null;
  request_type?: string | null;
  requested_by_user_id?: string | null;
  created_at: string | null;
};

// org+season 전체 행(정렬 적용) — PostgREST 1000행 cap 페이지네이션.
//   3단계 컬럼 폴백: full(request_type+requested_by_user_id) → type(request_type만) → base.
//   미적용 컬럼(42703)이 섞여 있어도 페이지가 깨지지 않게 각 컬럼을 독립적으로 강등한다
//   (2026-07-09 request_type · 2026-07-12 requested_by_user_id 각각 별개 마이그레이션).
const REST_COLS_FULL =
  "id,user_id,season_key,week_start_date,reason,status,request_type,requested_by_user_id,created_at";
const REST_COLS_TYPE =
  "id,user_id,season_key,week_start_date,reason,status,request_type,created_at";
const REST_COLS_BASE =
  "id,user_id,season_key,week_start_date,reason,status,created_at";

async function fetchVacationListRows(
  org: OrganizationSlug,
  seasonKey: string,
): Promise<VacationListRow[]> {
  const PAGE = 1000;
  const tiers = [REST_COLS_FULL, REST_COLS_TYPE, REST_COLS_BASE];
  const fetchPage = (cols: string, from: number) =>
    supabaseAdmin
      .from("vacation_requests")
      .select(cols)
      .eq("org", org)
      .eq("season_key", seasonKey)
      .order("week_start_date", { ascending: false })
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);

  let tier = 0;
  const out: VacationListRow[] = [];
  let from = 0;
  for (;;) {
    let res = await fetchPage(tiers[tier], from);
    // 미존재 컬럼(42703)이면 다음 단계로 강등하고 같은 페이지를 재시도.
    while (res.error && res.error.code === "42703" && tier < tiers.length - 1) {
      tier += 1;
      res = await fetchPage(tiers[tier], from);
    }
    if (res.error) throw new Error(res.error.message);
    const batch = (res.data ?? []) as unknown as VacationListRow[];
    out.push(...batch);
    if (batch.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

// 신청자(requested_by_user_id) 표시 정보 — 이름 + 역할 라벨(팀장/앰배서더/관리자).
//   등급 SoT = user_memberships.membership_level, 역할 = user_profiles.role(memberStatusLabel).
type RequesterInfo = { name: string | null; roleLabel: string | null };

async function resolveRequesterInfo(
  userIds: string[],
): Promise<Map<string, RequesterInfo>> {
  const out = new Map<string, RequesterInfo>();
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length === 0) return out;

  const ID_CHUNK = 100;
  const profileById = new Map<string, { display_name: string | null; role: string | null }>();
  const membershipsByUser = new Map<string, MembershipRow[]>();

  for (let i = 0; i < unique.length; i += ID_CHUNK) {
    const chunk = unique.slice(i, i + ID_CHUNK);
    const [pRes, mRes] = await Promise.all([
      supabaseAdmin
        .from("user_profiles")
        .select("user_id,display_name,role")
        .in("user_id", chunk),
      supabaseAdmin
        .from("user_memberships")
        .select("user_id,team_name,membership_level,is_current,updated_at")
        .in("user_id", chunk),
    ]);
    if (pRes.error) throw new Error(pRes.error.message);
    if (mRes.error) throw new Error(mRes.error.message);
    for (const p of (pRes.data ?? []) as Array<{
      user_id: string;
      display_name: string | null;
      role: string | null;
    }>) {
      profileById.set(p.user_id, { display_name: p.display_name, role: p.role });
    }
    for (const m of (mRes.data ?? []) as MembershipRow[]) {
      const arr = membershipsByUser.get(m.user_id) ?? [];
      arr.push(m);
      membershipsByUser.set(m.user_id, arr);
    }
  }

  for (const uid of unique) {
    const p = profileById.get(uid);
    const best = pickBestMembership(membershipsByUser.get(uid) ?? []);
    out.set(uid, {
      name: p?.display_name?.trim() || null,
      roleLabel: memberStatusLabel(p?.role ?? null, best?.membership_level ?? null),
    });
  }
  return out;
}

export async function loadRestManagementList(
  org: OrganizationSlug,
  seasonKey: string,
): Promise<RestManagementListResult> {
  const raw = await fetchVacationListRows(org, seasonKey);
  const crews = await resolveCrewInfo(raw.map((r) => r.user_id));
  // 긴급 신청자(대신 신청한 운영진) — urgent 행의 requested_by_user_id 만 조회.
  const requesters = await resolveRequesterInfo(
    raw
      .filter((r) => r.request_type === "urgent" && r.requested_by_user_id)
      .map((r) => r.requested_by_user_id as string),
  );
  const currentMonday = currentWeekMondayIso();
  const nowMs = Date.now();

  const rows: RestRequestListRow[] = raw.map((r) => {
    const isUrgent = r.request_type === "urgent";
    // 진행 상태 경계 — 일반과 긴급이 다르다(스펙):
    //   · 일반: 대상 주차가 "종료(과거)"돼야 이행(week_start_date < 이번주 월요일, 문자열 경계).
    //   · 긴급: 선택 주차가 "시작(같음 포함)"되면 즉시 이행 — **실제 타임스탬프 비교**
    //     (hasWeekStartedKst: now ms >= 그 주 월요일 00:01 KST). 미래(다음 주차)=승인.
    //     생성 경로(loadEligibleWeeks.resultingStatus)와 **동일 함수**로 판정 → 생성 응답==목록.
    //     긴급은 항상 status='approved' 로 생성되므로 pending 으로 표기되지 않는다.
    const ended = isUrgent
      ? hasWeekStartedKst(r.week_start_date, nowMs)
      : isWeekEnded(r.week_start_date, currentMonday);
    const displayStatus: RestRequestDisplayStatus = ended
      ? "fulfilled"
      : r.status === "approved"
        ? "approved"
        : "pending";
    const crew = crews.get(r.user_id);
    const requester =
      isUrgent && r.requested_by_user_id
        ? requesters.get(r.requested_by_user_id)
        : undefined;
    return {
      id: r.id,
      displayStatus,
      ended,
      weekLabel: restWeekLabel(r.season_key, r.week_start_date),
      weekStartDate: r.week_start_date,
      requestType: isUrgent ? "urgent" : "normal",
      crewName: crew?.crewName ?? null,
      teamName: crew?.teamName ?? null,
      classLabel: crew?.classLabel ?? "정규",
      reason: r.reason ?? null,
      requestedByName: requester?.name ?? null,
      requestedByRoleLabel: requester?.roleLabel ?? null,
      createdAt: r.created_at,
      createdAtLabel: formatKstDateTime(r.created_at),
    };
  });

  return { rows, total: rows.length };
}

// ── 승인/삭제/전체승인 ────────────────────────────────────────────────────
export class RestActionError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "RestActionError";
    this.status = status;
  }
}

type RequestRow = {
  id: string;
  user_id: string | null;
  status: string | null;
  week_start_date: string | null;
  org: string | null;
  season_key: string | null;
  request_type?: string | null;
  po_c_act_id?: string | null;
};

// 휴식 유효 상태(승인/삭제/일괄승인) 변경 후 해당 크루 cluster4 스냅샷을 타깃 무효화한다.
//   승인된 휴식 주차는 판정에서 personal_rest 로 강제되므로(공통 SoT loader), 캐시된 카드 스냅샷도
//   즉시 수렴해야 실시간 조회(admin crew live)와 스냅샷 조회(front weekly-cards)가 일치한다.
//   best-effort(격리) — 무효화 실패가 승인/삭제 자체를 롤백하지 않는다(daily cron 이 복구).
async function invalidateRestUserSnapshots(userIds: Array<string | null | undefined>): Promise<void> {
  const ids = Array.from(new Set(userIds.filter((u): u is string => Boolean(u))));
  if (ids.length === 0) return;
  try {
    await invalidateWeeklyCardsForUsers(ids);
  } catch (e) {
    console.warn("[rest-management] 스냅샷 무효화 실패(격리)", {
      userIds: ids,
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function fetchRequestById(id: string): Promise<RequestRow | null> {
  // full(긴급 추적 컬럼 포함) → base 폴백(2026-07-12 마이그레이션 미적용 환경 대비).
  const full = await supabaseAdmin
    .from("vacation_requests")
    .select("id,user_id,status,week_start_date,org,season_key,request_type,po_c_act_id")
    .eq("id", id)
    .maybeSingle();
  if (full.error && full.error.code === "42703") {
    const base = await supabaseAdmin
      .from("vacation_requests")
      .select("id,user_id,status,week_start_date,org,season_key")
      .eq("id", id)
      .maybeSingle();
    if (base.error) throw new RestActionError(500, base.error.message);
    return (base.data as RequestRow | null) ?? null;
  }
  if (full.error) throw new RestActionError(500, full.error.message);
  return (full.data as RequestRow | null) ?? null;
}

// 대상 행의 org 가 관리자 허용 조직에 속하는지 검증(허용 목록을 넘긴 경우에만). 403 fail-closed.
function assertRowOrgAllowed(
  rowOrg: string | null,
  allowedOrgs?: readonly OrganizationSlug[],
): void {
  if (!allowedOrgs) return; // 허용 목록 미지정(레거시 호출) = 검사 생략.
  if (!rowOrg || !(allowedOrgs as readonly string[]).includes(rowOrg)) {
    throw new RestActionError(403, "이 클럽의 휴식 신청에 접근할 권한이 없습니다.");
  }
}

// pending → approved. 종료된 주차(이행)/이미 승인은 안내 문구로 차단(서버 최종 방어).
//   allowedOrgs 를 넘기면 대상 행의 org 가 허용 조직인지 먼저 검증한다(403).
export async function approveRestRequest(
  id: string,
  allowedOrgs?: readonly OrganizationSlug[],
): Promise<void> {
  const row = await fetchRequestById(id);
  if (!row) throw new RestActionError(404, "휴식 신청을 찾을 수 없습니다.");
  assertRowOrgAllowed(row.org, allowedOrgs);
  if (isWeekEnded(row.week_start_date, currentWeekMondayIso())) {
    throw new RestActionError(409, "이미 진행된 기간으로서, 처리가 종료되었습니다.");
  }
  if (row.status === "approved") {
    throw new RestActionError(409, "이미 승인된 휴식입니다.");
  }
  const { error } = await supabaseAdmin
    .from("vacation_requests")
    .update({ status: "approved", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "pending");
  if (error) throw new RestActionError(500, error.message);
  // 승인 → 해당 주차가 personal_rest 로 판정되므로 크루 스냅샷을 즉시 무효화(재계산).
  await invalidateRestUserSnapshots([row.user_id]);
}

// pending/approved 삭제 가능. 종료된 주차(이행)는 차단.
//   allowedOrgs 를 넘기면 대상 행의 org 가 허용 조직인지 먼저 검증한다(403).
export async function deleteRestRequest(
  id: string,
  allowedOrgs?: readonly OrganizationSlug[],
): Promise<void> {
  const row = await fetchRequestById(id);
  if (!row) throw new RestActionError(404, "휴식 신청을 찾을 수 없습니다.");
  assertRowOrgAllowed(row.org, allowedOrgs);
  if (isWeekEnded(row.week_start_date, currentWeekMondayIso())) {
    throw new RestActionError(409, "취소할 수 없습니다");
  }
  // 긴급 휴식(urgent)은 생성 시 대상 크루에 Po.C ×2 를 지급했으므로, 삭제 시 그 지급도 회수한다
  //   (부분 상태 방지 — 휴식은 지웠는데 포인트만 남는 것 금지). 일반 휴식은 무영향.
  //   현재/과거 주차 긴급은 위 isWeekEnded(urgent 는 시작=이행) 로 이미 차단되므로, 여기 도달하는
  //   urgent 는 "다음 주차(미시작)" 뿐이다. revoke = 원장 삭제 + 재계산 + snapshot 무효화(best-effort).
  if (row.request_type === "urgent" && row.po_c_act_id) {
    const actId = row.po_c_act_id;
    try {
      await revokeForAct("irregular", actId);
    } catch (e) {
      console.warn("[emergency-rest] 삭제 시 Po.C 회수 실패(격리)", {
        actId,
        message: e instanceof Error ? e.message : String(e),
      });
    }
    // recipients + 변동 액트 행도 정리(보드 잔존/재계산 오염 방지).
    await supabaseAdmin
      .from("process_check_review_recipients")
      .delete()
      .eq("source", "irregular")
      .eq("ref_id", actId);
    await supabaseAdmin.from("process_irregular_acts").delete().eq("id", actId);
  }
  const { error } = await supabaseAdmin
    .from("vacation_requests")
    .delete()
    .eq("id", id);
  if (error) throw new RestActionError(500, error.message);
  // 삭제(승인 취소/반려) → 그 주차의 personal_rest 강제가 사라지므로 크루 스냅샷을 즉시 무효화.
  await invalidateRestUserSnapshots([row.user_id]);
}

// org+season 의 pending 중 종료되지 않은 주차만 일괄 승인(approved/이행은 불변).
export async function bulkApproveRestRequests(
  org: OrganizationSlug,
  seasonKey: string,
): Promise<{ approved: number }> {
  const currentMonday = currentWeekMondayIso();
  const { data, error } = await supabaseAdmin
    .from("vacation_requests")
    .update({ status: "approved", updated_at: new Date().toISOString() })
    .eq("org", org)
    .eq("season_key", seasonKey)
    .eq("status", "pending")
    .gte("week_start_date", currentMonday)
    .select("id,user_id");
  if (error) throw new RestActionError(500, error.message);
  const rows = (data ?? []) as Array<{ id: string; user_id: string | null }>;
  // 일괄 승인된 크루들의 스냅샷을 타깃 무효화(distinct user). 10명 초과면 백그라운드 재계산으로 강등.
  await invalidateRestUserSnapshots(rows.map((r) => r.user_id));
  return { approved: rows.length };
}

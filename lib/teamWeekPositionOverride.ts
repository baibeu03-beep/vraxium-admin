import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { PositionCode } from "@/lib/positionHistory";

// ── 주차별 (user × week × org × team) 파트/클래스 관리자 오버라이드 — effective coalesce SoT ──
//   원본 = user_position_histories(UPH, 이관·read 전용). 관리자 편집값 = cluster4_team_week_position_overrides.
//   effective = override ?? UPH. 한 유저가 같은 주차에 복수 팀 이력 가능 → key = userId::org::rawTeam.
//   ⚠ [A] 요약 · [B] 편집표 · 주차별 파트 운용 상태표 · **크루 카드(snapshot)** · **이력서 시즌 직책** ·
//     **area-8 시즌 활동 상태**가 모두 이 모듈의 loader 를 공유해야 시스템 진실이 하나다(2단계, 2026-07-22).
//     읽기 경로별 필요 shape 이 달라 3종 loader 를 둔다:
//       · loadWeekPositionOverrides(org, weekStart)     — 관리자 팀 상세 [A]/[B] (org×주차 1건)
//       · loadOrgWeekPositionOverrideRows(org, weeks[]) — 파트×주차 존재표 (org×반기 26주)
//       · loadUserPositionOverrideRows(userId)          — 카드/이력서/area-8 (유저 전 주차)
//   ⚠ 마이그레이션(cluster4_team_week_position_overrides) 미적용 환경에서는 테이블 부재(42P01)를 흡수해
//     **UPH-only 로 graceful degrade**(현재 동작 무회귀). 적용 즉시 override 가 자동 반영된다.

export type OverridePosition = {
  rawTeam: string;
  rawPart: string | null;
  positionCode: PositionCode;
};

// UPH 의 raw_team 은 "A팀(하계)" 같은 괄호 수식이 섞인 비정규화 문자열인 반면, override 의 raw_team 은
//   관리자 화면이 해소한 정규 team_name("A팀")이다. 두 원천을 join 하려면 양쪽 모두 괄호를 제거해야 한다
//   (adminTeamHalvesData.stripParen · adminTeamSelectedWeekSummary 의 매칭 규칙과 동일).
export function stripTeamParen(value: string | null | undefined): string {
  return (value ?? "").replace(/\(.*?\)/g, "").trim();
}

// UPH 행 ↔ override 행 조인 키. 한 유저가 같은 주차에 복수 팀 이력을 가질 수 있으므로 팀까지 포함한다.
export function weekTeamKey(weekStartDate: string, rawTeam: string | null): string {
  return `${weekStartDate.slice(0, 10)}::${stripTeamParen(rawTeam)}`;
}

// 마이그레이션 미적용 = 테이블 부재 신호. Postgres(42P01)·PostgREST(PGRST205/schema cache) 양쪽 흡수.
function isMissingTableError(error: unknown): boolean {
  const e = (error ?? {}) as { code?: string; message?: string };
  return (
    e.code === "42P01" ||
    e.code === "PGRST205" ||
    /schema cache|could not find the table|does not exist/i.test(e.message ?? "")
  );
}

// ── carry-forward(이월) 규칙 — 이 모듈의 핵심 semantics ─────────────────────────
//   관리자가 4주차에 "정규/보컬" 로 저장하면 **4주차부터 이후 주차 전부**가 그 값을 쓴다.
//   3주차 이전은 절대 바뀌지 않는다. 이후 주차에 또 다른 override 를 저장하면 그 주차부터 새 값.
//     effective(W) = week_start_date ≤ W 인 override 중 가장 최근 것 ?? UPH(W) ?? 현재 멤버십
//   ⚠ 저장 시 미래 주차 행을 복제 생성하지 않는다(행 1개 = 그 시점 이후 전부). 나중에 주차가
//     추가돼도 자동으로 이월되고, 되돌리려면 그 주차에 새 override 를 저장하면 된다.
export function resolveOverrideAt<T extends { weekStartDate: string }>(
  rowsAsc: T[] | undefined,
  weekStartDate: string,
): T | null {
  if (!rowsAsc || rowsAsc.length === 0) return null;
  let found: T | null = null;
  for (const r of rowsAsc) {
    if (r.weekStartDate <= weekStartDate) found = r;
    else break; // asc 정렬 — 이후는 전부 미래.
  }
  return found;
}

// key → 그 key 의 override 행(week_start_date 오름차순). resolveOverrideAt 와 짝.
export function buildOverrideIndex<T extends { weekStartDate: string }>(
  rows: T[],
  keyOf: (row: T) => string,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = keyOf(r);
    const arr = out.get(k) ?? [];
    arr.push(r);
    out.set(k, arr);
  }
  for (const arr of out.values()) arr.sort((a, b) => a.weekStartDate.localeCompare(b.weekStartDate));
  return out;
}

// 조인용 flat 행(주차·팀 키 포함). effective 계산은 호출부가 자기 shape 에 맞게 수행한다.
export type WeekPositionOverrideRow = {
  userId: string;
  organization: string;
  weekStartDate: string;
  rawTeam: string;
  rawPart: string | null;
  positionCode: PositionCode;
};

type RawRow = {
  user_id: string;
  organization: string;
  week_start_date: string;
  raw_team: string;
  raw_part: string | null;
  position_code: string;
};

const SELECT_COLS = "user_id,organization,week_start_date,raw_team,raw_part,position_code";

function toRows(data: unknown): WeekPositionOverrideRow[] {
  return ((data ?? []) as RawRow[]).map((r) => ({
    userId: r.user_id,
    organization: r.organization,
    weekStartDate: String(r.week_start_date).slice(0, 10),
    rawTeam: r.raw_team,
    rawPart: r.raw_part,
    positionCode: r.position_code as PositionCode,
  }));
}

// 한 유저의 전 주차 override — 크루 카드(snapshot) · 이력서 시즌 직책 · area-8 이 공유.
//   유저당 행 수는 활동 주차 수(≲200) 라 페이지네이션 불필요. 테이블 부재 시 [](= UPH-only).
export async function loadUserPositionOverrideRows(
  userId: string,
): Promise<WeekPositionOverrideRow[]> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_team_week_position_overrides")
    .select(SELECT_COLS)
    .eq("user_id", userId);
  if (error) {
    if (isMissingTableError(error)) return [];
    // 카드/이력서는 override 조회 실패로 깨지면 안 된다 — UPH-only 로 degrade(무회귀) 후 경고만 남긴다.
    console.warn("[team-week-position-override] user rows 조회 실패 → UPH-only", {
      userId,
      message: (error as { message?: string }).message,
    });
    return [];
  }
  return toRows(data);
}

// ── "현재 시점" 화면용 — 오늘이 속한 주차의 override ──────────────────────────
//   회원 목록/상세의 상태 칩·소속, 팀 상세 [A] 현재 크루 수는 원래 user_memberships(현재) SoT 였다.
//   그런데 관리자가 **현재 주차**의 파트/클래스를 바꾸면 두 값이 같은 사람을 서로 다르게 표시한다
//   (실측 2026-07-22: 회원목록 "일반" vs 주차 override "심화(파트장)"). 사용자 결정에 따라
//   현재 주차에 override 가 있으면 현재-시점 화면도 그 값을 따른다. 과거 주차 override 는 영향 없음.
//   ⚠ 경계는 start_date ≤ today ≤ end_date **양쪽** 으로 판정한다(adminSeasonWeeksData.isCurrentWeek 와
//     동일 규칙). start_date 만 보고 최신 1행을 집으면 달력 갭(마지막 주차 종료 후)에서 지나간 주차를
//     "현재 주차"로 오인해, override 가 없어야 할 시점에 과거 값을 현재-시점 화면에 노출한다.
export async function resolveCurrentWeekStartDate(todayIso: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("weeks")
    .select("start_date")
    .lte("start_date", todayIso)
    .gte("end_date", todayIso)
    .order("start_date", { ascending: false })
    .limit(1);
  if (error) return null;
  const row = (data ?? [])[0] as { start_date?: string } | undefined;
  return row?.start_date ? String(row.start_date).slice(0, 10) : null;
}

// (weekStartDate, userIds) → userId → override. 한 유저가 그 주차에 복수 팀 override 를 가지면
//   마지막 행이 이긴다(현재-시점 칩은 값 1개만 표시 가능 — 실무상 예외 케이스).
// 유저 목록 × (week_start_date ≤ maxWeekStartDate) override 행 전부. carry-forward 계산 원천.
//   organization 을 주면 그 조직으로 한정한다(안 주면 유저의 전 조직 — 실무상 1조직).
export async function loadUserOverrideRowsUpTo(
  userIds: string[],
  maxWeekStartDate: string,
  organization?: string | null,
): Promise<WeekPositionOverrideRow[]> {
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  if (ids.length === 0 || !maxWeekStartDate) return [];
  const all: WeekPositionOverrideRow[] = [];
  const CHUNK = 100; // UUID 100개 ≈ 3.7KB — PostgREST URL 한도 안전 구간.
  for (let i = 0; i < ids.length; i += CHUNK) {
    let q = supabaseAdmin
      .from("cluster4_team_week_position_overrides")
      .select(SELECT_COLS)
      .lte("week_start_date", maxWeekStartDate)
      .in("user_id", ids.slice(i, i + CHUNK));
    if (organization) q = q.eq("organization", organization);
    const { data, error } = await q;
    if (error) {
      if (isMissingTableError(error)) return [];
      console.warn("[team-week-position-override] 유저 override 조회 실패 → UPH/멤버십 SoT 유지", {
        message: (error as { message?: string }).message,
      });
      return [];
    }
    all.push(...toRows(data));
  }
  return all;
}

//   carry-forward — 그 주차 이하 최근 행(유저별). 한 유저가 복수 팀 override 를 가지면 마지막 팀이 이긴다.
export async function loadWeekPositionOverridesByUser(
  weekStartDate: string,
  userIds: string[],
): Promise<Map<string, OverridePosition>> {
  const out = new Map<string, OverridePosition>();
  const all = await loadUserOverrideRowsUpTo(userIds, weekStartDate);
  const index = buildOverrideIndex(all, (r) => r.userId);
  for (const [uid, arr] of index) {
    const hit = resolveOverrideAt(arr, weekStartDate);
    if (hit) out.set(uid, { rawTeam: hit.rawTeam, rawPart: hit.rawPart, positionCode: hit.positionCode });
  }
  return out;
}

// org 의 override 행 중 week_start_date ≤ maxWeekStartDate 전부(오름차순 정렬은 index 빌더가 담당).
//   carry-forward 계산의 원천 — 파트×주차 존재표는 주차별로 resolveOverrideAt 을 돌린다.
export async function loadOrgOverrideRowsUpTo(
  organization: string,
  maxWeekStartDate: string,
): Promise<WeekPositionOverrideRow[]> {
  if (!maxWeekStartDate) return [];
  const out: WeekPositionOverrideRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from("cluster4_team_week_position_overrides")
      .select(SELECT_COLS)
      .eq("organization", organization)
      .lte("week_start_date", maxWeekStartDate)
      .order("week_start_date", { ascending: true })
      .range(from, from + 999);
    if (error) {
      if (isMissingTableError(error)) return [];
      throw new Error((error as { message?: string }).message ?? "override 조회 실패");
    }
    const batch = toRows(data);
    out.push(...batch);
    if (batch.length < 1000) break;
  }
  return out;
}

export function makeAssignmentKey(input: {
  userId: string;
  organization: string;
  rawTeam: string;
}): string {
  return `${input.userId}::${input.organization}::${input.rawTeam}`;
}

// 특정 (organization, weekStartDate) 의 override 를 key(userId::org::rawTeam) → 값 Map 으로.
//   테이블 부재 시 빈 Map(=override 없음).
//   ⚠ carry-forward: `week_start_date = weekStartDate` 가 아니라 `≤ weekStartDate` 중 **가장 최근** 행을
//     (user, org, team) 별로 고른다. 4주차 저장이 5·6주차에도 이어지는 것이 요구사항이다.
export async function loadWeekPositionOverrides(
  organization: string,
  weekStartDate: string,
): Promise<Map<string, OverridePosition>> {
  const out = new Map<string, OverridePosition>();
  const rows = await loadOrgOverrideRowsUpTo(organization, weekStartDate);
  const index = buildOverrideIndex(rows, (r) =>
    makeAssignmentKey({ userId: r.userId, organization, rawTeam: r.rawTeam }),
  );
  for (const [key, arr] of index) {
    const hit = resolveOverrideAt(arr, weekStartDate);
    if (hit) out.set(key, { rawTeam: hit.rawTeam, rawPart: hit.rawPart, positionCode: hit.positionCode });
  }
  return out;
}

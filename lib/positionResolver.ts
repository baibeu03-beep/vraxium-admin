import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveSeasonPosition, type PositionCode } from "@/lib/positionHistory";
import {
  buildOverrideIndex,
  buildSeasonKeyResolver,
  loadEarliestOverrideWeekByUser,
  loadUserOverrideRowsUpTo,
  loadUserPositionOverrideRows,
  resolveCurrentWeekStartDate,
  resolveOverrideAt,
  stripTeamParen,
  type WeekPositionOverrideRow,
} from "@/lib/teamWeekPositionOverride";
import { roleLevelToPositionCode } from "@/shared/crewClassPosition";
import { resolvePositionLabels } from "@/lib/adminMembersTypes";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import { nonEmptyText, selectMembershipRow } from "@/lib/membershipResolver";

// ═══════════════════════════════════════════════════════════════════════════
// 팀·파트·클래스 **단일 resolver** — 화면마다 override+UPH+membership 조립을 복붙하지 않는다.
//
// 두 가지 기준 시점만 존재한다:
//   · resolvePositionAt(targetWeek)  — 특정 주차 이력 화면(주차 상세/주차 결과/시즌 집계 재료)
//   · resolveCurrentPosition(today)  — 현재 상태 화면(회원 목록/상세/대상자 판정/집계)
//
// 결정 규칙(양쪽 동일, 기준 주차만 다름):
//     effective(W) = (week_start_date ≤ W 인 override 중 최신)
//                 ?? UPH(W)                       (그 주차 행)
//                 ?? 현재 membership/profile      (그 주차 행이 없는 native 주차)
//
// ⚠ **현재 role/membership 이 주차값을 덮지 않는다.** 과거 주차 화면에서 현재 직책을 우선하면
//   이력이 훼손된다(2026-07-22 정책 확정). membership 은 최후 fallback 으로만 쓴다.
// ⚠ **시즌 대표값은 여기서 만들지 않는다.** 시즌 대표는 각 주차 effective 이력을 모아
//   resolveSeasonPosition(3주룰)로 별도 산출한다. 시즌 대표를 주차 카드 fallback 으로 쓰면
//   과거 주차가 덮인다 — 금지.
// ⚠ 라벨 변환은 resolver 밖에서 한다: positionCodeToClassLabel(정규/심화(파트장)/…)
//   또는 positionCodeToStatusLabel(일반/심화(파트장)/…). 어휘 2종이 다르니 소비처 컬럼에 맞춰 고른다.
// ═══════════════════════════════════════════════════════════════════════════

export type PositionSource = "override" | "uph" | "membership" | "none";

export type ResolvedPosition = {
  userId: string;
  teamName: string | null;
  partName: string | null;
  rawTeam: string | null;
  rawPart: string | null;
  positionCode: PositionCode | null;
  /** 상태 칩·버킷 분기 어휘(일반/심화(파트장)/팀장/…). resolvePositionLabels 단일 변환기 산출. */
  statusLabel: string;
  /** 클래스 컬럼 어휘(정규/심화(파트장)/운영진(팀장)/…). 값이 없으면 "-". */
  classLabel: string;
  source: PositionSource;
  /** override 로 결정된 경우, 그 override 가 저장된 주차(=이 값이 적용되기 시작한 주차). */
  effectiveFromWeek: string | null;
};

// 라벨은 resolver 밖에서 다시 만들지 않는다 — 소비처는 자기 컬럼 어휘에 맞는 필드를 고르기만 한다.
function withLabels(input: {
  userId: string;
  rawTeam: string | null;
  rawPart: string | null;
  positionCode: PositionCode | null;
  role?: string | null;
  membershipLevel?: string | null;
  source: PositionSource;
  effectiveFromWeek: string | null;
}): ResolvedPosition {
  const labels = resolvePositionLabels({
    positionCode: input.positionCode,
    role: input.role ?? null,
    membershipLevel: input.membershipLevel ?? null,
  });
  return {
    userId: input.userId,
    teamName: input.rawTeam,
    partName: input.rawPart,
    rawTeam: input.rawTeam,
    rawPart: input.rawPart,
    positionCode: labels.positionCode ?? input.positionCode,
    statusLabel: labels.statusLabel,
    classLabel: labels.positionCode || input.membershipLevel || input.role ? labels.classLabel : "-",
    source: input.source,
    effectiveFromWeek: input.effectiveFromWeek,
  };
}

const EMPTY = (userId: string): ResolvedPosition => ({
  userId,
  teamName: null,
  partName: null,
  rawTeam: null,
  rawPart: null,
  positionCode: null,
  statusLabel: "크루",
  classLabel: "-",
  source: "none",
  effectiveFromWeek: null,
});

type MembershipRow = {
  user_id: string;
  team_name: string | null;
  part_name: string | null;
  membership_level: string | null;
  is_current: boolean | null;
  updated_at: string | null;
};

type MembershipFallback = {
  team: string | null;
  part: string | null;
  code: PositionCode | null;
  role: string | null;
  level: string | null;
  /** user_profiles.activity_started_at(date-only, 항상 월요일). 없으면 활동 시작 게이트 미적용. */
  activityStartDate: string | null;
};

function firstNonEmpty(...vals: Array<string | null | undefined>): string | null {
  return vals.map(nonEmptyText).find((v): v is string => v !== null) ?? null;
}

export function resolvePositionValues(input: {
  override: { rawTeam?: string | null; rawPart?: string | null; positionCode?: PositionCode | null } | null;
  history: { team?: string | null; part?: string | null; code?: PositionCode | null } | null;
  membership: MembershipFallback | null;
}) {
  return {
    teamName: firstNonEmpty(input.override?.rawTeam, input.history?.team, input.membership?.team),
    partName: firstNonEmpty(input.override?.rawPart, input.history?.part, input.membership?.part),
    positionCode:
      input.override?.positionCode
      ?? input.history?.code
      ?? input.membership?.code
      ?? null,
  };
}

// 현재 멤버십(is_current) + profile.role — 최후 fallback 원천. 청크 조회.
//   ⚠ team/part 는 membership → **user_profiles.current_\*** 순으로 폴백한다. 팀장 등 운영진은
//     user_memberships 행이 아예 없는 경우가 있어, 멤버십만 보면 소속이 "-" 로 사라진다
//     (adminCrewData·adminProcessCheckData 가 각자 갖고 있던 폴백 규칙 5 를 여기로 흡수).
async function loadMembershipFallback(
  userIds: string[],
): Promise<Map<string, MembershipFallback>> {
  const out = new Map<string, MembershipFallback>();
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  if (ids.length === 0) return out;
  const CHUNK = 100;
  type ProfileRow = {
    user_id: string;
    role: string | null;
    current_team_name: string | null;
    current_part_name: string | null;
    activity_started_at: string | null;
  };
  const profByUser = new Map<string, ProfileRow>();
  const memByUser = new Map<string, MembershipRow[]>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const [profRes, memRes] = await Promise.all([
      supabaseAdmin
        .from("user_profiles")
        .select("user_id,role,current_team_name,current_part_name,activity_started_at")
        .in("user_id", chunk),
      supabaseAdmin
        .from("user_memberships")
        .select("user_id,team_name,part_name,membership_level,is_current,updated_at")
        .in("user_id", chunk),
    ]);
    for (const p of (profRes.data ?? []) as ProfileRow[]) profByUser.set(p.user_id, p);
    for (const m of (memRes.data ?? []) as MembershipRow[]) {
      const rows = memByUser.get(m.user_id) ?? [];
      rows.push(m);
      memByUser.set(m.user_id, rows);
    }
  }
  for (const id of ids) {
    const m = selectMembershipRow(memByUser.get(id) ?? []);
    const p = profByUser.get(id);
    out.set(id, {
      team: firstNonEmpty(m?.team_name, p?.current_team_name),
      part: firstNonEmpty(m?.part_name, p?.current_part_name),
      code: roleLevelToPositionCode(p?.role ?? null, m?.membership_level ?? null),
      role: p?.role ?? null,
      level: m?.membership_level ?? null,
      activityStartDate: p?.activity_started_at ? String(p.activity_started_at).slice(0, 10) : null,
    });
  }
  return out;
}

type UphEntry = { team: string | null; part: string | null; code: PositionCode };

// 여러 주차의 UPH 행을 한 번에(정확히 그 주차들). 반환 = weekStart → (userId → 행).
//   한 주차에 복수 팀 행이면 마지막 행이 이긴다(단일 주차 loadUphAt 과 동일 규칙).
//   ⚠ PostgREST 1000행 cap — 유저 청크 안에서 range 페이지네이션한다(주차 26개 × 유저 100명이면
//     쉽게 1000행을 넘는다). 청크 크기는 .in() URL 길이 절벽을 피하려 100 고정.
async function loadUphAtWeeks(
  userIds: string[],
  weekStarts: string[],
  organization?: string | null,
): Promise<Map<string, Map<string, UphEntry>>> {
  const out = new Map<string, Map<string, UphEntry>>();
  const weeks = Array.from(new Set(weekStarts.map((w) => String(w).slice(0, 10)).filter(Boolean)));
  for (const w of weeks) out.set(w, new Map());
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  if (ids.length === 0 || weeks.length === 0) return out;
  const CHUNK = 100;
  const PAGE = 1000;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    for (let from = 0; ; from += PAGE) {
      let q = supabaseAdmin
        .from("user_position_histories")
        .select("user_id,raw_team,raw_part,position_code,week_start_date")
        .in("week_start_date", weeks)
        .in("user_id", chunk)
        // range 페이지네이션은 결정적 정렬이 전제 — (주차, 유저) 복합키로 고정한다.
        .order("week_start_date", { ascending: true })
        .order("user_id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (organization) q = q.eq("organization", organization);
      const { data, error } = await q;
      if (error) {
        console.warn("[positionResolver] UPH 조회 실패 → 멤버십 fallback", { message: error.message });
        return out;
      }
      const batch = (data ?? []) as Array<{
        user_id: string;
        raw_team: string | null;
        raw_part: string | null;
        position_code: PositionCode;
        week_start_date: string;
      }>;
      for (const r of batch) {
        const wk = String(r.week_start_date).slice(0, 10);
        const byUser = out.get(wk);
        if (!byUser) continue;
        byUser.set(r.user_id, { team: r.raw_team, part: r.raw_part, code: r.position_code });
      }
      if (batch.length < PAGE) break;
    }
  }
  return out;
}

// 한 유저 × 한 주차의 결정 — override(≤W 최신) → UPH(W) → 현재 멤버십. 단일/벌크 공용 순수 로직.
//   rawPriorOverride = 시즌 경계를 **무시하고** 찾은 "≤W 최신 override"(있으면). ovr(시즌 경계 적용)가
//   null 인데 이게 있다는 건 "예전에 override 로 다른 데로 옮겨졌는데, 그 시즌이 끝나 carry-forward 가
//   끊겼다"는 뜻이다 — 아래 멤버십 폴백 가드에서만 쓴다(그 외 분기는 기존과 동일).
// export = 순수 단위 검증용(DB 없이 decidePositionAt 자체를 직접 두드린다). 동작 변경 아님.
export function decidePositionAt(
  userId: string,
  week: string,
  ovr: { weekStartDate: string; rawTeam: string | null; rawPart: string | null; positionCode: PositionCode | null } | null,
  uphEntry: UphEntry | null,
  membershipFallback: MembershipFallback | null,
  rawPriorOverride: { weekStartDate: string; rawTeam: string | null; rawPart: string | null; positionCode: PositionCode | null } | null = null,
  /** 이 유저의 **가장 이른** override 주차(전체 이력, 상한 없음). 미래 override 드리프트 가드 전용. */
  earliestOverrideWeek: string | null = null,
): ResolvedPosition {
  if (ovr) {
    const values = resolvePositionValues({
      override: ovr,
      history: uphEntry,
      membership: membershipFallback,
    });
    return withLabels({
      userId,
      rawTeam: values.teamName,
      rawPart: values.partName,
      positionCode: values.positionCode,
      source: "override",
      effectiveFromWeek: ovr.weekStartDate,
      role: membershipFallback?.role ?? null,
      membershipLevel: membershipFallback?.level ?? null,
    });
  }
  if (uphEntry) {
    const values = resolvePositionValues({
      override: null,
      history: uphEntry,
      membership: membershipFallback,
    });
    return withLabels({
      userId,
      rawTeam: values.teamName,
      rawPart: values.partName,
      positionCode: values.positionCode,
      source: "uph",
      effectiveFromWeek: null,
      role: membershipFallback?.role ?? null,
      membershipLevel: membershipFallback?.level ?? null,
    });
  }
  // ── 시즌 경계 너머 멤버십 폴백 가드(2026-08 정책) ──────────────────────────────
  //   override(같은 시즌)도 UPH(그 주차)도 없어 "현재 멤버십"으로 최후 폴백하려는 시점이다. 그런데
  //   이 유저가 **과거 다른 시즌에 override 를 받은 적**이 있고, 그 override 값이 지금 라이브 멤버십과
  //   다르면 — 그 override 저장(PATCH week-position)은 UPH/멤버십을 갱신하지 않으므로 멤버십은
  //   "그 override 이후로 한 번도 안 바뀐 낡은 값"일 뿐, "이 유저가 실제로 복귀했다"는 근거가 아니다.
  //   이 상태로 멤버십을 그대로 쓰면, 관리자가 시즌 A 에 어떤 파트에서 뺀 크루가 시즌 B 미래 주차에
  //   "현재 소속" 이란 이름으로 자동 부활한다(운용 파트 carry-forward 요구사항 위반). 값이 멤버십과
  //   **똑같으면**(=드리프트 없음) 되살릴 것도 없으므로 평소대로 폴백한다.
  const m = membershipFallback;
  if (rawPriorOverride) {
    const driftedTeam =
      stripTeamParen(rawPriorOverride.rawTeam) !== stripTeamParen(m?.team ?? null);
    const driftedPart = (rawPriorOverride.rawPart ?? null) !== (m?.part ?? null);
    if (driftedTeam || driftedPart) {
      void week;
      return EMPTY(userId); // 시즌 경계 너머 미배정 — "현재 소속" 자동 부활 차단.
    }
  }
  // ── 활동 시작 이전 주차 가드(2026-08 정책 확정) ──────────────────────────────
  //   override 도 UPH 도 없어 현재 멤버십으로 최후 폴백하려는 시점인데, 그 주차가 이 유저의
  //   활동 시작 주차(user_profiles.activity_started_at)보다 이르면 애초에 그 시점엔 이 유저가
  //   활동을 시작하지 않았다 — "현재 소속"을 그 이전 과거로 투영하지 않는다(scenario A).
  //   activity_started_at 이 없는(레거시/미상) 유저는 게이트 미적용 — 기존 동작 무회귀.
  if (m?.activityStartDate && week < m.activityStartDate) {
    void week;
    return EMPTY(userId);
  }
  // ── 미래 override 드리프트 가드(2026-08 정책, scenario C) ──────────────────────
  //   이 주차엔 override/UPH 가 없어 현재 멤버십으로 폴백하려는데, 이 유저에게 **이후** 주차에라도
  //   override 이력이 있다면(=관리자가 그 시점부터 뭔가를 명시적으로 바꿨다는 뜻 — 팀장 승격 등)
  //   지금의 "현재값"은 그 변경 **이후** 상태다. 승격 이전 주차를 지금 조회/공표하면 "팀장"이
  //   소급되던 문제(예: 오늘 팀장 승격 → 승격 이전 주차에 이미 팀장으로 표시)를 막는다.
  if (earliestOverrideWeek && week < earliestOverrideWeek) {
    void week;
    return EMPTY(userId);
  }
  if (m && (m.code !== null || m.team !== null || m.part !== null)) {
    return withLabels({
      userId,
      rawTeam: m.team,
      rawPart: m.part,
      positionCode: m.code,
      // 코드로 정규화 안 되는 role(관리자/최고 관리자)도 라벨을 잃지 않도록 원본을 넘긴다.
      role: m.role,
      membershipLevel: m.level,
      source: "membership",
      effectiveFromWeek: null,
    });
  }
  void week;
  return EMPTY(userId);
}

/**
 * 여러 주차 기준 effective 팀/파트/클래스(배치의 배치).
 *   반환 = weekStart → (userId → ResolvedPosition). 규칙은 resolvePositionAtBatch 와 **완전히 동일**
 *   (decidePositionAt 단일 함수 — 단일 주차 경로가 이 함수의 weekStarts.length===1 형태다).
 *
 * ⚠ 주차별로 따로 호출하지 말 것. override(≤max) · UPH(전 주차) · 멤버십을 각 1패스로 읽고
 *   주차 루프는 메모리에서 돈다. 26주 × 팀 매트릭스가 이 함수 하나로 끝나야 N+1 이 안 생긴다.
 */
export async function resolvePositionAtWeeksBulk(input: {
  userIds: string[];
  weekStarts: string[];
  organization?: string | null;
}): Promise<Map<string, Map<string, ResolvedPosition>>> {
  const ids = Array.from(new Set(input.userIds.filter(Boolean)));
  const weeks = Array.from(
    new Set(input.weekStarts.map((w) => String(w ?? "").slice(0, 10)).filter(Boolean)),
  ).sort();
  const out = new Map<string, Map<string, ResolvedPosition>>();
  for (const w of weeks) out.set(w, new Map());
  if (ids.length === 0 || weeks.length === 0) return out;

  const maxWeek = weeks[weeks.length - 1];
  const [overrideRows, uphByWeek, membership, earliestOverrideByUser] = await Promise.all([
    loadUserOverrideRowsUpTo(ids, maxWeek, input.organization ?? null),
    loadUphAtWeeks(ids, weeks, input.organization ?? null),
    loadMembershipFallback(ids),
    // maxWeek 상한 없이 유저별 전체 이력 중 가장 이른 override 주차만 — 미래 드리프트 가드 전용.
    loadEarliestOverrideWeekByUser(ids, input.organization ?? null),
  ]);
  const ovrIndex = buildOverrideIndex(overrideRows, (r) => r.userId);
  // 시즌 경계 — override 는 **같은 시즌 안에서만** 이월한다([[teamWeekPositionOverride]] SEASON BOUNDARY).
  //   대상 주차 + override 행 주차를 모두 넘겨야 양쪽 시즌을 비교할 수 있다.
  const seasonKeyOf = await buildSeasonKeyResolver([
    ...weeks,
    ...overrideRows.map((r) => r.weekStartDate),
  ]);

  for (const week of weeks) {
    const byUser = out.get(week) as Map<string, ResolvedPosition>;
    const uph = uphByWeek.get(week) ?? new Map<string, UphEntry>();
    for (const id of ids) {
      byUser.set(
        id,
        decidePositionAt(
          id,
          week,
          resolveOverrideAt(ovrIndex.get(id), week, seasonKeyOf),
          uph.get(id) ?? null,
          membership.get(id) ?? null,
          // 시즌 경계 미적용(3번째 인자 생략) — "예전에 override 가 있었는지"만 본다. 드리프트 가드 전용.
          resolveOverrideAt(ovrIndex.get(id), week),
          earliestOverrideByUser.get(id) ?? null,
        ),
      );
    }
  }
  return out;
}

/**
 * 특정 주차 기준 effective 팀/파트/클래스(배치).
 *   override(≤W 최신) → UPH(W) → 현재 멤버십 순.
 *   ⚠ 구현은 resolvePositionAtWeeksBulk(주차 1개) 위임 — 규칙을 두 벌 두지 않는다.
 */
export async function resolvePositionAtBatch(input: {
  userIds: string[];
  targetWeekStart: string;
  organization?: string | null;
}): Promise<Map<string, ResolvedPosition>> {
  const ids = Array.from(new Set(input.userIds.filter(Boolean)));
  if (ids.length === 0) return new Map();
  const week = String(input.targetWeekStart ?? "").slice(0, 10);
  if (!week) {
    const out = new Map<string, ResolvedPosition>();
    for (const id of ids) out.set(id, EMPTY(id));
    return out;
  }
  const byWeek = await resolvePositionAtWeeksBulk({
    userIds: ids,
    weekStarts: [week],
    organization: input.organization ?? null,
  });
  return byWeek.get(week) ?? new Map();
}

/**
 * 현재 시점(오늘이 속한 주차) 기준 effective 팀/파트/클래스(배치).
 *   달력 갭 등으로 현재 주차를 못 찾으면 멤버십 fallback 만 반환한다(종전 동작 유지).
 */
export async function resolveCurrentPositionBatch(input: {
  userIds: string[];
  organization?: string | null;
  todayIso?: string;
}): Promise<Map<string, ResolvedPosition>> {
  const ids = Array.from(new Set(input.userIds.filter(Boolean)));
  if (ids.length === 0) return new Map();
  const today = input.todayIso ?? getCurrentActivityDateIso();
  const weekStart = await resolveCurrentWeekStartDate(today);
  if (!weekStart) {
    const membership = await loadMembershipFallback(ids);
    const out = new Map<string, ResolvedPosition>();
    for (const id of ids) {
      const m = membership.get(id);
      if (!m || !(m.code || m.team || m.part || m.role || m.level)) {
        out.set(id, EMPTY(id));
        continue;
      }
      out.set(
        id,
        withLabels({
          userId: id,
          rawTeam: m.team,
          rawPart: m.part,
          positionCode: m.code,
          role: m.role,
          membershipLevel: m.level,
          source: "membership",
          effectiveFromWeek: null,
        }),
      );
    }
    return out;
  }
  return resolvePositionAtBatch({
    userIds: ids,
    targetWeekStart: weekStart,
    organization: input.organization ?? null,
  });
}

// ── 현재 주차 override "덧씌우기" 전용 배치 ─────────────────────────────────
//   이미 membership/role 을 읽고 있는 기존 목록 로더들이, 그 조회를 그대로 두고 override 만 얹을 때 쓴다.
//   (resolveCurrentPositionBatch 는 membership 을 다시 읽으므로 그런 화면에선 중복 쿼리가 된다.)
//   반환에 없는 유저 = override 없음 → 호출부는 종전 로직을 그대로 쓴다(무회귀).
//   라벨 2종을 함께 담아 소비처가 자기 컬럼 어휘를 고르게 한다:
//     · statusLabel : memberStatusLabel 어휘(일반/심화(파트장)/팀장/…)  — 상태 칩·버킷 분기
//     · classLabel  : classLabel 어휘(정규/심화(파트장)/운영진(팀장)/…) — 클래스 컬럼
export type CurrentWeekOverrideEntry = {
  positionCode: PositionCode;
  statusLabel: string;
  classLabel: string;
  rawTeam: string | null;
  rawPart: string | null;
  effectiveFromWeek: string | null;
};

export async function loadCurrentWeekOverrideLabels(
  userIds: string[],
  organization?: string | null,
  todayIso?: string,
): Promise<Map<string, CurrentWeekOverrideEntry>> {
  const out = new Map<string, CurrentWeekOverrideEntry>();
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  if (ids.length === 0) return out;
  try {
    const resolved = await resolveCurrentPositionBatch({
      userIds: ids,
      organization: organization ?? null,
      todayIso,
    });
    for (const [uid, hit] of resolved) {
      if (!hit.positionCode && !hit.rawTeam && !hit.rawPart) continue;
      out.set(uid, {
        positionCode: hit.positionCode ?? "regular",
        statusLabel: hit.statusLabel,
        classLabel: hit.classLabel,
        rawTeam: hit.rawTeam,
        rawPart: hit.rawPart,
        effectiveFromWeek: hit.effectiveFromWeek,
      });
    }
  } catch (e) {
    // 실패는 조용히 무시 — 호출부가 종전 멤버십 로직으로 동작한다(무회귀).
    console.warn("[positionResolver] 현재 주차 override 조회 실패 → 멤버십 SoT 유지", {
      message: e instanceof Error ? e.message : String(e),
    });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 유저 1명의 **주차별 effective 시리즈** — 카드 빌더 · area-8 · 이력서 시즌 직책 공용
// ═══════════════════════════════════════════════════════════════════════════
// 종전에는 아래 3곳이 같은 조립(UPH 전 주차 로드 → override carry-forward → UPH 없는 주차 보강 →
//   시즌별 집계)을 **각자 복붙**하고 있었다:
//     · cluster4WeeklyGrowthData  카드 빌더(주차 배지/소속)
//     · cluster4WeeklyGrowthData  area-8 시즌 활동 상태 구간
//     · cluster1ResumeData        이력서 시즌 대표 직책
//   한 곳만 고치면 나머지가 갈라지므로 여기로 접었다. 새 화면은 이 함수만 호출한다.
//
// ⚠ **effective 와 uph 를 둘 다 돌려주는 이유** — 용도가 갈린다:
//     · effectiveCode : 그 주차에 실제로 표시/집계할 값(override carry-forward 포함).
//     · uphCode       : override 를 섞지 않은 원본. **"데이터 없는 주차를 메우는 시즌 대표값"**
//       계산에는 반드시 이쪽만 쓴다. effective 로 시즌 대표를 만들면 4주차 override 가 시즌
//       대표로 승격돼 UPH 행이 없는 0~3주차까지 소급으로 덮인다(2026-07-22 실측 회귀).
//       override 의 유효 범위는 carry-forward(그 주차 이후)뿐이다.
export type EffectiveWeekPosition = {
  seasonKey: string | null;
  weekStart: string | null;
  /** 표시/집계용 effective 코드 = override(≤W 최신) ?? UPH(W). */
  effectiveCode: PositionCode;
  /** override 미적용 원본. override 로만 존재하는 주차는 null. */
  uphCode: PositionCode | null;
  rawTeam: string | null;
  rawPart: string | null;
  /** override 로 값이 바뀐 주차인지 — 소속(team/part) 주차핀 판정에 쓴다. */
  overridden: boolean;
};

export type UserWeekPositionSeries = {
  rows: EffectiveWeekPosition[];
  /** week_start_date → override 로 지정된 소속. 카드 header teamName/partName 주차핀 SoT. */
  overriddenTeamPartByWeek: Map<string, { team: string | null; part: string | null }>;
  overrideRows: WeekPositionOverrideRow[];
};

/**
 * 유저 1명의 주차별 effective 직책/소속 시리즈.
 *   · seasonKeys       — UPH 를 이 시즌들로 한정(미지정=전 시즌).
 *   · extraWeekStarts  — UPH 행이 없어도 결과에 포함해야 하는 주차(카드가 실제로 생성되는 주차 등).
 *                        이 주차에 carry-forward override 가 걸리면 행이 추가된다.
 *   · seasonKeyOfWeek  — extraWeekStarts 의 시즌 귀속 해소기(달력). 미지정이면 seasonKey=null.
 */
export async function loadUserWeekPositionSeries(input: {
  userId: string;
  seasonKeys?: string[] | null;
  extraWeekStarts?: Iterable<string>;
  seasonKeyOfWeek?: (weekStart: string) => string | null;
}): Promise<UserWeekPositionSeries> {
  const { userId } = input;
  const seasonKeys = (input.seasonKeys ?? []).filter((k): k is string => !!k);
  let q = supabaseAdmin
    .from("user_position_histories")
    .select("season_key,week_start_date,position_code,raw_team,raw_part")
    .eq("user_id", userId);
  if (input.seasonKeys != null) q = q.in("season_key", seasonKeys);

  // seasonKeys=[] 는 .in(...,[]) → 0행. UPH 없이 override-only 시리즈가 나오는 정상 경로다.
  const [uphRes, overrideRows] = await Promise.all([q, loadUserPositionOverrideRows(userId)]);
  if (uphRes.error) {
    // 카드/이력서는 이 조회 실패로 깨지면 안 된다 — override-only 시리즈로 degrade.
    console.warn("[positionResolver] UPH 조회 실패 → override-only 시리즈", {
      userId,
      message: (uphRes.error as { message?: string }).message,
    });
  }

  const overrideAsc = [...overrideRows].sort((a, b) =>
    a.weekStartDate.localeCompare(b.weekStartDate),
  );
  const overrideAt = (weekStart: string) => resolveOverrideAt(overrideAsc, weekStart);

  const rows: EffectiveWeekPosition[] = [];
  const overriddenTeamPartByWeek = new Map<string, { team: string | null; part: string | null }>();
  const seenWeeks = new Set<string>();

  for (const r of (uphRes.data ?? []) as Array<{
    season_key: string | null;
    week_start_date: string | null;
    position_code: PositionCode;
    raw_team: string | null;
    raw_part: string | null;
  }>) {
    const ws = r.week_start_date ? String(r.week_start_date).slice(0, 10) : null;
    if (ws) seenWeeks.add(ws);
    const ovr = ws ? overrideAt(ws) : null;
    rows.push({
      seasonKey: r.season_key,
      weekStart: ws,
      effectiveCode: ovr ? ovr.positionCode : r.position_code,
      uphCode: r.position_code,
      rawTeam: firstNonEmpty(ovr?.rawTeam, r.raw_team),
      rawPart: firstNonEmpty(ovr?.rawPart, r.raw_part),
      overridden: Boolean(ovr),
    });
    if (ovr && ws) {
      overriddenTeamPartByWeek.set(ws, {
        team: firstNonEmpty(ovr.rawTeam, r.raw_team),
        part: firstNonEmpty(ovr.rawPart, r.raw_part),
      });
    }
  }

  // UPH 행이 없는 주차(멤버십 폴백 주차)에도 override 가 이월되면 그 주차를 시리즈에 넣는다.
  //   대상 = 호출부가 준 extraWeekStarts ∪ override 가 실제 저장된 주차.
  const extras = new Set<string>();
  for (const ws of input.extraWeekStarts ?? []) extras.add(String(ws).slice(0, 10));
  for (const o of overrideAsc) extras.add(o.weekStartDate);
  for (const ws of extras) {
    if (seenWeeks.has(ws)) continue;
    const ovr = overrideAt(ws);
    if (!ovr) continue;
    const sk = input.seasonKeyOfWeek?.(ws) ?? null;
    if (input.seasonKeys != null && sk != null && !seasonKeys.includes(sk)) continue;
    rows.push({
      seasonKey: sk,
      weekStart: ws,
      effectiveCode: ovr.positionCode,
      uphCode: null, // ⚠ 시즌 대표(gap 메우기)에 기여하지 않는다 — 위 주석 참조.
      rawTeam: ovr.rawTeam,
      rawPart: ovr.rawPart,
      overridden: true,
    });
    overriddenTeamPartByWeek.set(ws, { team: ovr.rawTeam, part: ovr.rawPart });
  }

  rows.sort((a, b) => (a.weekStart ?? "").localeCompare(b.weekStart ?? ""));
  return { rows, overriddenTeamPartByWeek, overrideRows };
}

/**
 * 시즌 대표 직책(3주룰) — **basis 를 반드시 의식해서 고를 것**.
 *   · "uph"       : gap 주차를 메우는 fallback 용. override 소급 금지(카드 빌더 tier②).
 *   · "effective" : 화면에 "이 시즌의 직책"으로 **표시**하는 값(이력서 시즌 직책 C1/C2).
 *                   0~3주 정규 / 4~7주 심화면 각 주차 effective 로 3주룰을 돌린다.
 */
export function resolveSeasonPositionsFromSeries(
  series: UserWeekPositionSeries,
  basis: "uph" | "effective",
): Map<string, PositionCode> {
  const codesBySeason = new Map<string, PositionCode[]>();
  for (const r of series.rows) {
    if (!r.seasonKey) continue;
    const code = basis === "uph" ? r.uphCode : r.effectiveCode;
    if (!code) continue;
    const arr = codesBySeason.get(r.seasonKey) ?? [];
    arr.push(code);
    codesBySeason.set(r.seasonKey, arr);
  }
  const out = new Map<string, PositionCode>();
  for (const [key, codes] of codesBySeason) {
    const resolved = resolveSeasonPosition(codes);
    if (resolved) out.set(key, resolved);
  }
  return out;
}

/** 단건 편의 wrapper — 배치와 동일 규칙. 목록 화면에서는 반드시 배치를 쓸 것(N+1 금지). */
export async function resolvePositionAt(input: {
  userId: string;
  targetWeekStart: string;
  organization?: string | null;
}): Promise<ResolvedPosition> {
  const m = await resolvePositionAtBatch({
    userIds: [input.userId],
    targetWeekStart: input.targetWeekStart,
    organization: input.organization,
  });
  return m.get(input.userId) ?? EMPTY(input.userId);
}

export async function resolveCurrentPosition(input: {
  userId: string;
  organization?: string | null;
  todayIso?: string;
}): Promise<ResolvedPosition> {
  const m = await resolveCurrentPositionBatch({
    userIds: [input.userId],
    organization: input.organization,
    todayIso: input.todayIso,
  });
  return m.get(input.userId) ?? EMPTY(input.userId);
}

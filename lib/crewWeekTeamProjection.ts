// 주차 결과(크루) — 팀 활동 결과 projection. **고객 앱 buildTeamBattles 규칙의 1:1 이식본.**
//
// ⚠ 새 산식 설계 금지. front `../vraxium/lib/weekly-league-teams.ts` 의 buildTeamBattles()
//   집계 규칙을 그대로 옮긴 것이다(동일 테이블·동일 판정·동일 반올림). front/admin 은 별도 빌드라
//   import 이 불가능해 포팅했다 — lib/crewWeeklyMetricsAggregation 과 같은 선례.
//
// ── 이식한 규칙(front 398~470행) ─────────────────────────────────────────────
//   버킷      = teamNameOf(userId). 빈값/"-" → "미배정".
//   파트 수    = 1명 이상 배정된 distinct 파트명 수("-"/"미배정"/공백 제외).
//   심화/정규  = isAdvancedLevel(level): "심화" 로 시작하거나 "에이전트" 포함 → advanced, 그 외 regular.
//   휴식 분해  = verdict==="rest" 중 시즌휴식 집합에 있으면 seasonRest, 아니면 personalRest.
//   대전 결과  = success > fail → win · success < fail → lose · 동수 → draw   (3값. pending 없음)
//   matchCount = challengeCrew · winCount = successCrew · loseCount = failCrew
//   winRate    = challenge > 0 ? round(success/challenge*100) : 0
//   불변식     = total = challenge + rest = advanced + regular · challenge = success + fail
//                rest = seasonRest + personalRest
//
// ⚠ verdicts 는 **크루 결과(buildCrewResults)에서 파생**시킨다. 팀 숫자와 크루 행이 갈리지 않도록
//   같은 판정을 두 번 계산하지 않는다.
//
// 정렬(2026-07-22 결정):
//   · displayOrder 를 함께 산출·보존한다 → 고객 앱은 기존 순서(display_order asc)를 재현.
//   · 어드민 표는 같은 데이터를 team_name ko-KR 가나다순으로 **표시 시점에** 재정렬한다.
//     두 화면의 순서는 달라도 되고, 값은 같아야 한다.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { OrganizationSlug } from "@/lib/organizations";

export type TeamBattleResult = "win" | "lose" | "draw";

/** 크루 1명의 팀 판정 입력 — 크루 결과에서 파생한다. */
export type TeamVerdict = "success" | "fail" | "rest";

export type CrewWeekTeamResultDto = {
  teamId: string | null;
  teamName: string;
  /** 안정 키 — 등록팀=team_id · 미등록팀='name:'+정규화명. snapshot UNIQUE 키. */
  teamSnapshotKey: string;
  /** 고객 앱 정렬 재현용(카탈로그 미매칭 9999). 어드민 표는 이 값을 쓰지 않는다. */
  displayOrder: number;

  battleResult: TeamBattleResult;

  leader: {
    userId: string | null;
    displayName: string | null;
    schoolName: string | null;
    majorName: string | null;
  };

  partCount: number;
  totalCrew: number;
  advancedCrew: number;
  regularCrew: number;
  challengeCrew: number;
  /** 화면 "성장 휴식" = seasonRest + personalRest 합계(고객 앱과 동일). */
  restCrew: number;
  seasonRestCrew: number;
  personalRestCrew: number;
  successCrew: number;
  failCrew: number;

  matchCount: number;
  winCount: number;
  lossCount: number;
  winRatePercent: number;
};

// front isAdvancedLevel 미러 — DB 원본 등급값 판정.
function isAdvancedLevel(level: string | null | undefined): boolean {
  if (!level) return false;
  const v = level.trim();
  return v.startsWith("심화") || v.includes("에이전트");
}

function normalizeTeamKey(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

type MembershipRow = {
  user_id: string;
  team_name: string | null;
  part_name: string | null;
  membership_level: string | null;
  membership_state: string | null;
  is_current: boolean | null;
};

type HalfTeamRow = {
  id: string;
  team_name: string;
  display_order: number | null;
  leader_user_id: string | null;
  leader_name: string | null;
};

export type CrewWeekTeamContext = {
  /** user_id → 대표 멤버십(팀/파트/등급). */
  membershipByUser: Map<string, MembershipRow>;
  /** team_name(정규화) → 반기 카탈로그. */
  catalogByName: Map<string, HalfTeamRow>;
  /** leader user_id → 표시 정보. */
  leaderById: Map<string, { displayName: string | null; school: string | null; major: string | null }>;
};

// front pickPrimaryMembership 미러 — is_current 우선, 그 외 첫 행.
function pickPrimary(rows: MembershipRow[]): MembershipRow | null {
  if (rows.length === 0) return null;
  return rows.find((r) => r.is_current === true) ?? rows[0];
}

export async function loadCrewWeekTeamContext(opts: {
  organization: OrganizationSlug;
  userIds: string[];
  halfKey: string | null;
}): Promise<CrewWeekTeamContext> {
  const membershipByUser = new Map<string, MembershipRow>();
  const catalogByName = new Map<string, HalfTeamRow>();
  const leaderById = new Map<
    string,
    { displayName: string | null; school: string | null; major: string | null }
  >();

  // 1) 멤버십(팀/파트/등급).
  const byUser = new Map<string, MembershipRow[]>();
  for (let i = 0; i < opts.userIds.length; i += 300) {
    const { data } = await supabaseAdmin
      .from("user_memberships")
      .select("user_id,team_name,part_name,membership_level,membership_state,is_current")
      .in("user_id", opts.userIds.slice(i, i + 300));
    for (const r of (data ?? []) as MembershipRow[]) {
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
      byUser.get(r.user_id)!.push(r);
    }
  }
  for (const [uid, rows] of byUser) {
    const primary = pickPrimary(rows);
    if (primary) membershipByUser.set(uid, primary);
  }

  // 2) 팀 카탈로그 — 정확 halfKey 우선, 없으면 최신 half 폴백(front 와 동일 정책).
  const { data: halves } = await supabaseAdmin
    .from("cluster4_team_halves")
    .select("id,team_name,display_order,leader_user_id,leader_name,half_key")
    .eq("organization_slug", opts.organization);
  const latest = new Map<string, { hk: string; row: HalfTeamRow }>();
  for (const r of (halves ?? []) as Array<HalfTeamRow & { half_key: string }>) {
    const key = normalizeTeamKey(r.team_name);
    const exact = opts.halfKey != null && r.half_key === opts.halfKey;
    const prev = latest.get(key);
    if (exact) {
      latest.set(key, { hk: "￿", row: r }); // 정확 매칭 최우선
    } else if (!prev || r.half_key > prev.hk) {
      latest.set(key, { hk: r.half_key, row: r });
    }
  }
  for (const [k, v] of latest) catalogByName.set(k, v.row);

  // 3) 팀장 표시 정보 — user_educations 우선, user_profiles 폴백(front leaderById 규칙).
  const leaderIds = [...catalogByName.values()]
    .map((c) => c.leader_user_id)
    .filter((v): v is string => !!v);
  if (leaderIds.length > 0) {
    const [{ data: profs }, { data: edus }] = await Promise.all([
      supabaseAdmin
        .from("user_profiles")
        .select("user_id,display_name,school_name,department_name")
        .in("user_id", leaderIds),
      supabaseAdmin
        .from("user_educations")
        .select("user_id,school_name,major_name_1,sort_order")
        .in("user_id", leaderIds)
        .order("sort_order", { ascending: true }),
    ]);
    const eduByUser = new Map<string, { school_name: string | null; major_name_1: string | null }>();
    for (const e of (edus ?? []) as Array<{
      user_id: string;
      school_name: string | null;
      major_name_1: string | null;
    }>) {
      if (!eduByUser.has(e.user_id)) eduByUser.set(e.user_id, e);
    }
    for (const p of (profs ?? []) as Array<{
      user_id: string;
      display_name: string | null;
      school_name: string | null;
      department_name: string | null;
    }>) {
      const e = eduByUser.get(p.user_id);
      leaderById.set(p.user_id, {
        displayName: p.display_name ?? null,
        school: e?.school_name ?? p.school_name ?? null,
        major: e?.major_name_1 ?? p.department_name ?? null,
      });
    }
  }

  return { membershipByUser, catalogByName, leaderById };
}

// ── 순수 집계 ───────────────────────────────────────────────────────────────
// DB/시계 접근 없음 — 호출자가 이미 읽어 온 사실만 받는다.
export function buildCrewWeekTeamResults(opts: {
  ctx: CrewWeekTeamContext;
  /** user_id → 팀 판정(크루 결과에서 파생). rest 는 시즌/개인 구분 위해 별도 집합을 함께 받는다. */
  verdicts: Map<string, TeamVerdict>;
  /** 시즌 휴식 user_id 집합(그 주차 시즌 기준). */
  seasonRestUserIds: Set<string>;
}): CrewWeekTeamResultDto[] {
  const { ctx, verdicts, seasonRestUserIds } = opts;

  type Bucket = {
    teamName: string;
    successCrew: number;
    failCrew: number;
    seasonRestCrew: number;
    personalRestCrew: number;
    advancedCrew: number;
    regularCrew: number;
    partCrewByName: Map<string, number>;
  };
  const buckets = new Map<string, Bucket>();
  const bucketOf = (name: string): Bucket => {
    let b = buckets.get(name);
    if (!b) {
      b = {
        teamName: name,
        successCrew: 0,
        failCrew: 0,
        seasonRestCrew: 0,
        personalRestCrew: 0,
        advancedCrew: 0,
        regularCrew: 0,
        partCrewByName: new Map(),
      };
      buckets.set(name, b);
    }
    return b;
  };

  verdicts.forEach((verdict, userId) => {
    const m = ctx.membershipByUser.get(userId);
    const rawName = (m?.team_name ?? "").trim();
    const teamName = !rawName || rawName === "-" ? "미배정" : rawName;
    const b = bucketOf(teamName);

    // 파트 — 미배정 표기는 파트로 세지 않는다(front 와 동일).
    const rawPart = (m?.part_name ?? "").trim();
    if (rawPart && rawPart !== "-" && rawPart !== "미배정") {
      b.partCrewByName.set(rawPart, (b.partCrewByName.get(rawPart) ?? 0) + 1);
    }

    if (verdict === "success") b.successCrew++;
    else if (verdict === "fail") b.failCrew++;
    else if (seasonRestUserIds.has(userId)) b.seasonRestCrew++;
    else b.personalRestCrew++;

    if (isAdvancedLevel(m?.membership_level)) b.advancedCrew++;
    else b.regularCrew++;
  });

  const out: CrewWeekTeamResultDto[] = [];
  for (const b of buckets.values()) {
    const key = normalizeTeamKey(b.teamName);
    const catalog = ctx.catalogByName.get(key) ?? null;
    const challengeCrew = b.successCrew + b.failCrew;
    const restCrew = b.seasonRestCrew + b.personalRestCrew;
    const leaderId = catalog?.leader_user_id ?? null;
    const leaderInfo = leaderId ? ctx.leaderById.get(leaderId) ?? null : null;

    out.push({
      teamId: catalog?.id ?? null,
      teamName: b.teamName,
      // 등록팀은 team_id, 미등록팀은 정규화 팀명 기반 키(동명 저장 충돌 방지).
      teamSnapshotKey: catalog?.id ?? `name:${key}`,
      displayOrder: catalog?.display_order ?? 9999,
      battleResult:
        b.successCrew > b.failCrew ? "win" : b.successCrew < b.failCrew ? "lose" : "draw",
      leader: {
        userId: leaderId,
        // 카탈로그 leader_name 우선, 없으면 링크된 크루 display_name(front 규칙).
        displayName: catalog?.leader_name ?? leaderInfo?.displayName ?? null,
        schoolName: leaderInfo?.school ?? null,
        majorName: leaderInfo?.major ?? null,
      },
      partCount: b.partCrewByName.size,
      totalCrew: challengeCrew + restCrew,
      advancedCrew: b.advancedCrew,
      regularCrew: b.regularCrew,
      challengeCrew,
      restCrew,
      seasonRestCrew: b.seasonRestCrew,
      personalRestCrew: b.personalRestCrew,
      successCrew: b.successCrew,
      failCrew: b.failCrew,
      matchCount: challengeCrew,
      winCount: b.successCrew,
      lossCount: b.failCrew,
      winRatePercent: challengeCrew > 0 ? Math.round((b.successCrew / challengeCrew) * 100) : 0,
    });
  }

  // 저장/전송 순서는 고객 앱 재현용(displayOrder asc → 팀명). 어드민 표는 표시 시점에 ko-KR 재정렬.
  out.sort((a, b) =>
    a.displayOrder !== b.displayOrder
      ? a.displayOrder - b.displayOrder
      : a.teamName.localeCompare(b.teamName, "ko"),
  );
  return out;
}

/** 어드민 표 정렬 — 팀명 ko-KR 가나다순(고객 앱 display_order 와 별개). */
export function sortTeamsForAdmin(rows: CrewWeekTeamResultDto[]): CrewWeekTeamResultDto[] {
  return [...rows].sort((a, b) => a.teamName.localeCompare(b.teamName, "ko-KR"));
}

/** 공표 전 서버 검증 — DB CHECK 와 같은 불변식. 위반 시 공표 전체를 실패시킨다(부분 저장 금지). */
export function assertTeamInvariants(rows: CrewWeekTeamResultDto[]): string | null {
  for (const t of rows) {
    if (t.totalCrew !== t.advancedCrew + t.regularCrew) {
      return `[${t.teamName}] total(${t.totalCrew}) != advanced+regular(${t.advancedCrew}+${t.regularCrew})`;
    }
    if (t.totalCrew !== t.challengeCrew + t.restCrew) {
      return `[${t.teamName}] total(${t.totalCrew}) != challenge+rest(${t.challengeCrew}+${t.restCrew})`;
    }
    if (t.restCrew !== t.seasonRestCrew + t.personalRestCrew) {
      return `[${t.teamName}] rest(${t.restCrew}) != season+personal`;
    }
    if (t.challengeCrew !== t.successCrew + t.failCrew) {
      return `[${t.teamName}] challenge(${t.challengeCrew}) != success+fail`;
    }
    if (t.matchCount !== t.winCount + t.lossCount) {
      return `[${t.teamName}] match(${t.matchCount}) != win+loss`;
    }
    const expected =
      t.winCount > t.lossCount ? "win" : t.winCount < t.lossCount ? "lose" : "draw";
    if (t.battleResult !== expected) {
      return `[${t.teamName}] battleResult(${t.battleResult}) != counts(${expected})`;
    }
    if (t.winRatePercent < 0 || t.winRatePercent > 100) {
      return `[${t.teamName}] winRate 범위 밖(${t.winRatePercent})`;
    }
  }
  return null;
}

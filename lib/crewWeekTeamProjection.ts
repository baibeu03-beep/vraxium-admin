// 주차 결과(크루) — 팀 활동 결과 projection. **고객 앱 buildTeamBattles 규칙의 1:1 이식본.**
//
// ⚠ 새 산식 설계 금지. front `../vraxium/lib/weekly-league-teams.ts` 의 buildTeamBattles()
//   집계 규칙을 그대로 옮긴 것이다(동일 테이블·동일 판정·동일 반올림). front/admin 은 별도 빌드라
//   import 이 불가능해 포팅했다 — lib/crewWeeklyMetricsAggregation 과 같은 선례.
//
// ⚠ 소속 SoT(2026-07-23 정정): 팀/파트/클래스는 **크루 표와 같은 week-effective resolver**
//   (lib/positionResolver) 산출값을 쓴다. 종전에는 이 파일만 현재 user_memberships 를 다시 읽어,
//   같은 크루가 크루 표에서는 '사운드(T)'·팀 집계에서는 '미배정'으로 갈리는 실측 불일치가 있었다
//   (멤버십 행에 team_name 이 비어 있고 override/UPH 로만 팀이 결정되는 사람). → [[position-resolver-sot]]
//   이제 호출자가 crewResults 와 **동일한 값**을 positions 로 넘긴다(여기서 다시 조회하지 않는다).
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
import type { PositionCode } from "@/shared/crewClassPosition";

export type TeamBattleResult = "win" | "lose" | "draw";

/**
 * 팀 집계에 쓰는 크루 1명의 소속 — **크루 표에 실제로 표시된 값과 같은 것**을 넘긴다.
 *   teamName/partName = resolvePositionAtBatch 의 rawTeam/rawPart(프로필 폴백 포함, 크루 행과 동일 식).
 *   positionCode      = 같은 resolver 의 클래스 코드. 심화/정규 버킷 분기는 **코드로만** 한다
 *                       (라벨 문자열 비교 금지 — 어휘 2종이 섞이면 어느 버킷에도 안 걸려 사람이 사라진다).
 */
export type CrewWeekMemberPosition = {
  teamName: string | null;
  partName: string | null;
  positionCode: PositionCode | null;
};

// 심화 버킷 = 심화 등급 내 직책(에이전트·파트장). 운영진/정규/미상은 정규 버킷.
//   front isAdvancedLevel(membership_level) 과 같은 결과를 코드 어휘로 표현한 것이다
//   (resolvePositionLabels 가 membership_level='심화*' → advanced_* 코드로 이미 정규화한다).
const ADVANCED_CODES = new Set<PositionCode>(["advanced_agent", "advanced_part_leader"]);

/** 크루 1명의 팀 판정 입력 — 크루 결과에서 파생한다. */
export type TeamVerdict = "success" | "fail" | "rest";

export type CrewWeekTeamResultDto = {
  /** 반기 팀 카탈로그(cluster4_team_halves) 매칭 id. null = 실제 팀이 아님(가상 버킷). */
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

function normalizeTeamKey(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

type HalfTeamRow = {
  id: string;
  team_name: string;
  display_order: number | null;
  leader_user_id: string | null;
  leader_name: string | null;
};

export type CrewWeekTeamContext = {
  /** team_name(정규화) → 반기 카탈로그. */
  catalogByName: Map<string, HalfTeamRow>;
  /** leader user_id → 표시 정보. */
  leaderById: Map<string, { displayName: string | null; school: string | null; major: string | null }>;
};

// ⚠ 여기서 user_memberships 를 읽지 않는다 — 크루 소속은 호출자가 넘기는 resolver 산출값이 SoT 다.
export async function loadCrewWeekTeamContext(opts: {
  organization: OrganizationSlug;
  halfKey: string | null;
}): Promise<CrewWeekTeamContext> {
  const catalogByName = new Map<string, HalfTeamRow>();
  const leaderById = new Map<
    string,
    { displayName: string | null; school: string | null; major: string | null }
  >();

  // 1) 팀 카탈로그 — 정확 halfKey 우선, 없으면 최신 half 폴백(front 와 동일 정책).
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

  // 2) 팀장 표시 정보 — user_educations 우선, user_profiles 폴백(front leaderById 규칙).
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

  return { catalogByName, leaderById };
}

/**
 * 팀 projection 결과 — **실제 팀과 가상 버킷을 여기서 분리한다.**
 *
 * `미배정`(멤버십 team_name 이 비었거나 '-')은 팀이 아니라 카탈로그 미매칭 크루를 담는 가상 버킷이다.
 *   팀 표·팀 수·파트 수·전적·승패 팀 수·공표 snapshot 어디에도 들어가면 안 된다.
 *   ⚠ 소비 화면마다 각자 필터하지 않는다 — 분리는 이 projection 단계에서 **한 번만** 한다.
 *   ⚠ 크루 자체는 버리지 않는다. 크루 활동 결과 표와 크루 종합 지표에는 그대로 남는다
 *     (그 집계는 lib/crewWeeklyMetricsAggregation · buildCrewResults 소관이라 이 파일과 무관).
 */
export type CrewWeekTeamProjection = {
  /** 카탈로그에 매칭된 실제 팀(teamId != null). 팀 활동 결과의 유일한 원천. */
  teams: CrewWeekTeamResultDto[];
  /** 카탈로그 미매칭 버킷('미배정' 등). 감사·진단용으로만 반환한다. */
  unmatched: CrewWeekTeamResultDto[];
};

// ── 순수 집계 ───────────────────────────────────────────────────────────────
// DB/시계 접근 없음 — 호출자가 이미 읽어 온 사실만 받는다.
export function buildCrewWeekTeamResults(opts: {
  ctx: CrewWeekTeamContext;
  /**
   * user_id → 소속(팀·파트·클래스 코드). **크루 표에 표시된 값과 동일해야 한다.**
   *   그래야 "크루 표의 팀별 인원 합 == 팀 표 totalCrew 합" 이 구조적으로 성립한다.
   */
  positions: Map<string, CrewWeekMemberPosition>;
  /** user_id → 팀 판정(크루 결과에서 파생). rest 는 시즌/개인 구분 위해 별도 집합을 함께 받는다. */
  verdicts: Map<string, TeamVerdict>;
  /** 시즌 휴식 user_id 집합(그 주차 시즌 기준). */
  seasonRestUserIds: Set<string>;
}): CrewWeekTeamProjection {
  const { ctx, positions, verdicts, seasonRestUserIds } = opts;

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
    // 소속 = 크루 표와 같은 week-effective resolver 산출값(여기서 멤버십을 다시 읽지 않는다).
    const p = positions.get(userId) ?? null;
    const rawName = (p?.teamName ?? "").trim();
    const teamName = !rawName || rawName === "-" ? "미배정" : rawName;
    const b = bucketOf(teamName);

    // 파트 — 미배정 표기는 파트로 세지 않는다(front 와 동일).
    const rawPart = (p?.partName ?? "").trim();
    if (rawPart && rawPart !== "-" && rawPart !== "미배정") {
      b.partCrewByName.set(rawPart, (b.partCrewByName.get(rawPart) ?? 0) + 1);
    }

    if (verdict === "success") b.successCrew++;
    else if (verdict === "fail") b.failCrew++;
    else if (seasonRestUserIds.has(userId)) b.seasonRestCrew++;
    else b.personalRestCrew++;

    if (p?.positionCode != null && ADVANCED_CODES.has(p.positionCode)) b.advancedCrew++;
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
  // 실제 팀 / 가상 버킷 분리 — 판정 기준은 **카탈로그 매칭 여부(teamId)** 하나뿐이다.
  //   ('미배정' 이라는 표시 문자열로 판정하지 않는다 — 팀명이 바뀌어도 규칙이 흔들리지 않도록.)
  return {
    teams: out.filter((t) => t.teamId != null),
    unmatched: out.filter((t) => t.teamId == null),
  };
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

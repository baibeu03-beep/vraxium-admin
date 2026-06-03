// Server-only data layer for cluster4 weekly 평판/연계동료 카드 (미리보기·모달).
//
// weekly-cards DTO 에 주차별로 주입할:
//   - weeklyReputations[] : 받은 평판(target_user_id = 카드 주인), 방어적 최대 4건.
//   - weeklyColleagues[]  : 작성한 연계 동료(user_id = 카드 주인).
//   - reputationSummary   : { receivedCount(0~4), receivedLimit:4, fm(반영 4건 rating 합) }
//   - colleagueSummary    : { writtenCount, writtenLimit:3 }
//
// 인적사항(Cluster4PersonProfileDto)은 user_profiles + user_memberships 에서 일괄 조회한다.
//   N+1 회피: 관련 user_id 를 모아 in() 두 쿼리로 끝낸다.
//
// 주의:
//   - fameScore/fmScore(누적 포인트)와 reputationSummary.fm 은 별개 축 — 여기서는 평판 rating 만 다룬다.
//   - 저장 단계 4건 제한은 front repo 저장 API 책임. 여기서는 DTO 방어 cap 만 한다(검증 3).
//   - weekly_reviews 는 본 모듈과 무관(건드리지 않음).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type {
  Cluster4ColleagueSummaryDto,
  Cluster4PersonProfileDto,
  Cluster4ReputationSummaryDto,
  Cluster4WeeklyColleagueDto,
  Cluster4WeeklyReputationDto,
} from "@/shared/cluster4.contracts";

// 정책 상수. receivedLimit/writtenLimit DTO 값의 단일 출처.
export const REPUTATION_RECEIVED_LIMIT = 4;
export const COLLEAGUE_WRITTEN_LIMIT = 3;

export type WeeklyPeople = {
  reputationSummary: Cluster4ReputationSummaryDto;
  colleagueSummary: Cluster4ColleagueSummaryDto;
  weeklyReputations: Cluster4WeeklyReputationDto[];
  weeklyColleagues: Cluster4WeeklyColleagueDto[];
};

// 받은 평판 cap/FM 산출 (순수 함수 — 단위 검증용으로 분리).
//   입력: created_at 선착순 정렬된 rating 배열 (전체).
//   정책: 주차별 최대 REPUTATION_RECEIVED_LIMIT(4)건만 반영(방어적 cap). 저장 단계가 5번째를
//         막아야 하지만, 오염 데이터가 있어도 DTO 는 최대 4건만 반영한다(검증 3).
//   반환: reflectedCount(0~4) = 반영 건수, fm = 반영 4건의 rating 합.
export function summarizeReceivedReputations(ratingsInCreatedOrder: number[]): {
  reflectedCount: number;
  fm: number;
} {
  const reflected = ratingsInCreatedOrder.slice(0, REPUTATION_RECEIVED_LIMIT);
  return {
    reflectedCount: reflected.length,
    fm: reflected.reduce((sum, r) => sum + r, 0),
  };
}

// 빈 주차(평판·동료 없음) 기본값. 카드 fallback 과 동일 shape.
export function emptyWeeklyPeople(): WeeklyPeople {
  return {
    reputationSummary: { receivedCount: 0, receivedLimit: REPUTATION_RECEIVED_LIMIT, fm: 0 },
    colleagueSummary: { writtenCount: 0, writtenLimit: COLLEAGUE_WRITTEN_LIMIT },
    weeklyReputations: [],
    weeklyColleagues: [],
  };
}

type ReputationRow = {
  id: string;
  reviewer_id: string;
  target_user_id: string;
  week_card_id: string;
  rating: number;
  content: string;
  keyword: string;
  created_at: string | null;
};

type ColleagueRow = {
  id: string;
  user_id: string;
  week_card_id: string;
  colleague_id: string;
  rank: number;
  message: string | null;
  created_at: string | null;
};

type ProfileRow = {
  user_id: string;
  display_name: string | null;
  gender: string | null;
  birth_date: string | null;
  school_name: string | null;
  department_name: string | null;
  profile_photo_url: string | null;
  profile_tagline: string | null;
  profile_keyword: string | null;
  vision: string | null;
  role: string | null;
};

type MembershipRow = {
  user_id: string;
  team_name: string | null;
  part_name: string | null;
  membership_level: string | null;
  is_current: boolean | null;
  updated_at: string | null;
};

// 첫 비어있지 않은(트림 후 길이>0) 문자열을 고른다. profileTagline fallback 체인 등에 사용.
function preferString(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// 만 나이 계산 (adminCrewData.computeAge 와 동일 규칙 — 단일 행동 일관).
function computeAge(birthDate: string | null): number | null {
  if (!birthDate) return null;
  const today = new Date();
  const birth = new Date(`${birthDate}T00:00:00`);
  if (Number.isNaN(birth.getTime())) return null;
  let age = today.getFullYear() - birth.getFullYear();
  const hasHadBirthday =
    today.getMonth() > birth.getMonth() ||
    (today.getMonth() === birth.getMonth() && today.getDate() >= birth.getDate());
  if (!hasHadBirthday) age -= 1;
  return age >= 0 ? age : null;
}

// 멤버십 선택 우선순위: is_current → team/part 값 보유 → updated_at 최신.
//   user_memberships 는 한 사용자에 여러 row 가 존재할 수 있고(이력서 저장 시 find-or-create),
//   is_current=true 가 한 건도 없는 사용자도 많다. 이때 "최신 updated_at" 만으로 고르면
//   team_name/part_name 이 비어 있는 빈 row 가 최신이라는 이유로 선택돼, 실제 팀/파트를
//   보유한 과거 row(예: 이유나 = A&R/일반)를 가려 team/part 가 null 로 내려가는 버그가 있었다.
//   → is_current 가 동률이면 팀/파트 값을 가진 row 를 먼저 고른다.
function membershipHasTeamPart(m: MembershipRow): boolean {
  return Boolean(m.team_name) || Boolean(m.part_name);
}
function pickBestMembership(rows: MembershipRow[]): MembershipRow | undefined {
  return [...rows].sort((a, b) => {
    const currentDelta = Number(Boolean(b.is_current)) - Number(Boolean(a.is_current));
    if (currentDelta !== 0) return currentDelta;
    const teamPartDelta = Number(membershipHasTeamPart(b)) - Number(membershipHasTeamPart(a));
    if (teamPartDelta !== 0) return teamPartDelta;
    return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
  })[0];
}

// userId 집합 → 인적사항 맵. 실패해도 카드를 깨뜨리지 않고 빈 맵으로 폴백한다.
async function buildPersonProfileMap(
  userIds: string[],
): Promise<Map<string, Cluster4PersonProfileDto>> {
  const map = new Map<string, Cluster4PersonProfileDto>();
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  if (ids.length === 0) return map;

  const [profileRes, membershipRes] = await Promise.all([
    supabaseAdmin
      .from("user_profiles")
      .select(
        "user_id,display_name,gender,birth_date,school_name,department_name,profile_photo_url,profile_tagline,profile_keyword,vision,role",
      )
      .in("user_id", ids),
    supabaseAdmin
      .from("user_memberships")
      .select("user_id,team_name,part_name,membership_level,is_current,updated_at")
      .in("user_id", ids),
  ]);

  if (profileRes.error) {
    console.warn("[cluster4/weekly-people] user_profiles lookup failed", {
      message: profileRes.error.message,
    });
  }
  if (membershipRes.error) {
    console.warn("[cluster4/weekly-people] user_memberships lookup failed", {
      message: membershipRes.error.message,
    });
  }

  // user_id → 최적 membership (is_current 우선).
  const membershipByUser = new Map<string, MembershipRow[]>();
  for (const row of (membershipRes.data ?? []) as MembershipRow[]) {
    const list = membershipByUser.get(row.user_id) ?? [];
    list.push(row);
    membershipByUser.set(row.user_id, list);
  }

  for (const p of (profileRes.data ?? []) as ProfileRow[]) {
    const m = pickBestMembership(membershipByUser.get(p.user_id) ?? []);
    map.set(p.user_id, {
      userId: p.user_id,
      name: p.display_name ?? null,
      gender: p.gender ?? null,
      age: computeAge(p.birth_date ?? null),
      school: p.school_name ?? null,
      department: p.department_name ?? null,
      team: m?.team_name ?? null,
      part: m?.part_name ?? null,
      // badge-status 의 등급 source. membership_state("active" 등 상태값)가 아닌 등급(level).
      // 값 없을 때 role 로의 fallback 은 프론트(resolvePersonalInfo)가 수행 — 여기선 raw 등급만.
      membershipLevel: m?.membership_level ?? null,
      role: p.role ?? null,
      profileImageUrl: p.profile_photo_url ?? null,
      // 한줄소개: profile_tagline 우선 → profile_keyword → vision (첫 비어있지 않은 값).
      profileTagline: preferString(p.profile_tagline, p.profile_keyword, p.vision),
    });
  }

  return map;
}

// weekly_reputations(받은) + weekly_colleagues(작성한) + 인적사항을 주차별로 묶어 반환한다.
//   - 받은 평판: target_user_id = profileUserId, week_card_id ∈ weekIds. created_at asc 정렬.
//   - 작성 동료: user_id = profileUserId, week_card_id ∈ weekIds. rank asc 정렬.
//   - 평판은 주차별 최대 4건만 반영(방어적 cap) — 5건 이상이어도 created_at 선착 4건. fm=그 4건 rating 합.
// 조회 실패해도 throw 하지 않고 빈 맵으로 폴백한다(카드 전체 보호).
export async function fetchWeeklyPeopleByWeek(
  profileUserId: string,
  weekIds: string[],
): Promise<Map<string, WeeklyPeople>> {
  const result = new Map<string, WeeklyPeople>();
  if (!profileUserId || weekIds.length === 0) return result;

  const [repRes, colRes] = await Promise.all([
    supabaseAdmin
      .from("weekly_reputations")
      .select("id,reviewer_id,target_user_id,week_card_id,rating,content,keyword,created_at")
      .eq("target_user_id", profileUserId)
      .in("week_card_id", weekIds)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }),
    supabaseAdmin
      .from("weekly_colleagues")
      .select("id,user_id,week_card_id,colleague_id,rank,message,created_at")
      .eq("user_id", profileUserId)
      .in("week_card_id", weekIds)
      .order("rank", { ascending: true })
      .order("id", { ascending: true }),
  ]);

  if (repRes.error) {
    console.warn("[cluster4/weekly-people] weekly_reputations lookup failed", {
      message: repRes.error.message,
    });
  }
  if (colRes.error) {
    console.warn("[cluster4/weekly-people] weekly_colleagues lookup failed", {
      message: colRes.error.message,
    });
  }

  const repRows = ((repRes.data ?? []) as Record<string, unknown>[]).map(
    (raw): ReputationRow => ({
      id: String(raw.id ?? ""),
      reviewer_id: String(raw.reviewer_id ?? ""),
      target_user_id: String(raw.target_user_id ?? ""),
      week_card_id: String(raw.week_card_id ?? ""),
      rating: toNumber(raw.rating),
      content: typeof raw.content === "string" ? raw.content : "",
      keyword: typeof raw.keyword === "string" ? raw.keyword : "",
      created_at: typeof raw.created_at === "string" ? raw.created_at : null,
    }),
  );
  const colRows = ((colRes.data ?? []) as Record<string, unknown>[]).map(
    (raw): ColleagueRow => ({
      id: String(raw.id ?? ""),
      user_id: String(raw.user_id ?? ""),
      week_card_id: String(raw.week_card_id ?? ""),
      colleague_id: String(raw.colleague_id ?? ""),
      rank: toNumber(raw.rank),
      message: typeof raw.message === "string" ? raw.message : null,
      created_at: typeof raw.created_at === "string" ? raw.created_at : null,
    }),
  );

  // 인적사항: reviewer + colleague + 카드 주인(toProfile) 모두 일괄 조회.
  const involvedIds = [
    profileUserId,
    ...repRows.map((r) => r.reviewer_id),
    ...colRows.map((c) => c.colleague_id),
  ];
  const profileMap = await buildPersonProfileMap(involvedIds);
  const ownerProfile = profileMap.get(profileUserId) ?? null;

  // week_card_id → rows.
  const repByWeek = new Map<string, ReputationRow[]>();
  for (const r of repRows) {
    const list = repByWeek.get(r.week_card_id) ?? [];
    list.push(r);
    repByWeek.set(r.week_card_id, list);
  }
  const colByWeek = new Map<string, ColleagueRow[]>();
  for (const c of colRows) {
    const list = colByWeek.get(c.week_card_id) ?? [];
    list.push(c);
    colByWeek.set(c.week_card_id, list);
  }

  for (const weekId of new Set(weekIds)) {
    const allRep = repByWeek.get(weekId) ?? [];
    // 방어적 cap: 주차별 최대 4건(created_at 선착). 저장 단계가 5번째를 막아야 하지만, 오염 데이터 방어.
    // summary(개수/fm)는 순수 헬퍼를 단일 출처로 쓰고, 배열도 동일 limit 으로 자른다(정합).
    const reflectedRep = allRep.slice(0, REPUTATION_RECEIVED_LIMIT);
    const weeklyReputations: Cluster4WeeklyReputationDto[] = reflectedRep.map((r) => ({
      id: r.id,
      weekId: r.week_card_id,
      fromUserId: r.reviewer_id,
      toUserId: r.target_user_id,
      rating: r.rating,
      comment: r.content,
      keyword: r.keyword,
      createdAt: r.created_at,
      fromProfile: profileMap.get(r.reviewer_id) ?? null,
      toProfile: ownerProfile,
    }));
    const repSummaryNums = summarizeReceivedReputations(allRep.map((r) => r.rating));
    const reputationSummary: Cluster4ReputationSummaryDto = {
      receivedCount: repSummaryNums.reflectedCount, // 0~4 (cap 적용된 반영 건수)
      receivedLimit: REPUTATION_RECEIVED_LIMIT,
      fm: repSummaryNums.fm,
    };

    const allCol = colByWeek.get(weekId) ?? [];
    const weeklyColleagues: Cluster4WeeklyColleagueDto[] = allCol.map((c) => ({
      id: c.id,
      weekId: c.week_card_id,
      fromUserId: c.user_id,
      colleagueUserId: c.colleague_id,
      rank: c.rank,
      message: c.message,
      createdAt: c.created_at,
      colleagueProfile: profileMap.get(c.colleague_id) ?? null,
    }));
    const colleagueSummary: Cluster4ColleagueSummaryDto = {
      writtenCount: allCol.length,
      writtenLimit: COLLEAGUE_WRITTEN_LIMIT,
    };

    // 평판·동료 둘 다 없으면 맵에 넣지 않는다(호출부가 emptyWeeklyPeople 폴백).
    if (weeklyReputations.length === 0 && weeklyColleagues.length === 0) continue;

    result.set(weekId, {
      reputationSummary,
      colleagueSummary,
      weeklyReputations,
      weeklyColleagues,
    });
  }

  return result;
}

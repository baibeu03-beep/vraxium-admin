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
import { loadCurrentWeekOverrideLabels } from "@/lib/positionResolver";
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
  // membership 행에 team/part 가 전혀 없을 때의 최종 폴백(고객앱 resolver 규칙 5).
  current_team_name: string | null;
  current_part_name: string | null;
};

type MembershipRow = {
  user_id: string;
  team_name: string | null;
  part_name: string | null;
  membership_level: string | null;
  is_current: boolean | null;
  updated_at: string | null;
};

// 학력 행. 학교/학과의 canonical source 는 user_educations 다(user_profiles.school_name/
// department_name 은 legacy/secondary — PMS 이관 사용자는 department_name 이 NULL 이고 실제 학과는
// user_educations.major_name_1 에만 있음). adminCrewData / cluster4CafeLineMatch 와 동일 규칙.
type EducationRow = {
  user_id: string;
  school_name: string | null;
  major_name_1: string | null;
  is_primary: boolean | null;
  sort_order: number | null;
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

// 고객앱과 동일한 membership 선택 resolver (adminCrewData.pickBestMembership 와 동일 규칙).
//   user_memberships 는 한 사용자에 여러 row 가 존재할 수 있고(이력서 저장 시 find-or-create),
//   is_current=true 가 한 건도 없거나, 반대로 is_current=true 인데 team_name 이 NULL 인
//   사용자도 있다. is_current 만 먼저 보면 후자에서 빈 team 행이 뽑혀 실제 팀/파트(예: 이유나
//   = A&R/일반)를 가려 null 로 내려간다. 그래서 "team_name 보유 여부"를 is_current 보다 우선한다.
//   우선순위 (작을수록 우선):
//     0) is_current=true && team_name 존재
//     1) team_name 존재
//     2) is_current=true
//     3) 그 외(첫 행)
//   같은 등급 안에서는 updated_at 최신 우선.
// (어떤 행도 team_name 이 없으면 user_profiles.current_team_name/current_part_name 으로 폴백 —
//  규칙 5. buildPersonProfileMap 에서 처리.)
function membershipRank(m: MembershipRow): number {
  const isCurrent = Boolean(m.is_current);
  const hasTeam = typeof m.team_name === "string" && m.team_name.trim() !== "";
  if (isCurrent && hasTeam) return 0;
  if (hasTeam) return 1;
  if (isCurrent) return 2;
  return 3;
}
function pickBestMembership(rows: MembershipRow[]): MembershipRow | undefined {
  return [...rows].sort((a, b) => {
    const rankDelta = membershipRank(a) - membershipRank(b);
    if (rankDelta !== 0) return rankDelta;
    return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
  })[0];
}

// 대표 학력 선택: is_primary 우선 → sort_order asc → updated_at 최신.
// (adminResumeCardData.pickPrimaryEducation 과 동일 의도 — 단일 대표 학력 1건.)
function pickPrimaryEducation(rows: EducationRow[]): EducationRow | undefined {
  return [...rows].sort((a, b) => {
    const primaryDelta = Number(Boolean(b.is_primary)) - Number(Boolean(a.is_primary));
    if (primaryDelta !== 0) return primaryDelta;
    const sortDelta = (a.sort_order ?? Number.MAX_SAFE_INTEGER) - (b.sort_order ?? Number.MAX_SAFE_INTEGER);
    if (sortDelta !== 0) return sortDelta;
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

  const [profileRes, membershipRes, educationRes] = await Promise.all([
    supabaseAdmin
      .from("user_profiles")
      .select(
        "user_id,display_name,gender,birth_date,school_name,department_name,profile_photo_url,profile_tagline,profile_keyword,vision,role,current_team_name,current_part_name",
      )
      .in("user_id", ids),
    supabaseAdmin
      .from("user_memberships")
      .select("user_id,team_name,part_name,membership_level,is_current,updated_at")
      .in("user_id", ids),
    // 학력(학교/학과)의 canonical source. PMS 이관 사용자는 user_profiles.department_name 이 NULL
    // 이고 실제 학과는 여기에만 있어, department 가 "-" 로 비던 버그의 원인.
    supabaseAdmin
      .from("user_educations")
      .select("user_id,school_name,major_name_1,is_primary,sort_order,updated_at")
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
  if (educationRes.error) {
    // 학력 조회 실패는 카드를 깨뜨리지 않는다 — user_profiles 값으로 폴백.
    console.warn("[cluster4/weekly-people] user_educations lookup failed", {
      message: educationRes.error.message,
    });
  }

  // user_id → 최적 membership (is_current 우선).
  const membershipByUser = new Map<string, MembershipRow[]>();
  for (const row of (membershipRes.data ?? []) as MembershipRow[]) {
    const list = membershipByUser.get(row.user_id) ?? [];
    list.push(row);
    membershipByUser.set(row.user_id, list);
  }

  // user_id → 학력 행들(대표 학력 선택용).
  const educationByUser = new Map<string, EducationRow[]>();
  for (const row of (educationRes.data ?? []) as EducationRow[]) {
    const list = educationByUser.get(row.user_id) ?? [];
    list.push(row);
    educationByUser.set(row.user_id, list);
  }

  // 동료 인적사항은 "현재 소속" 표시다 — 현재 주차 override 가 있으면 그 값을 따른다
  //   (회원 목록·크루 상세와 같은 현재 상태 화면 규칙).
  const weekOverrides = await loadCurrentWeekOverrideLabels(ids);
  for (const p of (profileRes.data ?? []) as ProfileRow[]) {
    const m = pickBestMembership(membershipByUser.get(p.user_id) ?? []);
    const edu = pickPrimaryEducation(educationByUser.get(p.user_id) ?? []);
    const ovr = weekOverrides.get(p.user_id) ?? null;
    map.set(p.user_id, {
      userId: p.user_id,
      name: p.display_name ?? null,
      gender: p.gender ?? null,
      age: computeAge(p.birth_date ?? null),
      // 학교/학과: user_educations(canonical) 우선 → user_profiles 폴백.
      school: preferString(edu?.school_name, p.school_name),
      department: preferString(edu?.major_name_1, p.department_name),
      team: ovr?.rawTeam ?? preferString(m?.team_name, p.current_team_name),
      part: ovr ? ovr.rawPart : preferString(m?.part_name, p.current_part_name),
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

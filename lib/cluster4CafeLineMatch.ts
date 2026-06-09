// 라인 개설 크루 — 네이버 카페 댓글 닉네임 → 우리 클럽 크루 매칭 (server-only).
//
// 정책(2026-06-09) — 오매칭 방지가 매칭 성공률보다 우선. 애매하면 절대 자동 매칭하지 않고
//   "수동 확인 필요(review)"로 분리한다. 닉네임 형식은 구형/신형 둘 다 지원한다.
//
//   [구형] "15기 덕성여대 이채빈" = {기수, 학교명, 이름}. 기수는 신뢰 불가 → 매칭 조건에서 제외(참고용).
//     1순위: 이름 + 학교명 으로 정확히 1명 → 자동 매칭.
//     2순위: 이름만 으로 정확히 1명 → 자동 매칭.
//     그 외(이름+학교 2명↑ / 이름 2명↑ / 이름 0명) → 수동 확인.
//
//   [신형] "이채빈 콘텐츠팀 국제학부" = {이름, 팀명, 전공명}.
//     이름 + 팀명 + 전공명 3개 모두 일치하고 후보가 정확히 1명일 때만 자동 매칭.
//     부분 일치 / 2명↑ / 0명 → 전부 수동 확인.
//
//   매칭 완료 후 화면 표시값은 닉네임 원문이 아니라 우리 DB 기준(crew_no/이름/팀/파트/학교/전공).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchCrewNoMap } from "@/lib/adminCrewNo";

export type CrewRecord = {
  userId: string;
  crewNo: number | null;
  name: string;
  teamName: string | null;
  partName: string | null;
  schoolName: string | null;
  majorName: string | null;
  organization: string | null;
};

export type CafeMatchStatus = "auto" | "review";

export type CafeMatchedCandidate = {
  // 시간순(첫 댓글 등장 순) 정렬 보존용 인덱스.
  order: number;
  nickname: string; // 원문(검증/육안 비교용)
  matchReason: string;
  crew: CrewRecord;
};

export type CafeReviewItem = {
  order: number;
  nickname: string;
  reason: string;
  // 참고: 이름만으로 걸린 후보들(있으면) — 운영자가 수동 추가 시 도움.
  nameCandidates: CrewRecord[];
};

export type CafeMatchResult = {
  matched: CafeMatchedCandidate[];
  review: CafeReviewItem[];
  matchedCrewCount: number;
  reviewCount: number;
};

// ── 정규화/비교 ──
// 공백 전부 제거 + 소문자(한글 무영향). 학교/팀/전공 표기 흔들림(공백)에 견고.
function norm(s: string | null | undefined): string {
  return (s ?? "").trim().replace(/\s+/g, "").toLowerCase();
}
function eq(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = norm(a);
  const nb = norm(b);
  return na.length > 0 && na === nb;
}

// ── 닉네임 파서 ──
export type ParsedNickname =
  | { format: "old"; name: string; schoolName: string; cohort: string; raw: string }
  | { format: "new"; name: string; teamName: string; majorName: string; raw: string }
  | { format: "unknown"; name: string; raw: string };

const COHORT_RE = /^\d+기$/;

export function parseCafeNickname(raw: string): ParsedNickname {
  const s = (raw ?? "").trim().replace(/\s+/g, " ");
  const tokens = s.length > 0 ? s.split(" ") : [];

  // 구형: 첫 토큰이 "{N}기". [기수, 학교명, 이름...] — 이름은 나머지 토큰.
  if (tokens.length >= 3 && COHORT_RE.test(tokens[0])) {
    return {
      format: "old",
      cohort: tokens[0],
      schoolName: tokens[1],
      name: tokens.slice(2).join(" "),
      raw,
    };
  }

  // 신형: 정확히 3토큰 [이름, 팀명, 전공명].
  if (tokens.length === 3) {
    return {
      format: "new",
      name: tokens[0],
      teamName: tokens[1],
      majorName: tokens[2],
      raw,
    };
  }

  return { format: "unknown", name: tokens[0] ?? "", raw };
}

// ── 단건 매칭 ──
type SingleMatch =
  | { status: "auto"; crew: CrewRecord; reason: string }
  | { status: "review"; reason: string; nameCandidates: CrewRecord[] };

export function matchNickname(
  parsed: ParsedNickname,
  crews: CrewRecord[],
): SingleMatch {
  if (parsed.format === "old") {
    const nameMatches = crews.filter((c) => eq(c.name, parsed.name));
    // 1순위: 이름 + 학교명 정확히 1명.
    const ns = nameMatches.filter((c) => eq(c.schoolName, parsed.schoolName));
    if (ns.length === 1) {
      return { status: "auto", crew: ns[0], reason: "old:name+school" };
    }
    // 2순위: 이름만 정확히 1명.
    if (nameMatches.length === 1) {
      return { status: "auto", crew: nameMatches[0], reason: "old:name-only" };
    }
    const reason =
      nameMatches.length === 0
        ? "구형: 이름 후보 0명"
        : ns.length >= 2
          ? `구형: 이름+학교 후보 ${ns.length}명`
          : `구형: 이름 후보 ${nameMatches.length}명`;
    return { status: "review", reason, nameCandidates: nameMatches };
  }

  if (parsed.format === "new") {
    const nameMatches = crews.filter((c) => eq(c.name, parsed.name));
    const full = nameMatches.filter(
      (c) => eq(c.teamName, parsed.teamName) && eq(c.majorName, parsed.majorName),
    );
    if (full.length === 1) {
      return { status: "auto", crew: full[0], reason: "new:name+team+major" };
    }
    const reason =
      nameMatches.length === 0
        ? "신형: 후보 0명"
        : full.length >= 2
          ? `신형: 이름+팀+전공 후보 ${full.length}명`
          : "신형: 부분 일치(이름/팀/전공 불완전)";
    return { status: "review", reason, nameCandidates: nameMatches };
  }

  // 형식 불명 — 절대 자동 매칭 금지.
  return {
    status: "review",
    reason: "형식 불명(파싱 불가) — 수동 확인",
    nameCandidates: crews.filter((c) => eq(c.name, parsed.name)),
  };
}

// ── 닉네임 목록(시간순) → 후보/수동확인 분리 ──
// nicknames 는 첫 댓글 등장 시간순(collectCafeCommentNicknames 의 nicknames 순서).
export function matchCafeComments(
  nicknames: string[],
  crews: CrewRecord[],
): CafeMatchResult {
  const matched: CafeMatchedCandidate[] = [];
  const review: CafeReviewItem[] = [];
  const matchedUserIds = new Set<string>();

  nicknames.forEach((nickname, order) => {
    const parsed = parseCafeNickname(nickname);
    const m = matchNickname(parsed, crews);
    if (m.status === "auto") {
      if (matchedUserIds.has(m.crew.userId)) return; // 동일 크루 중복 댓글 → 1회만
      matchedUserIds.add(m.crew.userId);
      matched.push({ order, nickname, matchReason: m.reason, crew: m.crew });
    } else {
      review.push({ order, nickname, reason: m.reason, nameCandidates: m.nameCandidates });
    }
  });

  return {
    matched,
    review,
    matchedCrewCount: matched.length,
    reviewCount: review.length,
  };
}

// ── 크루 레코드 로더 ──
// 매칭은 클럽 전체 크루 기준(실무 정보=common, 조직 무관). user_profiles 1행 = 1크루.
// school/major 는 user_educations(우선) → user_profiles(school_name/department_name) 폴백.
export async function loadCrewRecords(): Promise<CrewRecord[]> {
  const { data: profiles, error: pErr } = await supabaseAdmin
    .from("user_profiles")
    .select(
      "user_id,display_name,school_name,department_name,organization_slug,current_team_name,current_part_name",
    );
  if (pErr) throw new Error(pErr.message);
  const profileRows = (profiles ?? []) as Array<{
    user_id: string;
    display_name: string | null;
    school_name: string | null;
    department_name: string | null;
    organization_slug: string | null;
    current_team_name: string | null;
    current_part_name: string | null;
  }>;
  if (profileRows.length === 0) return [];

  const userIds = profileRows.map((p) => p.user_id);

  // 멤버십(현재 우선) — team/part.
  const memMap = new Map<
    string,
    { team_name: string | null; part_name: string | null }
  >();
  for (let i = 0; i < userIds.length; i += 500) {
    const slice = userIds.slice(i, i + 500);
    const { data } = await supabaseAdmin
      .from("user_memberships")
      .select("user_id,team_name,part_name,is_current")
      .in("user_id", slice);
    for (const m of (data ?? []) as Array<{
      user_id: string;
      team_name: string | null;
      part_name: string | null;
      is_current: boolean | null;
    }>) {
      const cur = memMap.get(m.user_id);
      if (!cur || m.is_current) {
        memMap.set(m.user_id, { team_name: m.team_name, part_name: m.part_name });
      }
    }
  }

  // 학력(primary/sort 우선) — best-effort(테이블 미존재 시 빈 맵).
  const eduMap = new Map<
    string,
    { school_name: string | null; major_name_1: string | null }
  >();
  try {
    for (let i = 0; i < userIds.length; i += 500) {
      const slice = userIds.slice(i, i + 500);
      const { data, error } = await supabaseAdmin
        .from("user_educations")
        .select("user_id,school_name,major_name_1,is_primary,sort_order")
        .in("user_id", slice);
      if (error) break;
      for (const e of (data ?? []) as Array<{
        user_id: string;
        school_name: string | null;
        major_name_1: string | null;
        is_primary: boolean | null;
        sort_order: number | null;
      }>) {
        const cur = eduMap.get(e.user_id);
        if (!cur || e.is_primary) {
          eduMap.set(e.user_id, {
            school_name: e.school_name,
            major_name_1: e.major_name_1,
          });
        }
      }
    }
  } catch {
    /* user_educations 미존재 — profile 폴백 사용 */
  }

  const crewNoMap = await fetchCrewNoMap(userIds);

  const pick = (...vals: Array<string | null | undefined>): string | null => {
    for (const v of vals) {
      if (typeof v === "string" && v.trim().length > 0) return v.trim();
    }
    return null;
  };

  return profileRows.map((p) => {
    const edu = eduMap.get(p.user_id);
    const mem = memMap.get(p.user_id);
    return {
      userId: p.user_id,
      crewNo: crewNoMap.get(p.user_id) ?? null,
      name: p.display_name?.trim() ?? "",
      teamName: pick(mem?.team_name, p.current_team_name),
      partName: pick(mem?.part_name, p.current_part_name),
      schoolName: pick(edu?.school_name, p.school_name),
      majorName: pick(edu?.major_name_1, p.department_name),
      organization: p.organization_slug,
    };
  });
}

// 매칭/수동추가 검색용 — q(이름/학교/팀/전공/crew_no) 부분일치 필터.
export function filterCrewRecords(crews: CrewRecord[], q: string): CrewRecord[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  return crews.filter((c) => {
    return (
      c.name.toLowerCase().includes(needle) ||
      (c.schoolName ?? "").toLowerCase().includes(needle) ||
      (c.teamName ?? "").toLowerCase().includes(needle) ||
      (c.majorName ?? "").toLowerCase().includes(needle) ||
      (c.crewNo != null && String(c.crewNo).includes(needle))
    );
  });
}

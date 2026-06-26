import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  halfKeyToLastSeasonKey,
  halfKeyToSeasonKeys,
  seasonKeyToSeasonLabel,
  halfLabel,
  isHalfKey,
  isEditableHalf,
  nextHalfKey,
  seasonKeyToHalfKey,
  compareHalfKeyDesc,
} from "@/lib/teamHalf";
import { getUserIdByCrewCode } from "@/lib/adminCrewCodeData";
import { getCrewDetailDto } from "@/lib/adminCrewDetailData";
import { getClubRankGradeBatch } from "@/lib/cluster3ClubRankData";
import { classLabel } from "@/lib/adminMembersTypes";
import { isOrganizationSlug } from "@/lib/organizations";

// 반기별 팀 SoT(cluster4_team_halves) 데이터 접근.
//   · 조회: 반기 → 그 반기의 팀 목록(불변 스냅샷 team_name).
//   · 쓰기: 현재 반기만 허용(과거 반기 fail-closed). user_memberships /
//     user_position_histories 역산 일절 없음 — 본 테이블이 단일 SoT.

export class TeamHalfWriteError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "TeamHalfWriteError";
    this.status = status;
  }
}

// 파트×주차 존재표 x축 1열(선택 반기의 한 주차). 년도 생략·시즌명+주차 라벨.
export type PartWeekColumnDto = {
  weekStartDate: string; // weeks.start_date (YYYY-MM-DD) — UPH 조인 키
  seasonKey: string;
  seasonLabel: string; // 겨울/봄/여름/가을
  weekNumber: number | null;
  label: string; // "겨울 1"
  isRest: boolean; // 공식 휴식 주차
};

// 팀별 파트×주차 존재표. partNames = y축(일반 first), present[partIdx][weekIdx] = 그 주 존재 여부.
//   x축 주차 목록은 DTO 최상위 weekColumns 와 인덱스 일치.
export type PartWeekMatrixDto = {
  partNames: string[];
  present: boolean[][];
};

export type TeamHalfTeamDto = {
  teamHalfId: string; // cluster4_team_halves.id (수정/삭제·파트 카탈로그 키)
  teamName: string;
  teamId: string | null;
  displayOrder: number;
  isActive: boolean;
  description: string | null;
  leaderUserId: string | null;
  leaderCrewCode: string | null;
  // 팀장 기본정보(시안 box Row2). 이름 = leader_name SoT(명단) 우선, 없으면 연결크루 display_name.
  //   인물 부가정보(성별/생년월일/학교/전공/거주/클래스/품계)는 연결크루 존재 시에만 채움(무매칭=null→"-").
  leaderName: string | null;
  leaderBirth6: string | null; // YYMMDD
  leaderGender: string | null;
  leaderSchool: string | null;
  leaderMajor: string | null;
  leaderResidence: string | null;
  leaderClassLabel: string | null; // 클래스(정규/심화/운영진…)
  leaderGradeLabel: string | null; // 품계(예: "2품")
  // 파트(현재 주차 기준) — 점유 파트 없으면 "일반"(min 1).
  partCount: number;
  partNames: string[];
  // 파트×주차 존재표(선택 반기 누적). loadTeamPartsInfo(GET) 에서만 채움 — POST 응답은 null.
  partWeekMatrix: PartWeekMatrixDto | null;
};

// 한 클럽(조직)당 한 반기 최대 팀 수. 백엔드 강제 검증의 SoT.
export const MAX_TEAMS_PER_CLUB = 10;

export const MAX_TEAM_NAME_LENGTH = 12;
export const MAX_TEAM_DESCRIPTION_LENGTH = 200;

export type HalfOptionDto = {
  halfKey: string;
  label: string;
  lastSeasonKey: string | null;
  isCurrent: boolean;
  editable: boolean;
};

export type TeamPartsInfoDto = {
  organization: string;
  currentHalfKey: string | null;
  selectedHalfKey: string | null;
  editable: boolean;
  halves: HalfOptionDto[];
  teams: TeamHalfTeamDto[];
  // 파트×주차 존재표 x축(선택 반기 ~26주). 팀별 partWeekMatrix.present 와 인덱스 일치.
  weekColumns: PartWeekColumnDto[];
};

type Row = {
  id: string;
  team_name: string;
  team_id: string | null;
  display_order: number;
  is_active: boolean;
  description: string | null;
  leader_user_id: string | null;
  leader_crew_code: string | null;
  leader_name: string | null;
};

// 팀 생성 직후/점유 파트가 없을 때 노출하는 기본 파트명.
export const DEFAULT_PART_NAME = "일반";

// 오늘이 속한 시즌 → 그 시즌의 반기. 미일치 시 today 이전 시작 시즌 중 최신으로 폴백.
export async function resolveCurrentHalfKey(
  today?: string,
): Promise<string | null> {
  const todayIso = today ?? new Date().toISOString().slice(0, 10);

  const { data, error } = await supabaseAdmin
    .from("season_definitions")
    .select("season_key,start_date,end_date")
    .lte("start_date", todayIso)
    .order("start_date", { ascending: false });

  if (error) throw new Error(error.message);

  const rows = (data ?? []) as Array<{
    season_key: string;
    start_date: string;
    end_date: string;
  }>;
  if (rows.length === 0) return null;

  // start_date 내림차순 → 첫 행이 today 를 포함하면 그것, 아니면(공백 구간) 최신 과거 시즌.
  const containing = rows.find(
    (r) => r.start_date <= todayIso && r.end_date >= todayIso,
  );
  const chosen = containing ?? rows[0];
  return seasonKeyToHalfKey(chosen.season_key);
}

// 반기 목록(최신순) + 현재/편집 가능 플래그.
//   데이터가 있는 반기 ∪ {현재 반기, 다음 반기} — 다음 반기는 데이터가 없어도 미리 등록할 수
//   있도록 항상 선택지로 노출한다(빈 반기 = 팀 0).
export async function listAvailableHalves(
  organization: string,
  currentHalfKey: string | null,
): Promise<HalfOptionDto[]> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_team_halves")
    .select("half_key")
    .eq("organization_slug", organization);

  if (error) throw new Error(error.message);

  const keySet = new Set(
    ((data ?? []) as Array<{ half_key: string }>).map((r) => r.half_key),
  );
  // 현재 반기 + 다음 반기를 항상 포함(미리 등록 가능).
  if (currentHalfKey) {
    keySet.add(currentHalfKey);
    const next = nextHalfKey(currentHalfKey);
    if (next) keySet.add(next);
  }
  const keys = Array.from(keySet).sort(compareHalfKeyDesc);

  return keys.map((halfKey) => ({
    halfKey,
    label: halfLabel(halfKey),
    lastSeasonKey: halfKeyToLastSeasonKey(halfKey),
    isCurrent: halfKey === currentHalfKey,
    editable: isEditableHalf(halfKey, currentHalfKey),
  }));
}

// 팀장 기본정보(이름·생년월일6·성별·거주·학교·전공) 배치 조회. 시안 box Row2 표시용.
//   user_profiles + 대표 학력(user_educations) — 품계/클래스(코호트 스캔)는 box 미표시라 제외.
type LeaderBasic = {
  name: string | null;
  org: string | null; // 연결 크루의 organization_slug — 팀 org 와 다르면 상세 미노출(조직 강제).
  birth6: string | null;
  gender: string | null;
  residence: string | null;
  school: string | null;
  major: string | null;
  classLabel: string | null;
  gradeLabel: string | null;
};

// user_memberships 행 중 대표 등급(membership_level) 선택 — 클래스 산출용.
//   현재+팀보유 우선 → 팀보유 → 현재 → 그 외, 동률은 updated_at desc.
//   (lib/lineAvailability·diag-team-leader-management-gate 의 pickLevel 과 동일 규칙)
type MemLevelRow = {
  user_id: string;
  membership_level: string | null;
  team_name: string | null;
  is_current: boolean | null;
  updated_at: string | null;
};
function pickLevel(rows: MemLevelRow[]): string | null {
  if (rows.length === 0) return null;
  const rank = (r: MemLevelRow) => {
    const cur = Boolean(r.is_current);
    const team = typeof r.team_name === "string" && r.team_name.trim() !== "";
    if (cur && team) return 0;
    if (team) return 1;
    if (cur) return 2;
    return 3;
  };
  const best = rows.slice().sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
  })[0];
  return best?.membership_level ?? null;
}

async function getLeaderBasicsBatch(
  userIds: string[],
): Promise<Map<string, LeaderBasic>> {
  const out = new Map<string, LeaderBasic>();
  if (userIds.length === 0) return out;

  const { data: profs, error: pErr } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name,gender,birth_date,address,school_name,department_name,role,organization_slug")
    .in("user_id", userIds);
  if (pErr) throw new Error(pErr.message);

  const { data: edus, error: eErr } = await supabaseAdmin
    .from("user_educations")
    .select("user_id,school_name,major_name_1,is_primary,sort_order,updated_at")
    .in("user_id", userIds);
  if (eErr) throw new Error(eErr.message);

  // 클래스(role+membership_level) + 품계(getClubRankGradeBatch) 배치.
  const { data: mems, error: mErr } = await supabaseAdmin
    .from("user_memberships")
    .select("user_id,membership_level,team_name,is_current,updated_at")
    .in("user_id", userIds);
  if (mErr) throw new Error(mErr.message);
  const memByUser = new Map<string, MemLevelRow[]>();
  for (const m of (mems ?? []) as MemLevelRow[]) {
    const arr = memByUser.get(m.user_id) ?? [];
    arr.push(m);
    memByUser.set(m.user_id, arr);
  }
  const gradeMap = await getClubRankGradeBatch(userIds);

  // 대표 학력 선택: is_primary 우선 → sort_order asc → updated_at desc.
  const eduByUser = new Map<string, { school: string | null; major: string | null }>();
  const groups = new Map<string, any[]>();
  for (const e of (edus ?? []) as any[]) {
    const arr = groups.get(e.user_id) ?? [];
    arr.push(e);
    groups.set(e.user_id, arr);
  }
  for (const [uid, arr] of groups) {
    arr.sort((a, b) => {
      if (!!b.is_primary !== !!a.is_primary) return b.is_primary ? 1 : -1;
      if ((a.sort_order ?? 0) !== (b.sort_order ?? 0))
        return (a.sort_order ?? 0) - (b.sort_order ?? 0);
      return String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? ""));
    });
    const top = arr[0];
    eduByUser.set(uid, { school: top?.school_name ?? null, major: top?.major_name_1 ?? null });
  }

  for (const p of (profs ?? []) as Array<{
    user_id: string;
    display_name: string | null;
    gender: string | null;
    birth_date: string | null;
    address: string | null;
    school_name: string | null;
    department_name: string | null;
    role: string | null;
    organization_slug: string | null;
  }>) {
    const edu = eduByUser.get(p.user_id);
    const level = pickLevel(memByUser.get(p.user_id) ?? []);
    const grade = gradeMap.get(p.user_id);
    out.set(p.user_id, {
      name: p.display_name,
      org: p.organization_slug,
      birth6: toBirth6(p.birth_date),
      gender: p.gender,
      residence: p.address,
      school: edu?.school ?? p.school_name ?? null,
      major: edu?.major ?? p.department_name ?? null,
      classLabel: classLabel(p.role ?? null, level),
      gradeLabel: grade?.label ?? null,
    });
  }
  return out;
}

// [POST 폴백 전용] 현재 주차 기준 팀별 파트 점유(user_memberships 현재·active).
//   GET(loadTeamPartsInfo)에서는 derivePartsFromMatrix(선택 반기 마지막 활동 주차)로 덮어쓴다.
//   register/save POST 응답에만 쓰이고 프론트는 GET 으로 재로딩하므로 표시에 영향 없음.
async function computeTeamPartInfo(
  organization: string,
  teamNames: string[],
): Promise<Map<string, { partCount: number; partNames: string[] }>> {
  const out = new Map<string, { partCount: number; partNames: string[] }>();
  for (const t of teamNames) out.set(t, { partCount: 1, partNames: [DEFAULT_PART_NAME] });
  if (teamNames.length === 0) return out;

  const { data: mems, error: mErr } = await supabaseAdmin
    .from("user_memberships")
    .select("user_id,team_name,part_name,is_current,membership_state")
    .in("team_name", teamNames)
    .eq("is_current", true);
  if (mErr) throw new Error(mErr.message);

  const rows = ((mems ?? []) as Array<{
    user_id: string;
    team_name: string | null;
    part_name: string | null;
    is_current: boolean | null;
    membership_state: string | null;
  }>).filter((m) => m.membership_state !== "rest");

  // org 매칭(user_profiles.organization_slug == organization).
  const uids = Array.from(new Set(rows.map((r) => r.user_id)));
  const orgByUser = new Map<string, string | null>();
  if (uids.length > 0) {
    const { data: profs, error: pErr } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id,organization_slug")
      .in("user_id", uids);
    if (pErr) throw new Error(pErr.message);
    for (const p of (profs ?? []) as Array<{ user_id: string; organization_slug: string | null }>) {
      orgByUser.set(p.user_id, p.organization_slug);
    }
  }

  // team_name → 점유 파트(크루 ≥1) 집합(노출 순서 = 첫 등장 순).
  const occupied = new Map<string, string[]>();
  for (const r of rows) {
    if (orgByUser.get(r.user_id) !== organization) continue;
    if (!r.team_name) continue;
    const part = r.part_name?.trim();
    if (!part) continue;
    const list = occupied.get(r.team_name) ?? [];
    if (!list.includes(part)) list.push(part);
    occupied.set(r.team_name, list);
  }

  for (const t of teamNames) {
    const parts = occupied.get(t);
    if (parts && parts.length > 0) {
      out.set(t, { partCount: parts.length, partNames: parts });
    }
    // 점유 파트 없음 → 기본값(일반·1) 유지.
  }
  return out;
}

// 특정 반기의 활성 팀 목록(노출 순) + 팀장 기본정보 + 파트(현재 주차).
export async function listHalfTeams(
  organization: string,
  halfKey: string,
): Promise<TeamHalfTeamDto[]> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_team_halves")
    .select(
      "id,team_name,team_id,display_order,is_active,description,leader_user_id,leader_crew_code,leader_name",
    )
    .eq("organization_slug", organization)
    .eq("half_key", halfKey)
    .eq("is_active", true)
    .order("display_order", { ascending: true });

  if (error) throw new Error(error.message);

  const rows = (data ?? []) as Row[];

  const leaderIds = Array.from(
    new Set(rows.map((r) => r.leader_user_id).filter((id): id is string => !!id)),
  );
  const [leaderBasics, partInfo] = await Promise.all([
    getLeaderBasicsBatch(leaderIds),
    computeTeamPartInfo(organization, rows.map((r) => r.team_name)),
  ]);

  return rows.map((r) => {
    const lbRaw = r.leader_user_id ? leaderBasics.get(r.leader_user_id) : null;
    // 조직 강제: 연결 크루의 org 가 팀 org 와 다르면 상세를 노출하지 않는다(다른 조직 동명 방지).
    //   leader_name(이름 SoT)은 유지되므로 이름만 표시되고 나머지는 "-".
    const lb = lbRaw && lbRaw.org === organization ? lbRaw : null;
    const pi = partInfo.get(r.team_name) ?? {
      partCount: 1,
      partNames: [DEFAULT_PART_NAME],
    };
    return {
      teamHalfId: r.id,
      teamName: r.team_name,
      teamId: r.team_id,
      displayOrder: r.display_order,
      isActive: r.is_active,
      description: r.description,
      leaderUserId: r.leader_user_id,
      leaderCrewCode: r.leader_crew_code,
      // 이름 = 명단 SoT(leader_name) 우선, 없으면 연결크루 display_name. 둘 다 없으면 null→"-".
      leaderName: r.leader_name ?? lb?.name ?? null,
      // 부가정보는 연결크루 존재 시에만(무매칭=null→UI "-").
      leaderBirth6: lb?.birth6 ?? null,
      leaderGender: lb?.gender ?? null,
      leaderSchool: lb?.school ?? null,
      leaderMajor: lb?.major ?? null,
      leaderResidence: lb?.residence ?? null,
      leaderClassLabel: lb?.classLabel ?? null,
      leaderGradeLabel: lb?.gradeLabel ?? null,
      partCount: pi.partCount,
      partNames: pi.partNames,
      partWeekMatrix: null, // loadTeamPartsInfo(GET)에서 채움.
    };
  });
}

// ── 파트×주차 존재표 계산 ──────────────────────────────────────────────
// 선택 반기의 두 시즌(방학→학기, ~26주) x축 + 팀별 파트(누적) y축 존재표.
//   주차별 소속 이력 SoT = user_position_histories(PMS useractivities 이관, 주차단위).
//   조인: organization + 정규화(괄호 strip)된 raw_team == team_name, week_start_date == weeks.start_date.
//   y축 파트 = 카탈로그(cluster4_team_parts, "일반" 보장) ∪ UPH raw_part(있는 그대로 전부).
//   셀 = 그 주에 그 파트 소속 크루 ≥1(존재). UPH 무접촉·read 전용 → snapshot 영향 없음.
const stripParen = (s: string): string => s.replace(/\(.*?\)/g, "").trim();

async function computePartWeekData(
  organization: string,
  halfKey: string,
  teams: Array<{ teamHalfId: string; teamName: string }>,
): Promise<{
  weekColumns: PartWeekColumnDto[];
  byTeam: Map<string, PartWeekMatrixDto>;
}> {
  const byTeam = new Map<string, PartWeekMatrixDto>();
  const seasons = halfKeyToSeasonKeys(halfKey);
  if (!seasons) return { weekColumns: [], byTeam };

  // 1) x축 주차(두 시즌 전체, 휴식 포함). 방학시즌 → 학기시즌, 각 주차번호 오름차순.
  const { data: wdata, error: wErr } = await supabaseAdmin
    .from("weeks")
    .select("start_date,season_key,week_number,is_official_rest")
    .in("season_key", seasons);
  if (wErr) throw new Error(wErr.message);
  const seasonOrder = (sk: string) => (sk === seasons[0] ? 0 : 1);
  const weekRows = ((wdata ?? []) as Array<{
    start_date: string;
    season_key: string;
    week_number: number | null;
    is_official_rest: boolean | null;
  }>).sort(
    (a, b) =>
      seasonOrder(a.season_key) - seasonOrder(b.season_key) ||
      (a.week_number ?? 0) - (b.week_number ?? 0),
  );
  const weekColumns: PartWeekColumnDto[] = weekRows.map((w) => ({
    weekStartDate: String(w.start_date).slice(0, 10),
    seasonKey: w.season_key,
    seasonLabel: seasonKeyToSeasonLabel(w.season_key),
    weekNumber: w.week_number,
    label: `${seasonKeyToSeasonLabel(w.season_key)} ${w.week_number ?? ""}`.trim(),
    isRest: !!w.is_official_rest,
  }));
  const weekIdxByStart = new Map(weekColumns.map((c, i) => [c.weekStartDate, i]));

  if (teams.length === 0) return { weekColumns, byTeam };

  // 2) 카탈로그 파트(team_half_id 별) — "일반" 보장·표시 순서.
  const catalogByTeamName = new Map<string, string[]>(); // teamName → 비-일반 파트(순서)
  const teamHalfIds = teams.map((t) => t.teamHalfId);
  const nameByHalfId = new Map(teams.map((t) => [t.teamHalfId, t.teamName]));
  const { data: cps, error: cErr } = await supabaseAdmin
    .from("cluster4_team_parts")
    .select("team_half_id,part_name,is_default,display_order")
    .in("team_half_id", teamHalfIds);
  if (cErr) throw new Error(cErr.message);
  const catalogRows = ((cps ?? []) as Array<{
    team_half_id: string;
    part_name: string;
    is_default: boolean | null;
    display_order: number | null;
  }>).sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
  for (const r of catalogRows) {
    const tn = nameByHalfId.get(r.team_half_id);
    if (!tn) continue;
    if (r.part_name === DEFAULT_PART_NAME) continue; // "일반"은 항상 맨 앞 고정.
    const arr = catalogByTeamName.get(tn) ?? [];
    if (!arr.includes(r.part_name)) arr.push(r.part_name);
    catalogByTeamName.set(tn, arr);
  }

  // 3) UPH(주차단위 소속 이력) — org + 두 시즌. 페이지네이션.
  const uph: Array<{
    raw_team: string | null;
    raw_part: string | null;
    week_start_date: string;
  }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from("user_position_histories")
      .select("raw_team,raw_part,week_start_date")
      .eq("organization", organization)
      .in("season_key", seasons)
      .order("week_start_date", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as typeof uph;
    uph.push(...batch);
    if (batch.length < 1000) break;
  }

  // 4) team_name 매칭(직접 → 괄호 strip). team_name 은 org 내 유일.
  const teamNameSet = new Set(teams.map((t) => t.teamName));
  // teamName → partName → Set<weekIdx>, 그리고 partName 최초 등장 weekIdx(정렬용).
  const presence = new Map<string, Map<string, Set<number>>>();
  const firstSeen = new Map<string, Map<string, number>>();
  for (const r of uph) {
    const rt = r.raw_team ?? "";
    const team = teamNameSet.has(rt)
      ? rt
      : teamNameSet.has(stripParen(rt))
        ? stripParen(rt)
        : null;
    if (!team) continue;
    const wi = weekIdxByStart.get(String(r.week_start_date).slice(0, 10));
    if (wi === undefined) continue;
    const part = (r.raw_part ?? "").trim();
    if (!part) continue; // null/empty raw_part 는 파트 미상 — 제외.
    const pm = presence.get(team) ?? new Map<string, Set<number>>();
    const set = pm.get(part) ?? new Set<number>();
    set.add(wi);
    pm.set(part, set);
    presence.set(team, pm);
    const fm = firstSeen.get(team) ?? new Map<string, number>();
    if (!fm.has(part) || wi < (fm.get(part) ?? Infinity)) fm.set(part, wi);
    firstSeen.set(team, fm);
  }

  // 5) 팀별 matrix 조립. y축 = ["일반", 카탈로그 비-일반(순서), UPH-only(최초주차→이름)].
  for (const t of teams) {
    const seen = presence.get(t.teamName) ?? new Map<string, Set<number>>();
    const first = firstSeen.get(t.teamName) ?? new Map<string, number>();

    const partNames: string[] = [DEFAULT_PART_NAME];
    for (const p of catalogByTeamName.get(t.teamName) ?? []) {
      if (!partNames.includes(p)) partNames.push(p);
    }
    const uphOnly = [...seen.keys()]
      .filter((p) => !partNames.includes(p))
      .sort(
        (a, b) =>
          (first.get(a) ?? Infinity) - (first.get(b) ?? Infinity) ||
          a.localeCompare(b),
      );
    for (const p of uphOnly) partNames.push(p);

    const present = partNames.map((p) => {
      const set = seen.get(p);
      return weekColumns.map((_, wi) => !!set?.has(wi));
    });
    byTeam.set(t.teamName, { partNames, present });
  }

  return { weekColumns, byTeam };
}

// 파트 수/파트명 = 선택 반기 "마지막 활동 주차"(존재표에서 어떤 파트든 ≥1) 기준.
//   파트×주차 존재표(②)와 동일 시점 — 그 주에 실제 존재한 파트만 노출(현재 멤버십 아님).
//   순서 = 존재표 y축(matrix.partNames) 순 → 같은 box 안 행 순서와 일치.
//   활동 주차 없음(전 반기 데이터 0) → "일반"(min 1) 폴백.
function derivePartsFromMatrix(
  matrix: PartWeekMatrixDto,
  weekCount: number,
): { partCount: number; partNames: string[] } {
  let lastIdx = -1;
  for (let wi = weekCount - 1; wi >= 0; wi--) {
    if (matrix.present.some((row) => row[wi])) {
      lastIdx = wi;
      break;
    }
  }
  if (lastIdx < 0) {
    return { partCount: 1, partNames: [DEFAULT_PART_NAME] };
  }
  const names = matrix.partNames.filter((_, pi) => matrix.present[pi][lastIdx]);
  if (names.length === 0) {
    return { partCount: 1, partNames: [DEFAULT_PART_NAME] };
  }
  return { partCount: names.length, partNames: names };
}

// 페이지 1회 로드: 현재 반기 + 반기 옵션 + 선택 반기 팀.
//   selectedHalfKey 미지정 → 현재 반기, 현재가 데이터에 없으면 최신 반기.
export async function loadTeamPartsInfo(
  organization: string,
  selectedHalfKey?: string | null,
  today?: string,
): Promise<TeamPartsInfoDto> {
  const currentHalfKey = await resolveCurrentHalfKey(today);
  const halves = await listAvailableHalves(organization, currentHalfKey);

  let selected: string | null = null;
  if (selectedHalfKey && halves.some((h) => h.halfKey === selectedHalfKey)) {
    selected = selectedHalfKey;
  } else if (currentHalfKey && halves.some((h) => h.halfKey === currentHalfKey)) {
    selected = currentHalfKey;
  } else if (halves.length > 0) {
    selected = halves[0].halfKey;
  }

  const teams = selected ? await listHalfTeams(organization, selected) : [];
  const editable = selected != null && isEditableHalf(selected, currentHalfKey);

  // 파트×주차 존재표(선택 반기). 팀별 matrix 를 teams 에 병합 + x축 weekColumns.
  let weekColumns: PartWeekColumnDto[] = [];
  if (selected && teams.length > 0) {
    const { weekColumns: cols, byTeam } = await computePartWeekData(
      organization,
      selected,
      teams.map((t) => ({ teamHalfId: t.teamHalfId, teamName: t.teamName })),
    );
    weekColumns = cols;
    // ① 팀정보 ② 파트 수/파트명 ③ 존재표 — 모두 선택 반기 마지막 활동 주차로 통일.
    for (const t of teams) {
      const m = byTeam.get(t.teamName) ?? null;
      t.partWeekMatrix = m;
      if (m) {
        const derived = derivePartsFromMatrix(m, cols.length);
        t.partCount = derived.partCount;
        t.partNames = derived.partNames;
      }
      // m 없음(이론상 미발생) → listHalfTeams 멤버십 폴백 값 유지.
    }
  } else if (selected) {
    // 팀이 없어도 x축은 계산(빈 표·UI 일관).
    const { weekColumns: cols } = await computePartWeekData(
      organization,
      selected,
      [],
    );
    weekColumns = cols;
  }

  return {
    organization,
    currentHalfKey,
    selectedHalfKey: selected,
    editable,
    halves,
    teams,
    weekColumns,
  };
}

// 현재 반기 팀 목록 저장(순서 포함). 과거 반기는 fail-closed.
//   teamNames 순서 = display_order. 목록에서 빠진 기존 팀은 is_active=false 로 보존(삭제 아님).
export async function saveCurrentHalfTeams(
  organization: string,
  halfKey: string,
  teamNames: string[],
  today?: string,
): Promise<TeamHalfTeamDto[]> {
  if (!isHalfKey(halfKey)) {
    throw new TeamHalfWriteError(400, "유효하지 않은 반기 키입니다.");
  }

  const currentHalfKey = await resolveCurrentHalfKey(today);
  if (!isEditableHalf(halfKey, currentHalfKey)) {
    throw new TeamHalfWriteError(
      403,
      "현재 또는 다음 반기만 수정할 수 있습니다. 과거 반기는 조회 전용입니다.",
    );
  }

  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const raw of teamNames) {
    const name = (raw ?? "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    cleaned.push(name);
  }

  // 기존 행(비활성 포함) 로드 — team_id 보존/복원용.
  const { data: existingData, error: existingError } = await supabaseAdmin
    .from("cluster4_team_halves")
    .select("id,team_name,team_id,is_active")
    .eq("organization_slug", organization)
    .eq("half_key", halfKey);

  if (existingError) throw new TeamHalfWriteError(500, existingError.message);

  const existing = (existingData ?? []) as Array<{
    id: string;
    team_name: string;
    team_id: string | null;
    is_active: boolean;
  }>;
  const byName = new Map(existing.map((r) => [r.team_name, r]));

  // 새 목록에 없는 기존 활성 팀 → 비활성화(보존).
  const keep = new Set(cleaned);
  const toDeactivate = existing.filter((r) => r.is_active && !keep.has(r.team_name));
  for (const row of toDeactivate) {
    const { error } = await supabaseAdmin
      .from("cluster4_team_halves")
      .update({ is_active: false })
      .eq("id", row.id);
    if (error) throw new TeamHalfWriteError(500, error.message);
  }

  // 신규 팀의 team_id soft-link(현재 마스터에 동일 org/name 있으면).
  const newNames = cleaned.filter((n) => !byName.has(n));
  const linkByName = new Map<string, string>();
  if (newNames.length > 0) {
    const { data: masterData, error: masterError } = await supabaseAdmin
      .from("cluster4_teams")
      .select("id,team_name")
      .eq("organization_slug", organization)
      .in("team_name", newNames);
    if (masterError) throw new TeamHalfWriteError(500, masterError.message);
    for (const m of (masterData ?? []) as Array<{ id: string; team_name: string }>) {
      linkByName.set(m.team_name, m.id);
    }
  }

  // upsert: 순서대로 display_order 부여 + 활성화.
  for (let i = 0; i < cleaned.length; i++) {
    const name = cleaned[i];
    const order = i + 1;
    const prior = byName.get(name);
    if (prior) {
      const { error } = await supabaseAdmin
        .from("cluster4_team_halves")
        .update({ display_order: order, is_active: true })
        .eq("id", prior.id);
      if (error) throw new TeamHalfWriteError(500, error.message);
    } else {
      const { error } = await supabaseAdmin
        .from("cluster4_team_halves")
        .insert({
          organization_slug: organization,
          half_key: halfKey,
          team_name: name,
          display_order: order,
          is_active: true,
          team_id: linkByName.get(name) ?? null,
        });
      if (error) throw new TeamHalfWriteError(500, error.message);
    }
  }

  return listHalfTeams(organization, halfKey);
}

// ── 팀장 크루코드 호출 ────────────────────────────────────────────────
// crew_code 로 등록된 크루를 조회해 팝업 [6] 영역 11개 필드를 반환한다.
//   인물 정보 SoT = 기존 크루/프로필(getCrewDetailDto) + 품계(getClubRankGradeBatch, live).
//   코드로 조회되지 않으면 null → 팀장 등록 불가(신규 인물은 먼저 크루 등록 필요).
export type TeamLeaderCandidateDto = {
  userId: string;
  crewCode: string | null;
  organizationSlug: string | null;
  name: string | null;
  gender: string | null;
  birth6: string | null; // 생년월일 6자리(YYMMDD)
  residence: string | null; // 거주
  school: string | null;
  major: string | null;
  classLabel: string | null; // 클래스
  teamName: string | null; // 팀 소속
  partName: string | null; // 파트 소속
  successWeeks: number | null; // 성공 주차
  gradeLabel: string | null; // 품계(예: "2품")
};

function toBirth6(birthDate: string | null): string | null {
  if (!birthDate) return null;
  const digits = birthDate.replace(/\D/g, "");
  return digits.length >= 6 ? digits.slice(2, 8) : null; // YYYYMMDD → YYMMDD
}

export async function lookupCrewByCode(
  crewCode: string,
): Promise<TeamLeaderCandidateDto | null> {
  const userId = await getUserIdByCrewCode(crewCode);
  if (!userId) return null;

  const detail = await getCrewDetailDto(userId);
  if (!detail) return null;

  const gradeMap = await getClubRankGradeBatch([userId]);
  const grade = gradeMap.get(userId);

  return {
    userId: detail.userId,
    crewCode: detail.crewCode,
    organizationSlug: detail.organizationSlug,
    name: detail.displayName,
    gender: detail.gender,
    birth6: toBirth6(detail.birthDate),
    residence: detail.address,
    school: detail.schoolName,
    major: detail.departmentName,
    classLabel: detail.classLabel,
    teamName: detail.teamName,
    partName: detail.partName,
    successWeeks: detail.clubSummary?.successWeeks ?? null,
    gradeLabel: grade?.label ?? null,
  };
}

// ── 팀 등록(현재 반기만) ──────────────────────────────────────────────
// 한 클럽당 최대 MAX_TEAMS_PER_CLUB(10) 강제. 팀장은 crew_code 로 재해석(서버 권위).
//   동일 팀명 활성 → 409, 비활성 → 재활성+갱신, 신규 → append.
export type RegisterTeamInput = {
  organization: string;
  halfKey: string;
  teamName: string;
  description: string;
  leaderCrewCode: string;
};

export async function registerTeamHalf(
  input: RegisterTeamInput,
  today?: string,
): Promise<{ teams: TeamHalfTeamDto[] }> {
  const organization = String(input.organization ?? "").trim();
  const halfKey = String(input.halfKey ?? "").trim();
  const teamName = String(input.teamName ?? "").trim();
  const description = String(input.description ?? "").trim();
  const leaderCrewCode = String(input.leaderCrewCode ?? "").trim();

  if (!isOrganizationSlug(organization)) {
    throw new TeamHalfWriteError(400, "유효한 조직이 필요합니다.");
  }
  if (!isHalfKey(halfKey)) {
    throw new TeamHalfWriteError(400, "유효하지 않은 반기 키입니다.");
  }
  // 현재 반기만 등록 허용(과거 반기 fail-closed).
  const currentHalfKey = await resolveCurrentHalfKey(today);
  if (!isEditableHalf(halfKey, currentHalfKey)) {
    throw new TeamHalfWriteError(
      403,
      "현재 또는 다음 반기만 수정할 수 있습니다. 과거 반기는 조회 전용입니다.",
    );
  }
  if (!teamName) {
    throw new TeamHalfWriteError(400, "팀 명을 입력해주세요.");
  }
  if (teamName.length > MAX_TEAM_NAME_LENGTH) {
    throw new TeamHalfWriteError(
      400,
      `팀 명은 최대 ${MAX_TEAM_NAME_LENGTH}자까지 입력할 수 있습니다.`,
    );
  }
  if (!description) {
    throw new TeamHalfWriteError(400, "팀 개요를 입력해주세요.");
  }
  if (description.length > MAX_TEAM_DESCRIPTION_LENGTH) {
    throw new TeamHalfWriteError(
      400,
      `팀 개요는 최대 ${MAX_TEAM_DESCRIPTION_LENGTH}자까지 입력할 수 있습니다.`,
    );
  }

  // 팀장 — crew_code 로 재해석(이미 등록된 크루만 가능).
  if (!leaderCrewCode) {
    throw new TeamHalfWriteError(400, "팀장 크루코드를 입력해주세요.");
  }
  const leaderUserId = await getUserIdByCrewCode(leaderCrewCode);
  if (!leaderUserId) {
    throw new TeamHalfWriteError(
      400,
      "해당 크루코드의 크루를 찾을 수 없습니다. 팀장은 이미 등록된 크루만 가능합니다.",
    );
  }

  // 기존 행(활성/비활성) 로드 — 10개 제한·중복·재활성 판정.
  const { data: existingData, error: existingError } = await supabaseAdmin
    .from("cluster4_team_halves")
    .select("id,team_name,display_order,is_active")
    .eq("organization_slug", organization)
    .eq("half_key", halfKey);
  if (existingError) throw new TeamHalfWriteError(500, existingError.message);

  const existing = (existingData ?? []) as Array<{
    id: string;
    team_name: string;
    display_order: number;
    is_active: boolean;
  }>;

  const activeCount = existing.filter((r) => r.is_active).length;
  const sameName = existing.find((r) => r.team_name === teamName);

  // 활성 동일 팀명 → 중복.
  if (sameName?.is_active) {
    throw new TeamHalfWriteError(409, "이미 등록된 팀입니다.");
  }
  // 신규 활성 추가가 한도 초과면 차단(재활성도 새 활성 1 증가이므로 동일 검증).
  if (activeCount >= MAX_TEAMS_PER_CLUB) {
    throw new TeamHalfWriteError(
      400,
      `한 클럽에는 최대 ${MAX_TEAMS_PER_CLUB}개 팀까지만 등록할 수 있습니다.`,
    );
  }

  // team_id soft-link(현재 마스터에 동일 org/name 있으면).
  const { data: masterData, error: masterError } = await supabaseAdmin
    .from("cluster4_teams")
    .select("id")
    .eq("organization_slug", organization)
    .eq("team_name", teamName)
    .maybeSingle();
  if (masterError) throw new TeamHalfWriteError(500, masterError.message);
  const teamId = (masterData as { id: string } | null)?.id ?? null;

  const maxOrder = existing.reduce((m, r) => Math.max(m, r.display_order), 0);

  let teamHalfId: string;
  if (sameName && !sameName.is_active) {
    // 비활성 동명 팀 → 재활성 + 갱신.
    const { error } = await supabaseAdmin
      .from("cluster4_team_halves")
      .update({
        is_active: true,
        display_order: maxOrder + 1,
        description,
        leader_user_id: leaderUserId,
        leader_crew_code: leaderCrewCode,
        team_id: teamId,
      })
      .eq("id", sameName.id);
    if (error) throw new TeamHalfWriteError(500, error.message);
    teamHalfId = sameName.id;
  } else {
    const { data: inserted, error } = await supabaseAdmin
      .from("cluster4_team_halves")
      .insert({
        organization_slug: organization,
        half_key: halfKey,
        team_name: teamName,
        display_order: maxOrder + 1,
        is_active: true,
        description,
        leader_user_id: leaderUserId,
        leader_crew_code: leaderCrewCode,
        team_id: teamId,
      })
      .select("id")
      .single();
    if (error) throw new TeamHalfWriteError(500, error.message);
    teamHalfId = (inserted as { id: string }).id;
  }

  // 산하 "일반" 파트 자동 보장(idempotent) — 팀장 = 기본 파트장. 같은 흐름에서 함께 보장.
  await ensureGeneralPart(teamHalfId, leaderUserId);

  return { teams: await listHalfTeams(organization, halfKey) };
}

// 팀의 "일반" 파트를 보장한다(없으면 생성). UNIQUE(team_half_id, part_name) 로 중복 불가.
//   기본 파트장 = 팀장. 이미 있으면 미변경(idempotent). 삭제는 앱 레이어에서 금지.
export async function ensureGeneralPart(
  teamHalfId: string,
  leaderUserId: string | null,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("cluster4_team_parts")
    .upsert(
      {
        team_half_id: teamHalfId,
        part_name: DEFAULT_PART_NAME,
        is_default: true,
        leader_user_id: leaderUserId,
        display_order: 0,
      },
      { onConflict: "team_half_id,part_name", ignoreDuplicates: true },
    );
  if (error) throw new TeamHalfWriteError(500, error.message);
}

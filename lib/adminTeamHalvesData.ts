import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
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
import { classLabel, memberStatusLabel } from "@/lib/adminMembersTypes";
import { isOrganizationSlug, ORGANIZATIONS, type OrganizationSlug } from "@/lib/organizations";
import { loadSeasonWeeks } from "@/lib/adminSeasonWeeksData";
import {
  isTestTeam,
  resolveEffectiveScopeMode,
} from "@/lib/cluster4ExperienceTestScope";
import type { ScopeMode } from "@/lib/userScopeShared";
import { resolveUserScope } from "@/lib/userScope";
import { SUPER_ADMIN_EXCLUDE_OR } from "@/lib/superAdmins";

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

// 팀별 "현재 시점" 크루 수(클러빙/정규/심화). ⚠ selectedHalf 무관 — team_name 기준 is_current 멤버십.
//   · 클러빙 = 정규 + 심화(팀장·앰배서더·관리자 제외 = 크루만). 개인 휴식(membership_state='rest') 포함.
//   · userId 고유(한 사람 = is_current 멤버십 1개 → 1팀 → 1회). 클럽 요약(buildClubRoleCounts)과 동일 라벨 SoT.
export type TeamCurrentCrewSummaryDto = {
  clubbingCount: number;
  regularCrewCount: number;
  advancedCrewCount: number;
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
  // 현재 시점 크루 수(팀명 기준·selectedHalf 무관). loadTeamPartsInfo(GET) 에서만 채움(POST 응답은 미포함).
  currentCrew?: TeamCurrentCrewSummaryDto;
  // 스코프 SoT — true=테스트(QA) 팀, false=운영 팀(생성 시 effective mode 각인). 목록 필터 기준.
  isQaTest: boolean;
};

// 한 클럽(조직)당 한 반기 최대 팀 수. 백엔드 강제 검증의 SoT.
export const MAX_TEAMS_PER_CLUB = 10;

export const MAX_TEAM_NAME_LENGTH = 12;
export const MAX_TEAM_DESCRIPTION_LENGTH = 200;

// 팀당 "사용자 생성 파트" 최대 개수(신규 정책 — 이전 정책/DB 제약 없음). 시스템 기본 파트 "일반"(is_default)은
//   이 한도에 포함하지 않는다(생성·삭제 불가·항상 존재). ∴ catalog 최대 = 일반 1 + 생성 6 = 7행.
export const MAX_CREATED_PARTS = 6;
export const MAX_PART_NAME_LENGTH = 12;

export type HalfOptionDto = {
  halfKey: string;
  label: string;
  lastSeasonKey: string | null;
  isCurrent: boolean;
  editable: boolean;
};

// 상단 요약 영역 — 현재 접속 시점(Asia/Seoul) 기준 현황. **selectedHalfKey 와 무관**하다.
//   · currentDate/currentWeek = 프로젝트 공통 시즌·주차 판정(loadSeasonWeeks, is_current_week) 재사용.
//   · counts = 현재 반기(resolveCurrentHalfKey) × 전 조직(ORGANIZATIONS) × 현재 모드 스코프.
//     렌더된 행이 아니라 원천 테이블을 ID 기준으로 직접 집계한다(중복 없음).
//   · mode/org 분기 없음 — 일반/test/actAs/demo 모든 경로가 이 동일 DTO·동일 함수를 쓴다.
export type TeamPartsInfoSummaryDto = {
  currentDate: string; // "2026년 7월 17일(금)"
  currentWeek: {
    year: number; // 2026
    seasonName: string; // "여름"
    weekNumber: number | null; // 3 (전환 주차 = 0)
    label: string; // "[26년, 여름 시즌, 3주차]"
  } | null;
  counts: {
    totalClubs: number; // 현재 반기 유효 팀 ≥1 인 조직 수(전 조직 기준)
    totalTeams: number; // 현재 반기 전 조직 활성 팀 총합(팀 half id 기준·중복 없음)
    totalParts: number; // 현재 시점 소속 멤버 ≥1 인 활성 파트 총합(팀별 점유 파트 합·멤버 0 파트 제외)
  };
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
  // 현재 접속 시점 요약(선택 반기 무관). 모든 org 응답에서 동일 값(전 조직·현재 반기 기준).
  summary: TeamPartsInfoSummaryDto;
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

// 스코프 컬럼(is_qa_test) 없이 조회하던 기본 컬럼 셋.
const TEAM_HALF_BASE_COLS =
  "id,team_name,team_id,display_order,is_active,description,leader_user_id,leader_crew_code,leader_name";

// is_qa_test 컬럼 존재 여부 캐시 — true(=컬럼 있음)로 확정되면 유지(컬럼은 사라지지 않음).
//   false 는 캐시하지 않는다 → 마이그레이션(수동) 적용 직후 재시작 없이 즉시 감지.
let scopeColumnPresent = false;
async function hasScopeColumn(): Promise<boolean> {
  if (scopeColumnPresent) return true;
  const { error } = await supabaseAdmin
    .from("cluster4_team_halves")
    .select("is_qa_test")
    .limit(1);
  const present = !(error && (error as { code?: string }).code === "42703");
  if (present) scopeColumnPresent = true;
  return present;
}

export type HalfRow = Row & { is_qa_test: boolean };

// 반기 팀 행 로더(스코프 각인 포함).
//   · 컬럼 존재 → 저장된 is_qa_test.
//   · 컬럼 부재(마이그 전) → 이름 레지스트리(isTestTeam)로 파생 폴백(무회귀 · 앱 미중단).
export async function loadHalfRows(
  organization: string,
  halfKey: string,
  opts: { activeOnly?: boolean } = {},
): Promise<HalfRow[]> {
  const withScope = await hasScopeColumn();
  const cols = withScope ? `${TEAM_HALF_BASE_COLS},is_qa_test` : TEAM_HALF_BASE_COLS;
  let q = supabaseAdmin
    .from("cluster4_team_halves")
    .select(cols)
    .eq("organization_slug", organization)
    .eq("half_key", halfKey);
  if (opts.activeOnly) q = q.eq("is_active", true);
  const { data, error } = await q.order("display_order", { ascending: true });
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as Array<Row & { is_qa_test?: boolean }>).map((r) => ({
    ...r,
    is_qa_test: withScope ? Boolean(r.is_qa_test) : isTestTeam(organization, r.team_name),
  }));
}

// 쓰기 스코프 가드(fail-closed) — 저장된 스코프가 현재 실효 모드와 일치해야 한다.
//   test 모드는 테스트 팀만, operating 모드는 운영 팀만 수정/삭제 가능(운영↔테스트 교차 차단).
//   ⚠ 신규 등록에는 쓰지 않는다(신규는 저장된 스코프가 없어 effective mode 로 각인).
function assertStoredTeamScope(isQaTest: boolean, mode: ScopeMode): void {
  if (isQaTest !== (mode === "test")) {
    throw new TeamHalfWriteError(
      422,
      "대상 팀이 현재 모드 스코프에 속하지 않습니다. QA 모드에서는 테스트 팀만, 운영 모드에서는 운영 팀만 수정·삭제할 수 있습니다.",
    );
  }
}

// 오늘이 속한 시즌 → 그 시즌의 반기. 미일치 시 today 이전 시작 시즌 중 최신으로 폴백.
export async function resolveCurrentHalfKey(
  today?: string,
): Promise<string | null> {
  const todayIso = today ?? getCurrentActivityDateIso();

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
//   [B] 크루 편집표도 이 배치를 재사용(프로필·품계). ⚠ classLabel 은 현재 membership 클래스라 [B] 의
//     "주차별 클래스"(effective positionCode)와 다른 개념 — [B] 는 gradeLabel 등 프로필만 쓴다.
export type LeaderBasic = {
  name: string | null;
  org: string | null; // 연결 크루의 organization_slug — 팀 org 와 다르면 상세 미노출(조직 강제).
  birth6: string | null;
  gender: string | null;
  residence: string | null;
  school: string | null;
  major: string | null;
  classLabel: string | null;
  gradeLabel: string | null;
  gradeRank: number | null; // 품계 숫자 등급(1=정승 최상위 … 10=정9품). 문자열 라벨 정렬 오류 방지용.
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

export async function getLeaderBasicsBatch(
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
      gradeRank: grade?.grade ?? null,
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
  const rows = await loadHalfRows(organization, halfKey, { activeOnly: true });

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
      isQaTest: r.is_qa_test,
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

// 현재 팀·파트 배정(user_memberships) — 팀별 점유 파트 집합(org 매칭·is_current·비휴식).
//   진행 중 반기의 미확정 주차 폴백 SoT(사용자 화면과 동일 원천). 현재 멤버가 없는 팀은 미포함
//   (빈 팀 false-fill 방지).
//   ⚠ part_name = null/빈문자 = "파트 미배정"(팀장 정책) — "일반"으로 변환하지 않고 제외한다.
//     따라서 팀장은 어떤 파트 셀/인원에도 포함되지 않는다(팀 전체 인원엔 별도 경로로 포함).
//     실제 저장값이 "일반"인 사용자만 "일반" 파트로 집계된다.
async function currentMembershipPartsByTeam(
  organization: string,
  teamNames: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (teamNames.length === 0) return out;
  const { data: mems, error } = await supabaseAdmin
    .from("user_memberships")
    .select("user_id,team_name,part_name,is_current,membership_state")
    .in("team_name", teamNames)
    .eq("is_current", true);
  if (error) throw new Error(error.message);
  const rows = ((mems ?? []) as Array<{
    user_id: string;
    team_name: string | null;
    part_name: string | null;
    membership_state: string | null;
  }>).filter((m) => m.membership_state !== "rest");
  const uids = Array.from(new Set(rows.map((r) => r.user_id)));
  const orgByUser = new Map<string, string | null>();
  if (uids.length > 0) {
    const { data: profs, error: pErr } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id,organization_slug")
      .in("user_id", uids);
    if (pErr) throw new Error(pErr.message);
    for (const p of (profs ?? []) as Array<{ user_id: string; organization_slug: string | null }>)
      orgByUser.set(p.user_id, p.organization_slug);
  }
  for (const r of rows) {
    if (orgByUser.get(r.user_id) !== organization) continue;
    if (!r.team_name) continue;
    const part = (r.part_name ?? "").trim();
    if (!part) continue; // 파트 미배정(팀장) — 일반 변환 없이 제외.
    const list = out.get(r.team_name) ?? [];
    if (!list.includes(part)) list.push(part);
    out.set(r.team_name, list);
  }
  return out;
}

// 팀별 "현재 시점" 크루 수(클러빙/정규/심화) — team_name 기준. 클럽 요약(buildClubRoleCounts)과 동일
//   원천·스코프·라벨 SoT 를 팀 단위로 좁힌 것. 개인 휴식 포함, userId 고유.
//   조인: user_profiles(org·super 제외)∩resolveUserScope(mode) → user_memberships(is_current)
//        .team_name ∈ teamNames → memberStatusLabel(role, membership_level) 버킷팅.
//   ⚠ 팀장/앰배서더/관리자는 크루가 아니므로 클러빙에서 제외한다(정규·심화만 = 크루).
async function loadTeamCurrentCrewByName(
  organization: OrganizationSlug,
  teamNames: string[],
  mode: ScopeMode,
): Promise<Map<string, TeamCurrentCrewSummaryDto>> {
  const out = new Map<string, TeamCurrentCrewSummaryDto>();
  for (const tn of teamNames)
    out.set(tn, { clubbingCount: 0, regularCrewCount: 0, advancedCrewCount: 0 });
  if (teamNames.length === 0) return out;

  // 1) org 로스터(super_admin 제외) ∩ 모집단 스코프. role 은 라벨링에 사용.
  const { data: profs, error: pErr } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,role")
    .eq("organization_slug", organization)
    .or(SUPER_ADMIN_EXCLUDE_OR);
  if (pErr) throw new Error(pErr.message);
  const scope = await resolveUserScope(mode, null);
  const roleByUser = new Map<string, string | null>();
  for (const p of (profs ?? []) as Array<{ user_id: string; role: string | null }>) {
    if (scope.includes(p.user_id)) roleByUser.set(p.user_id, p.role);
  }
  const uids = [...roleByUser.keys()];
  if (uids.length === 0) return out;

  // 2) is_current 멤버십(team_name + membership_level). 개인 휴식(membership_state) 무관 → 포함.
  const teamNameSet = new Set(teamNames);
  const seen = new Set<string>(); // userId 고유 가드(is_current 는 사용자당 1행이지만 방어적).
  for (let i = 0; i < uids.length; i += 100) {
    const chunk = uids.slice(i, i + 100);
    const { data: mems, error: mErr } = await supabaseAdmin
      .from("user_memberships")
      .select("user_id,team_name,membership_level,is_current")
      .in("user_id", chunk)
      .eq("is_current", true);
    if (mErr) throw new Error(mErr.message);
    for (const m of (mems ?? []) as Array<{
      user_id: string;
      team_name: string | null;
      membership_level: string | null;
    }>) {
      if (seen.has(m.user_id)) continue;
      const tn = m.team_name?.trim();
      if (!tn || !teamNameSet.has(tn)) continue;
      const label = memberStatusLabel(
        roleByUser.get(m.user_id) ?? null,
        m.membership_level ?? null,
      );
      const bucket = out.get(tn);
      if (!bucket) continue;
      if (label === "일반" || label === "크루") {
        bucket.regularCrewCount++;
        bucket.clubbingCount++;
        seen.add(m.user_id);
      } else if (label === "심화(파트장)" || label === "심화(에이전트)") {
        bucket.advancedCrewCount++;
        bucket.clubbingCount++;
        seen.add(m.user_id);
      }
      // 팀장/앰배서더/관리자 = 운영진/미집계(크루 아님) → 클러빙 제외.
    }
  }
  return out;
}

async function computePartWeekData(
  organization: string,
  halfKey: string,
  teams: Array<{ teamHalfId: string; teamName: string }>,
  // 진행 중 반기(=현재 반기)일 때만 true. UPH 없는 "진행 대상(경과) 주차"에 한해
  //   현재 팀·파트 배정(user_memberships)으로 셀을 폴백한다(UPH·과거 반기는 불변).
  applyMembershipFallback = false,
  todayIso?: string,
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

  // 4b) 진행 중 반기 폴백 — UPH가 없는 "진행 대상(경과) 주차"에 한해 현재 팀·파트 배정
  //     (user_memberships, 사용자 화면과 동일 SoT)으로 셀을 채운다.
  //     · UPH가 있는 주차는 항상 UPH 우선(그 주차는 폴백 제외).
  //     · 시작일 > 오늘(미래·미도래) 주차는 채우지 않음(전체 무조건 채움 금지).
  //     · 현재 멤버 없는 팀은 폴백 없음. mode/org 분기 없음·user_week_statuses 미생성.
  if (applyMembershipFallback) {
    const cutoff = todayIso ?? getCurrentActivityDateIso();
    const memberParts = await currentMembershipPartsByTeam(
      organization,
      teams.map((t) => t.teamName),
    );
    for (const t of teams) {
      const parts = memberParts.get(t.teamName);
      if (!parts || parts.length === 0) continue;
      const pm = presence.get(t.teamName) ?? new Map<string, Set<number>>();
      // 이 팀에 UPH가 이미 있는 주차 = UPH 우선(폴백 제외).
      const uphWeeks = new Set<number>();
      for (const s of pm.values()) for (const wi of s) uphWeeks.add(wi);
      // 진행 대상 주차 = 시작일 <= 오늘 && UPH 미보유.
      const elapsed = weekColumns
        .map((c, wi) => ({ start: c.weekStartDate, wi }))
        .filter(({ start, wi }) => start <= cutoff && !uphWeeks.has(wi))
        .map(({ wi }) => wi);
      if (elapsed.length === 0) continue;
      const fm = firstSeen.get(t.teamName) ?? new Map<string, number>();
      const minWi = Math.min(...elapsed);
      for (const part of parts) {
        const set = pm.get(part) ?? new Set<number>();
        for (const wi of elapsed) set.add(wi);
        pm.set(part, set);
        if (!fm.has(part) || minWi < (fm.get(part) ?? Infinity)) fm.set(part, minWi);
      }
      presence.set(t.teamName, pm);
      firstSeen.set(t.teamName, fm);
    }
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

// ── 상단 요약(현재 접속 시점 현황) ────────────────────────────────────
// 표시 문구 형식 = "오늘은, 2026년 7월 17일(금)이고, [26년, 여름 시즌, 3주차] 입니다."
//   currentDate 부분("YYYY년 M월 D일(요일)")과 currentWeek.label("[YY년, 시즌명 시즌, N주차]").
const KOREAN_WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

// date-only ISO(YYYY-MM-DD)를 "YYYY년 M월 D일(요일)" 로. 날짜/요일 계산 = UTC 절단(주차 라벨
//   formatTodayLabel 과 동일 규칙) — 입력 날짜 자체는 getCurrentActivityDateIso(Asia/Seoul 00:01 경계)로 이미 확정된다.
function formatKoreanFullDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const weekday = KOREAN_WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  return `${y}년 ${mo}월 ${d}일(${weekday})`;
}

// 현재 접속 시점 요약 — 날짜·주차 + 전체 클럽/팀/파트 수. **selectedHalfKey 와 무관**하게
//   항상 현재 시점 기준(현재 반기·현재 주차)으로 계산한다.
//   · 현재 주차 = 프로젝트 공통 SoT(loadSeasonWeeks: season_definitions + weeks + official_rest_periods,
//     is_current_week). 별도 날짜·시즌·주차 계산 로직을 새로 만들지 않는다.
//   · counts = 현재 반기(resolveCurrentHalfKey) × 전 조직(ORGANIZATIONS) × 현재 모드 스코프(is_qa_test).
//     페이지 목록/검색/페이지네이션과 무관하게 원천 테이블을 ID 기준으로 직접 집계한다.
//   · mode 는 팀 스코프 필터에만 관여(운영=운영팀·test=테스트팀) — 목록과 동일한 wantQaTest 규칙.
// 현재 접속 시점의 날짜·주차 정보(전역·selectedHalf 무관). 상단 요약·클럽 목록이 공유하는 단일 SoT.
export async function resolveCurrentWeekInfo(
  today?: string,
): Promise<Pick<TeamPartsInfoSummaryDto, "currentDate" | "currentWeek">> {
  const todayIso = today ?? getCurrentActivityDateIso();
  // 공통 로더의 is_current_week 행(전역). 전환 주차 재귀속(다음 시즌 W0) 포함.
  const { rows } = await loadSeasonWeeks(today);
  const currentRow = rows.find((r) => r.is_current_week) ?? null;
  let currentWeek: TeamPartsInfoSummaryDto["currentWeek"] = null;
  if (currentRow) {
    const yearIso =
      currentRow.week_end_date ??
      currentRow.week_start_date ??
      currentRow.season_start_date ??
      todayIso;
    const year = Number(String(yearIso).slice(0, 4));
    const yy = String(((year % 100) + 100) % 100).padStart(2, "0");
    const seasonName = seasonKeyToSeasonLabel(currentRow.season_key);
    const weekNumber = currentRow.week_number;
    currentWeek = {
      year: Number.isFinite(year) ? year : 0,
      seasonName,
      weekNumber,
      label: `[${yy}년, ${seasonName} 시즌, ${weekNumber ?? "-"}주차]`,
    };
  }
  return { currentDate: formatKoreanFullDate(todayIso), currentWeek };
}

// 현재 접속 시점의 조직 "구조" 숫자(팀 entity·파트) — **상단 요약과 클럽 목록 표의 단일 SoT**.
//   ⚠ 상단 '전체 팀 수/전체 파트 수'와 하단 표의 클럽별 실제 팀 수/파트 수는 반드시 이 함수에서 파생한다
//     → SUM(perOrg.partCount) === totals.totalParts 가 항상 성립(별도 재집계 금지).
//   · teamEntityCount = 현재 반기 활성·스코프 팀(entity) 수(사람 아님).
//   · partCount = "현재 소속 멤버 ≥1 인 활성 파트" 수(팀별 dedup 합). 카탈로그 레코드 수 아님(멤버 0 제외).
//   · mode/org 분기 없음 — operating/test/actAs/demo 동일 경로(스코프만 반영).
export type CurrentClubStructureRow = {
  orgSlug: OrganizationSlug;
  teamEntityCount: number;
  partCount: number;
};
export type CurrentClubStructure = {
  currentHalfKey: string | null;
  perOrg: CurrentClubStructureRow[];
  totals: { totalClubs: number; totalTeams: number; totalParts: number };
};

export async function loadCurrentClubStructure(
  mode: ScopeMode = "operating",
  today?: string,
): Promise<CurrentClubStructure> {
  const currentHalfKey = await resolveCurrentHalfKey(today);
  const perOrg: CurrentClubStructureRow[] = [];
  const totals = { totalClubs: 0, totalTeams: 0, totalParts: 0 };

  if (!currentHalfKey) {
    for (const org of ORGANIZATIONS)
      perOrg.push({ orgSlug: org, teamEntityCount: 0, partCount: 0 });
    return { currentHalfKey, perOrg, totals };
  }

  const wantQaTest = resolveEffectiveScopeMode(mode) === "test";
  const results = await Promise.all(
    [...ORGANIZATIONS].map(async (org) => {
      // 현재 반기 활성 + 스코프(is_qa_test) 팀.
      const scoped = (
        await loadHalfRows(org, currentHalfKey, { activeOnly: true })
      ).filter((r) => r.is_qa_test === wantQaTest);
      // 현재 시점 점유 파트 SoT = user_memberships(is_current·비휴식·org 매칭)·part_name 비어있지 않음.
      const occupied = await currentMembershipPartsByTeam(
        org,
        scoped.map((r) => r.team_name),
      );
      let partCount = 0;
      for (const r of scoped) partCount += (occupied.get(r.team_name) ?? []).length;
      return { orgSlug: org, teamEntityCount: scoped.length, partCount };
    }),
  );

  for (const r of results) {
    perOrg.push(r);
    if (r.teamEntityCount > 0) totals.totalClubs += 1;
    totals.totalTeams += r.teamEntityCount;
    totals.totalParts += r.partCount;
  }
  return { currentHalfKey, perOrg, totals };
}

export async function loadTeamPartsCurrentSummary(
  mode: ScopeMode = "operating",
  today?: string,
): Promise<TeamPartsInfoSummaryDto> {
  // 날짜·주차 + 구조 숫자를 각각 단일 SoT 함수에서 파생(클럽 목록 표와 완전 동일 원천).
  const [week, structure] = await Promise.all([
    resolveCurrentWeekInfo(today),
    loadCurrentClubStructure(mode, today),
  ]);
  return {
    currentDate: week.currentDate,
    currentWeek: week.currentWeek,
    counts: structure.totals,
  };
}

// 페이지 1회 로드: 현재 반기 + 반기 옵션 + 선택 반기 팀.
//   selectedHalfKey 미지정 → 현재 반기, 현재가 데이터에 없으면 최신 반기.
export async function loadTeamPartsInfo(
  organization: string,
  selectedHalfKey?: string | null,
  today?: string,
  // 운영(operating·기본)/QA(test) 팀 분기. operating=(T) 테스트팀 제외 / test=(T) 테스트팀만.
  //   ⚠ 종전엔 mode 분기 없이 전 팀을 노출 → ?mode=test 에도 운영 팀이 섞여 보였다(QA 누수).
  mode: ScopeMode = "operating",
): Promise<TeamPartsInfoDto> {
  const currentHalfKey = await resolveCurrentHalfKey(today);
  const todayIso = today ?? getCurrentActivityDateIso();
  const halves = await listAvailableHalves(organization, currentHalfKey);

  // 선택 반기: 유효한 반기 키면 그대로 조회한다(해당 시기 드롭다운의 고정 옵션 중 데이터가 없는
  //   과거/미래 반기도 빈 목록으로 조회 — 현재 반기로 폴백하지 않는다). 미지정/무효일 때만 현재 반기.
  let selected: string | null = null;
  if (selectedHalfKey && isHalfKey(selectedHalfKey)) {
    selected = selectedHalfKey;
  } else if (currentHalfKey) {
    selected = currentHalfKey;
  } else if (halves.length > 0) {
    selected = halves[0].halfKey;
  }
  // 선택 반기가 옵션 목록에 없으면 추가해 응답을 자기완결적으로 유지(editable=isEditableHalf SoT).
  if (selected && !halves.some((h) => h.halfKey === selected)) {
    halves.push({
      halfKey: selected,
      label: halfLabel(selected),
      lastSeasonKey: halfKeyToLastSeasonKey(selected),
      isCurrent: selected === currentHalfKey,
      editable: isEditableHalf(selected, currentHalfKey),
    });
    halves.sort((a, b) => compareHalfKeyDesc(a.halfKey, b.halfKey));
  }

  // 팀 목록 스코프 — 저장된 is_qa_test(스코프 SoT) == 실효 모드. 팀명/(T) 규칙이 아니라 각인된 스코프로
  //   필터한다(DB 직삽입 팀도 조건 맞으면 노출). 매트릭스 계산 전에 적용해 존재표/파트수도 통일.
  const wantQaTest = resolveEffectiveScopeMode(mode) === "test";
  const teams = selected
    ? (await listHalfTeams(organization, selected)).filter((t) => t.isQaTest === wantQaTest)
    : [];
  const editable = selected != null && isEditableHalf(selected, currentHalfKey);

  // 파트×주차 존재표(선택 반기). 팀별 matrix 를 teams 에 병합 + x축 weekColumns.
  let weekColumns: PartWeekColumnDto[] = [];
  // 진행 중 반기(=현재 반기)에서만 미확정 주차를 현재 배정으로 폴백한다(과거 반기 불변).
  const applyMembershipFallback = selected != null && selected === currentHalfKey;
  if (selected && teams.length > 0) {
    const { weekColumns: cols, byTeam } = await computePartWeekData(
      organization,
      selected,
      teams.map((t) => ({ teamHalfId: t.teamHalfId, teamName: t.teamName })),
      applyMembershipFallback,
      todayIso,
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

  // 상단 요약 — 현재 접속 시점 기준(선택 반기와 무관). mode 스코프만 전파(운영/test 동일 함수).
  //   모든 org 응답이 동일 값을 담으므로 프론트는 base(첫 결과)만 읽어도 전 조직 현황을 얻는다.
  const summary = await loadTeamPartsCurrentSummary(mode, today);

  // 팀별 현재 시점 크루 수(클러빙/정규/심화) — team_name 기준·selectedHalf 무관. 클럽 상세 카드 + 팀 상세 공용.
  if (teams.length > 0 && isOrganizationSlug(organization)) {
    const crewByName = await loadTeamCurrentCrewByName(
      organization,
      teams.map((t) => t.teamName),
      mode,
    );
    for (const t of teams) {
      t.currentCrew =
        crewByName.get(t.teamName) ?? {
          clubbingCount: 0,
          regularCrewCount: 0,
          advancedCrewCount: 0,
        };
    }
  }

  return {
    organization,
    currentHalfKey,
    selectedHalfKey: selected,
    editable,
    halves,
    teams,
    weekColumns,
    summary,
  };
}

// 팀(team_half_id)의 파트 카탈로그(cluster4_team_parts) — 생성 순서. is_default("일반") 구분 포함.
//   생성 파트 목록(비-일반) + 파트 생성 중복/한도 검증의 원천.
async function loadTeamPartCatalog(
  teamHalfId: string,
): Promise<Array<{ partName: string; isDefault: boolean; displayOrder: number }>> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_team_parts")
    .select("part_name,is_default,display_order")
    .eq("team_half_id", teamHalfId);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{
    part_name: string;
    is_default: boolean | null;
    display_order: number | null;
  }>)
    .map((r) => ({ partName: r.part_name, isDefault: Boolean(r.is_default), displayOrder: r.display_order ?? 0 }))
    .sort((a, b) => a.displayOrder - b.displayOrder);
}

// 현재(is_current_week) 주차의 시작일(YYYY-MM-DD) — 매트릭스 "현재 주차 운용 행" 강조 판정용(없으면 null).
async function resolveCurrentWeekStartDate(today?: string): Promise<string | null> {
  const { rows } = await loadSeasonWeeks(today);
  const cur = rows.find((r) => r.is_current_week);
  const d = cur?.week_start_date ?? null;
  return d ? String(d).slice(0, 10) : null;
}

// ── 팀 상세(클럽 상세 → 팀 상세) ────────────────────────────────────────────
//   anchorTeamHalfId(=클럽 상세 카드가 넘긴 cluster4_team_halves.id)로 팀(org+team_name)을 확정한다.
//   두 시점 기준을 분리해 담는다:
//     · 현재 접속 시점(현재 반기): 날짜/주차·팀 기본정보·팀장·크루 수·생성 파트 목록·운용 파트 수.
//     · 선택 반기: 파트×주차 존재표(selectedTeam.partWeekMatrix + weekColumns). 반기 select 만 이걸 바꾼다.
//   404(호출부에서 null 처리): 미존재 id / 타 org / 비활성(삭제 대기) / 스코프(QA) 불일치.
export type TeamDetailDto = {
  organization: string;
  teamName: string;
  currentHalfKey: string | null;
  selectedHalfKey: string | null;
  editable: boolean; // 선택 반기 편집 가능 여부(현재/다음 반기).
  halves: HalfOptionDto[];
  // ── 현재 접속 시점(현재 반기 기준·selectedHalf 무관) ──
  currentDate: string; // "2026년 7월 21일(화)"
  currentWeek: TeamPartsInfoSummaryDto["currentWeek"];
  currentWeekStartDate: string | null; // 매트릭스 현재 주차 강조용
  team: TeamHalfTeamDto | null; // 현재 반기 팀(기본정보·팀장). 현재 반기에 없으면 null.
  currentCrew: TeamCurrentCrewSummaryDto; // 클러빙/정규/심화(휴식 포함·userId 고유)
  generatedParts: string[]; // 생성 파트(현재 반기 catalog 비-일반). "일반"은 제외(시스템 기본).
  operatedPartCount: number; // 운용 파트 수 = 현재 배정 크루≥1 인 비-일반 파트 고유 수
  maxCreatedParts: number; // 6 (생성 파트 한도, "일반" 미포함)
  // ── 선택 반기(파트×주차 존재표) ──
  selectedTeam: TeamHalfTeamDto | null; // 선택 반기 팀(partWeekMatrix 보유). 그 반기에 없으면 null.
  weekColumns: PartWeekColumnDto[];
};

// 앵커 teamHalfId → team_name 확정(org·활성·스코프 검증). 어긋나면 null(=404). 팀 상세·주차 요약 공용 SoT.
export async function resolveTeamAnchorName(
  organization: OrganizationSlug,
  anchorTeamHalfId: string,
  mode: ScopeMode = "operating",
): Promise<string | null> {
  const withScope = await hasScopeColumn();
  const cols = withScope
    ? `${TEAM_HALF_BASE_COLS},is_qa_test,organization_slug`
    : `${TEAM_HALF_BASE_COLS},organization_slug`;
  const { data, error } = await supabaseAdmin
    .from("cluster4_team_halves")
    .select(cols)
    .eq("id", anchorTeamHalfId)
    .limit(1);
  if (error) throw new Error(error.message);
  const anchor = ((data ?? []) as unknown as Array<
    Row & { organization_slug: string; is_qa_test?: boolean }
  >)[0];
  if (!anchor) return null; // 존재하지 않는 teamHalfId
  if (anchor.organization_slug !== organization) return null; // 해당 클럽 소속 아님(URL org 불일치)
  if (!anchor.is_active) return null; // 삭제 대기/비활성
  const isQa = withScope
    ? Boolean(anchor.is_qa_test)
    : isTestTeam(organization, anchor.team_name);
  if (isQa !== (resolveEffectiveScopeMode(mode) === "test")) return null; // 스코프(QA) 불일치
  return anchor.team_name;
}

export async function loadTeamDetail(opts: {
  organization: OrganizationSlug;
  anchorTeamHalfId: string;
  selectedHalfKey?: string | null;
  mode?: ScopeMode;
  today?: string;
}): Promise<TeamDetailDto | null> {
  const { organization, anchorTeamHalfId, today } = opts;
  const mode = opts.mode ?? "operating";

  // 1) 앵커 팀 확정 — id → team_name(org·활성·스코프 검증). 하나라도 어긋나면 null(=404).
  const teamName = await resolveTeamAnchorName(organization, anchorTeamHalfId, mode);
  if (!teamName) return null;

  // 2) 현재 접속 시점 기준 — 현재 반기 정보 + 날짜/주차 + 현재 배정 파트 점유.
  const [currentInfo, week, currentWeekStartDate, occupiedByTeam] = await Promise.all([
    loadTeamPartsInfo(organization, null, today, mode), // half 미지정 → 현재 반기
    resolveCurrentWeekInfo(today),
    resolveCurrentWeekStartDate(today),
    currentMembershipPartsByTeam(organization, [teamName]),
  ]);
  const currentTeam = currentInfo.teams.find((t) => t.teamName === teamName) ?? null;

  // 3) 선택 반기 — 현재와 같으면 재사용, 다르면 별도 로드(매트릭스만 이걸 사용).
  const selectedKey =
    opts.selectedHalfKey && isHalfKey(opts.selectedHalfKey) ? opts.selectedHalfKey : null;
  const selectedInfo =
    selectedKey && selectedKey !== currentInfo.selectedHalfKey
      ? await loadTeamPartsInfo(organization, selectedKey, today, mode)
      : currentInfo;
  const selectedTeam = selectedInfo.teams.find((t) => t.teamName === teamName) ?? null;

  // 4) 생성 파트(현재 반기 catalog 비-일반) + 운용 파트 수(현재 배정 비-일반 고유).
  const generatedParts = currentTeam
    ? (await loadTeamPartCatalog(currentTeam.teamHalfId))
        .filter((p) => !p.isDefault)
        .map((p) => p.partName)
    : [];
  const operatedPartCount = new Set(
    (occupiedByTeam.get(teamName) ?? []).filter((p) => p !== DEFAULT_PART_NAME),
  ).size;

  const currentCrew =
    currentTeam?.currentCrew ??
    (await loadTeamCurrentCrewByName(organization, [teamName], mode)).get(teamName) ?? {
      clubbingCount: 0,
      regularCrewCount: 0,
      advancedCrewCount: 0,
    };

  return {
    organization,
    teamName,
    currentHalfKey: currentInfo.currentHalfKey,
    selectedHalfKey: selectedInfo.selectedHalfKey,
    editable: selectedInfo.editable,
    halves: selectedInfo.halves,
    currentDate: week.currentDate,
    currentWeek: week.currentWeek,
    currentWeekStartDate,
    team: currentTeam,
    currentCrew,
    generatedParts,
    operatedPartCount,
    maxCreatedParts: MAX_CREATED_PARTS,
    selectedTeam,
    weekColumns: selectedInfo.weekColumns,
  };
}

// ── 파트 생성 ────────────────────────────────────────────────────────────
//   현재 반기 팀(team_name)에 사용자 생성 파트를 추가한다. "일반"은 시스템 기본이라 별도.
//   검증: org 접근(호출부 guard)·팀 존재/활성/스코프·현재 반기 편집 가능·이름(trim/빈값/길이/중복)·한도(6).
//   새 파트는 크루 0명(운용 파트 아님) — 카탈로그 레코드만 추가한다(배정/파트장/운용 수 무변경).
export async function createTeamPart(opts: {
  organization: OrganizationSlug;
  anchorTeamHalfId: string;
  name: string;
  mode?: ScopeMode;
  today?: string;
}): Promise<{ partName: string }> {
  const { organization, anchorTeamHalfId, today } = opts;
  const mode = opts.mode ?? "operating";
  const name = (opts.name ?? "").trim();

  if (name.length === 0) throw new TeamHalfWriteError(400, "파트명을 입력하세요.");
  if (name.length > MAX_PART_NAME_LENGTH)
    throw new TeamHalfWriteError(400, `파트명은 최대 ${MAX_PART_NAME_LENGTH}자까지 가능합니다.`);
  if (name === DEFAULT_PART_NAME)
    throw new TeamHalfWriteError(422, `"${DEFAULT_PART_NAME}"은 시스템 기본 파트라 생성할 수 없습니다.`);

  // 앵커 → team_name 확정(loadTeamDetail 과 동일 검증).
  const detail = await loadTeamDetail({ organization, anchorTeamHalfId, mode, today });
  if (!detail) throw new TeamHalfWriteError(404, "팀을 찾을 수 없습니다.");
  const currentTeam = detail.team;
  if (!currentTeam) throw new TeamHalfWriteError(422, "현재 반기에 이 팀이 없어 파트를 생성할 수 없습니다.");
  if (!detail.editable) throw new TeamHalfWriteError(403, "현재·다음 반기에서만 파트를 생성할 수 있습니다.");

  // 중복·한도(비-일반 생성 파트 기준) 검증.
  const catalog = await loadTeamPartCatalog(currentTeam.teamHalfId);
  if (catalog.some((p) => p.partName === name))
    throw new TeamHalfWriteError(409, "이미 같은 이름의 파트가 있습니다.");
  const createdCount = catalog.filter((p) => !p.isDefault).length;
  if (createdCount >= MAX_CREATED_PARTS)
    throw new TeamHalfWriteError(422, `생성 파트는 팀당 최대 ${MAX_CREATED_PARTS}개까지입니다.`);

  const nextOrder =
    catalog.reduce((mx, p) => Math.max(mx, p.displayOrder), 0) + 1;
  const { error } = await supabaseAdmin.from("cluster4_team_parts").insert({
    team_half_id: currentTeam.teamHalfId,
    part_name: name,
    is_default: false,
    leader_user_id: null, // 새 파트는 파트장 없음.
    display_order: nextOrder,
  });
  if (error) {
    // UNIQUE(team_half_id, part_name) 경합 → 409.
    if ((error as { code?: string }).code === "23505")
      throw new TeamHalfWriteError(409, "이미 같은 이름의 파트가 있습니다.");
    throw new TeamHalfWriteError(500, error.message);
  }
  return { partName: name };
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
  mode: ScopeMode = "operating",
  // 요청 조직(선택). 지정되면 크루의 실제 소속 org 와 일치해야 노출한다(fail-closed).
  //   팀장 = 팀과 동일 조직 강제 — 타 조직 크루를 팀장으로 지정하는 사고를 원천 차단.
  organization?: string | null,
): Promise<TeamLeaderCandidateDto | null> {
  const userId = await getUserIdByCrewCode(crewCode);
  if (!userId) return null;

  // 모집단 축 단일 SoT — 읽기/쓰기가 같은 실효 모드를 쓰도록 정규화(QA=test 고정).
  const effectiveMode = resolveEffectiveScopeMode(mode);
  // QA 누수 차단 — 스코프 밖 크루는 노출하지 않는다(test=test_user_markers만 / operating=실사용자만).
  const scope = await resolveUserScope(effectiveMode === "test" ? "test" : "operating", null);
  if (!scope.includes(userId)) return null;

  const detail = await getCrewDetailDto(userId);
  if (!detail) return null;

  // 조직 강제(fail-closed) — 요청 org 가 지정되면 크루 실제 소속 org 와 일치해야 한다.
  const org = String(organization ?? "").trim();
  if (org && detail.organizationSlug !== org) return null;

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
  mode: ScopeMode = "operating",
): Promise<{ teams: TeamHalfTeamDto[] }> {
  const organization = String(input.organization ?? "").trim();
  const halfKey = String(input.halfKey ?? "").trim();
  const teamName = String(input.teamName ?? "").trim();
  const description = String(input.description ?? "").trim();
  const leaderCrewCode = String(input.leaderCrewCode ?? "").trim();

  if (!isOrganizationSlug(organization)) {
    throw new TeamHalfWriteError(400, "유효한 클럽이 필요합니다.");
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
  // 신규 팀 스코프 = 요청 실효 모드(QA=test 고정)로 각인. 팀명/(T) 규칙이 아니라 생성 시점 모드가 SoT.
  //   ⚠ 신규 등록엔 기존 팀 스코프 가드(assertStoredTeamScope)를 적용하지 않는다 — 아직 저장된
  //     스코프가 없기 때문. 스코프 컬럼 부재(마이그 전)에만 읽기(이름 필터)와의 정합을 위해 이름
  //     기반 스코프를 강제한다(비-(T) 테스트 팀 생성은 컬럼 적용 후 활성화).
  const effectiveMode = resolveEffectiveScopeMode(mode);
  const isQaTest = effectiveMode === "test";
  const withScopeColumn = await hasScopeColumn();
  if (!withScopeColumn) {
    assertStoredTeamScope(isTestTeam(organization, teamName), effectiveMode);
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

  // 팀장 — crew_code 로 재해석(이미 등록된 크루만 가능). 공통 resolver(lookupCrewByCode)로 org·mode
  //   까지 함께 검증 → 타 조직/타 모드 크루를 팀장으로 지정하는 사고를 서버에서 fail-closed 차단.
  if (!leaderCrewCode) {
    throw new TeamHalfWriteError(400, "팀장 크루코드를 입력해주세요.");
  }
  const leader = await lookupCrewByCode(leaderCrewCode, effectiveMode, organization);
  if (!leader) {
    throw new TeamHalfWriteError(
      400,
      "현재 조직 및 모드에 등록된 크루만 팀장으로 지정할 수 있습니다.",
    );
  }
  const leaderUserId = leader.userId;

  // 기존 행(활성/비활성) 로드 — 10개 제한·중복·재활성 판정. 팀명은 (org,반기) UNIQUE(스코프 무관)라
  //   dedup/재활성은 스코프와 무관하게 이름으로 판정한다.
  const existing = await loadHalfRows(organization, halfKey);

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

  // 스코프 각인은 컬럼 존재 시에만 기록(마이그 전엔 필드 생략 → 이름 폴백 유지).
  const scopeField = withScopeColumn ? { is_qa_test: isQaTest } : {};

  let teamHalfId: string;
  if (sameName && !sameName.is_active) {
    // 비활성 동명 팀 → 재활성 + 갱신(재등록이므로 현재 실효 모드로 스코프 재각인).
    const { error } = await supabaseAdmin
      .from("cluster4_team_halves")
      .update({
        is_active: true,
        display_order: maxOrder + 1,
        description,
        leader_user_id: leaderUserId,
        leader_crew_code: leaderCrewCode,
        team_id: teamId,
        ...scopeField,
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
        ...scopeField,
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

// ── 팀 수정(현재·다음 반기만) ─────────────────────────────────────────
// 기존 팀 box 의 팀명·개요·팀장(crew_code)을 수정한다. 등록과 동일 게이트(편집 가능 반기).
//   팀명 변경 시 같은 (org, 반기) 내 다른 행과 충돌하면 409(UNIQUE(org,half,team_name) 보호).
//   팀장 변경 시 산하 "일반" 파트장도 동기화(ensureGeneralPart 는 기존행 미변경이라 직접 update).
export type UpdateTeamInput = {
  organization: string;
  halfKey: string;
  teamHalfId: string;
  teamName: string;
  description: string;
  leaderCrewCode: string;
};

export async function updateTeamHalf(
  input: UpdateTeamInput,
  today?: string,
  mode: ScopeMode = "operating",
): Promise<{ teams: TeamHalfTeamDto[] }> {
  const organization = String(input.organization ?? "").trim();
  const halfKey = String(input.halfKey ?? "").trim();
  const teamHalfId = String(input.teamHalfId ?? "").trim();
  const teamName = String(input.teamName ?? "").trim();
  const description = String(input.description ?? "").trim();
  const leaderCrewCode = String(input.leaderCrewCode ?? "").trim();

  if (!isOrganizationSlug(organization)) {
    throw new TeamHalfWriteError(400, "유효한 클럽이 필요합니다.");
  }
  if (!isHalfKey(halfKey)) {
    throw new TeamHalfWriteError(400, "유효하지 않은 반기 키입니다.");
  }
  if (!teamHalfId) {
    throw new TeamHalfWriteError(400, "수정할 팀 식별자가 필요합니다.");
  }
  // 현재·다음 반기만 수정 허용(과거 반기 fail-closed).
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
  if (!leaderCrewCode) {
    throw new TeamHalfWriteError(400, "팀장 크루코드를 입력해주세요.");
  }
  // 읽기와 동일한 실효 모드(QA=test 고정) — 스코프 가드·팀장 org/mode 검증이 모두 이 값을 쓴다.
  const effectiveMode = resolveEffectiveScopeMode(mode);
  const leader = await lookupCrewByCode(leaderCrewCode, effectiveMode, organization);
  if (!leader) {
    throw new TeamHalfWriteError(
      400,
      "현재 조직 및 모드에 등록된 크루만 팀장으로 지정할 수 있습니다.",
    );
  }
  const leaderUserId = leader.userId;

  // 대상 행 + 같은 (org, 반기) 행 로드(팀명 충돌 검사). 스코프 각인 포함.
  const rows = await loadHalfRows(organization, halfKey);

  const target = rows.find((r) => r.id === teamHalfId);
  if (!target || !target.is_active) {
    throw new TeamHalfWriteError(404, "수정할 팀을 찾을 수 없습니다.");
  }
  // 쓰기 스코프 가드 — 대상 팀의 저장된 스코프가 현재 실효 모드와 일치해야(운영↔테스트 교차 차단).
  //   신규 등록과 달리 기존 팀은 저장된 스코프가 SoT(팀명/(T) 규칙 아님).
  assertStoredTeamScope(target.is_qa_test, effectiveMode);
  // 팀명을 다른 행(활성/비활성 불문)과 겹치게 변경 불가(UNIQUE 보호).
  const clash = rows.find((r) => r.id !== teamHalfId && r.team_name === teamName);
  if (clash) {
    throw new TeamHalfWriteError(409, "이미 존재하는 팀명입니다.");
  }

  // team_id soft-link 재해석(현재 마스터에 동일 org/name 있으면).
  const { data: masterData, error: masterError } = await supabaseAdmin
    .from("cluster4_teams")
    .select("id")
    .eq("organization_slug", organization)
    .eq("team_name", teamName)
    .maybeSingle();
  if (masterError) throw new TeamHalfWriteError(500, masterError.message);
  const teamId = (masterData as { id: string } | null)?.id ?? null;

  const { error: updError } = await supabaseAdmin
    .from("cluster4_team_halves")
    .update({
      team_name: teamName,
      description,
      leader_user_id: leaderUserId,
      leader_crew_code: leaderCrewCode,
      team_id: teamId,
    })
    .eq("id", teamHalfId);
  if (updError) throw new TeamHalfWriteError(500, updError.message);

  // 산하 "일반" 파트장 동기화(팀장 변경 반영). 없으면 생성.
  await ensureGeneralPart(teamHalfId, leaderUserId);
  const { error: partError } = await supabaseAdmin
    .from("cluster4_team_parts")
    .update({ leader_user_id: leaderUserId })
    .eq("team_half_id", teamHalfId)
    .eq("part_name", DEFAULT_PART_NAME);
  if (partError) throw new TeamHalfWriteError(500, partError.message);

  return { teams: await listHalfTeams(organization, halfKey) };
}

// ── 팀 삭제 대기 처리(현재·다음 반기만) ───────────────────────────────
// 하드 삭제하지 않고 is_active=false 로 전환("삭제 대기" 비활성). 목록·존재표에서 사라지고
//   더 이상 수정/갱신 대상이 아니다. 실제 삭제(하드)는 후속 프로세스에서 이 행들을 대상으로 한다.
export async function markTeamHalfDeletionPending(
  organization: string,
  halfKey: string,
  teamHalfId: string,
  today?: string,
  mode: ScopeMode = "operating",
): Promise<{ teams: TeamHalfTeamDto[] }> {
  const org = String(organization ?? "").trim();
  const half = String(halfKey ?? "").trim();
  const id = String(teamHalfId ?? "").trim();

  if (!isOrganizationSlug(org)) {
    throw new TeamHalfWriteError(400, "유효한 클럽이 필요합니다.");
  }
  if (!isHalfKey(half)) {
    throw new TeamHalfWriteError(400, "유효하지 않은 반기 키입니다.");
  }
  if (!id) {
    throw new TeamHalfWriteError(400, "삭제할 팀 식별자가 필요합니다.");
  }
  const currentHalfKey = await resolveCurrentHalfKey(today);
  if (!isEditableHalf(half, currentHalfKey)) {
    throw new TeamHalfWriteError(
      403,
      "현재 또는 다음 반기만 수정할 수 있습니다. 과거 반기는 조회 전용입니다.",
    );
  }

  const target = (await loadHalfRows(org, half)).find((r) => r.id === id) ?? null;
  if (!target) {
    throw new TeamHalfWriteError(404, "삭제할 팀을 찾을 수 없습니다.");
  }
  // 쓰기 스코프 가드 — 대상 팀의 저장된 스코프가 실효 모드와 일치해야(QA서 운영팀 삭제 차단).
  assertStoredTeamScope(target.is_qa_test, resolveEffectiveScopeMode(mode));

  if (target.is_active) {
    const { error } = await supabaseAdmin
      .from("cluster4_team_halves")
      .update({ is_active: false })
      .eq("id", id);
    if (error) throw new TeamHalfWriteError(500, error.message);
  }
  // 이미 비활성(중복 삭제 요청)이면 idempotent — 그대로 성공 처리.

  return { teams: await listHalfTeams(org, half) };
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

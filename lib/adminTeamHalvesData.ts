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
import { resolvePositionLabels } from "@/lib/adminMembersTypes";
import { loadCurrentWeekOverrideLabels } from "@/lib/positionResolver";
import {
  type EducationAuthorityRow,
  loadEducationRowsByUserIds,
  selectRepresentativeEducation,
} from "@/lib/educationResolver";
import { displayNameFromProfile } from "@/lib/displayNameResolver";
import { isOrganizationSlug, ORGANIZATIONS, type OrganizationSlug } from "@/lib/organizations";
// <운용> 파트 판정 공용 SoT. 이 파일에서 멤버십으로 다시 세지 않는다(2026-07-27 C1/C2).
//   ⚠ adminTeamSelectedWeekSummary 는 여기서 DEFAULT_PART_NAME/getLeaderBasicsBatch 를 가져가므로
//     순환 import 다. 양쪽 다 **함수 본문에서만** 상대 바인딩을 읽어(호출 시점 해소) 안전하다 —
//     top-level 에서 상대 모듈 값을 읽는 코드를 새로 추가하지 말 것(TDZ 로 깨진다).
import {
  getTeamSelectedWeekSummary,
  listOperatedTeamParts,
  loadTeamWeekRostersBulk,
  operatedPartsFromRoster,
  teamWeekRosterKey,
} from "@/lib/adminTeamSelectedWeekSummary";
import { loadSeasonWeeks } from "@/lib/adminSeasonWeeksData";
import {
  isTestTeam,
  resolveEffectiveScopeMode,
} from "@/lib/cluster4ExperienceTestScope";
import type { ScopeMode } from "@/lib/userScopeShared";
import { resolveUserScope } from "@/lib/userScope";
import { SUPER_ADMIN_EXCLUDE_OR } from "@/lib/superAdmins";
import { markWeeklyCardsSnapshotStaleMany } from "@/lib/cluster4WeeklyCardsSnapshot";
import { resolveHalfPeriod } from "@/lib/halfPeriod";
import {
  loadWeekPositionOverridesByUser,
  type OverridePosition,
} from "@/lib/teamWeekPositionOverride";
import { resolveTeamLifecyclesAtWeek } from "@/lib/teamLifecycle";
import { applyMemberRolePosition, MemberPatchError } from "@/lib/adminMembersData";
import { roleLevelToPositionCode } from "@/shared/crewClassPosition";
import type { PositionCode } from "@/lib/positionHistory";
import { selectMembershipRow, type SelectableMembership } from "@/lib/membershipResolver";

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
  updated_at?: string | null;
};

// 팀 생성 직후/점유 파트가 없을 때 노출하는 기본 파트명.
export const DEFAULT_PART_NAME = "일반";

// 스코프 컬럼(is_qa_test) 없이 조회하던 기본 컬럼 셋.
const TEAM_HALF_BASE_COLS =
  "id,team_name,team_id,display_order,is_active,description,leader_user_id,leader_crew_code,leader_name,updated_at";

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

  const educationRows = await loadEducationRowsByUserIds(userIds);
  const edus = [...educationRows.values()].flat();

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
  const groups = new Map<string, EducationAuthorityRow[]>();
  for (const e of edus) {
    const arr = groups.get(e.user_id) ?? [];
    arr.push(e);
    groups.set(e.user_id, arr);
  }
  for (const [uid, arr] of groups) {
    const top = selectRepresentativeEducation(arr);
    eduByUser.set(uid, { school: top?.school_name ?? null, major: top?.major_name_1 ?? null });
  }

  // 현재 상태 화면 규칙 — 현재 주차 override 가 있으면 클래스가 그 값을 따른다(회원 목록과 동일).
  const weekOverrides = await loadCurrentWeekOverrideLabels(userIds);
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
      name: displayNameFromProfile(p),
      org: p.organization_slug,
      birth6: toBirth6(p.birth_date),
      gender: p.gender,
      residence: p.address,
      school: edu?.school ?? null,
      major: edu?.major ?? null,
      classLabel: resolvePositionLabels({
        positionCode: weekOverrides.get(p.user_id)?.positionCode ?? null,
        role: p.role ?? null,
        membershipLevel: level,
      }).classLabel,
      gradeLabel: grade?.label ?? null,
      gradeRank: grade?.grade ?? null,
    });
  }
  return out;
}

// (제거됨 2026-07-27) computeTeamPartInfo — "현재 멤버십으로 팀별 파트 세기"(POST 폴백).
//   <운용> 파트를 세는 4번째 경로였고, 주차 override·시즌 휴식·모집단 스코프를 전부 무시했다.
//   partCount/partNames 는 이제 **한 경로**로만 채워진다: computePartWeekData(공용 SoT)
//   → derivePartsFromMatrix. GET/POST 모두 fillTeamPartsFromMatrix 를 지난다.

// 특정 반기의 활성 팀 목록(노출 순) + 팀장 기본정보.
//   ⚠ partCount/partNames 는 여기서 계산하지 않는다(기본값 '일반'·1). <운용> 파트는 공용 SoT 를 타는
//     fillTeamPartsFromMatrix 가 채운다 — 그 규칙을 여기에 복제하면 다시 갈린다.
export async function listHalfTeams(
  organization: string,
  halfKey: string,
  opts: {
    /**
     * true 면 삭제(is_active=false)된 팀도 함께 반환한다(2026-08-08 추가 — 관리 원장 전용).
     *   ⚠ 기본값 false — activeOnly:true(종전 동작 그대로) 무회귀. "지금 활동 중인 팀만" 필요한
     *   호출부(예: 긴급 휴식 대상 산정, lib/adminEmergencyRest.ts)는 옵션을 생략하면 된다.
     *   관리 원장(팀 목록 CRUD 화면)만 명시적으로 true 를 넘긴다 — 삭제팀을 숨기지 않되, 그 팀을
     *   "지금 존재하는 팀"으로 계산에 섞으면 안 되므로 호출부가 반드시 isActive 로 구분해서 쓸 것.
     */
    includeInactive?: boolean;
  } = {},
): Promise<TeamHalfTeamDto[]> {
  const rows = await loadHalfRows(organization, halfKey, { activeOnly: !opts.includeInactive });

  const leaderIds = Array.from(
    new Set(rows.map((r) => r.leader_user_id).filter((id): id is string => !!id)),
  );
  const leaderBasics = await getLeaderBasicsBatch(leaderIds);

  return rows.map((r) => {
    const lbRaw = r.leader_user_id ? leaderBasics.get(r.leader_user_id) : null;
    // 조직 강제: 연결 크루의 org 가 팀 org 와 다르면 상세를 노출하지 않는다(다른 조직 동명 방지).
    //   leader_name(이름 SoT)은 유지되므로 이름만 표시되고 나머지는 "-".
    const lb = lbRaw && lbRaw.org === organization ? lbRaw : null;
    return {
      teamHalfId: r.id,
      teamName: r.team_name,
      teamId: r.team_id,
      displayOrder: r.display_order,
      isActive: r.is_active,
      description: r.description,
      leaderUserId: r.leader_user_id,
      leaderCrewCode: r.leader_crew_code,
      // 사람 이름은 연결된 크루의 user_profiles.display_name만 사용한다.
      leaderName: lb?.name ?? null,
      // 부가정보는 연결크루 존재 시에만(무매칭=null→UI "-").
      leaderBirth6: lb?.birth6 ?? null,
      leaderGender: lb?.gender ?? null,
      leaderSchool: lb?.school ?? null,
      leaderMajor: lb?.major ?? null,
      leaderResidence: lb?.residence ?? null,
      leaderClassLabel: lb?.classLabel ?? null,
      leaderGradeLabel: lb?.gradeLabel ?? null,
      // 기본값 — fillTeamPartsFromMatrix 가 공용 SoT 로 덮어쓴다(운용 파트 없으면 '일반'·1 유지).
      partCount: 1,
      partNames: [DEFAULT_PART_NAME],
      partWeekMatrix: null,
      isQaTest: r.is_qa_test,
    };
  });
}

// 팀 목록 + <운용> 파트(공용 SoT) — GET/POST 어느 응답이든 이 한 경로만 지난다.
//   partWeekMatrix(존재표) · partCount/partNames(파트 칩) 를 같은 계산 1회로 함께 채운다.
export async function fillTeamPartsFromMatrix(
  organization: string,
  halfKey: string,
  teams: TeamHalfTeamDto[],
  mode: ScopeMode,
  todayIso: string,
): Promise<PartWeekColumnDto[]> {
  if (teams.length === 0) {
    // 팀이 없어도 x축은 계산(빈 표·UI 일관).
    const { weekColumns } = await computePartWeekData(organization, halfKey, [], mode, todayIso);
    return weekColumns;
  }
  const { weekColumns, byTeam } = await computePartWeekData(
    organization,
    halfKey,
    teams.map((t) => ({ teamHalfId: t.teamHalfId, teamName: t.teamName })),
    mode,
    todayIso,
  );
  // ① 팀정보 ② 파트 수/파트명 ③ 존재표 — 전부 같은 계산 결과에서 파생(원천 1개).
  for (const t of teams) {
    const m = byTeam.get(t.teamName) ?? null;
    t.partWeekMatrix = m;
    if (m) {
      const derived = derivePartsFromMatrix(m, weekColumns, todayIso);
      t.partCount = derived.partCount;
      t.partNames = derived.partNames;
    }
  }
  return weekColumns;
}

// 팀 목록(파트 포함) — 쓰기 응답 전용 진입점. GET 은 loadTeamPartsInfo 가 같은 함수를 부른다.
async function listHalfTeamsWithParts(
  organization: string,
  halfKey: string,
  mode: ScopeMode,
  today?: string,
): Promise<TeamHalfTeamDto[]> {
  // 관리 원장 쓰기(등록/수정/삭제)의 응답 목록 — 삭제팀도 포함해 돌려준다(방금 삭제한 팀이
  //   응답에서 바로 사라지면 "삭제됐는데 원장에서도 안 보인다"는 오해를 만든다).
  const teams = await listHalfTeams(organization, halfKey, { includeInactive: true });
  await fillTeamPartsFromMatrix(
    organization,
    halfKey,
    teams,
    mode,
    today ?? getCurrentActivityDateIso(),
  );
  return teams;
}

// ── 파트×주차 존재표 계산 ──────────────────────────────────────────────
// 선택 반기의 두 시즌(방학→학기, ~26주) x축 + 팀별 파트(누적) y축 존재표.
//   y축 파트 = 카탈로그(cluster4_team_parts, "일반" 보장) ∪ 그 반기에 실제 운용된 파트.
//   셀 = 그 주 그 파트 배정 크루 ≥1 — 판정은 **공용 SoT**(loadTeamWeekRostersBulk) 하나뿐이다.
//   read 전용(weeks·카탈로그·로스터 조회) → snapshot 영향 없음.

// (제거됨 2026-07-27) currentMembershipPartsByTeam / currentMembershipAssignmentsByTeam —
//   "현재 멤버십으로 팀별 점유 파트 세기" · "UPH 없는 주차를 현재 멤버십으로 메우기".
//   전자는 팀 상세 상단·클럽 요약이, 후자는 파트×주차 존재표가 썼는데, 둘 다 모집단 스코프·시즌
//   휴식/활동 중단·크루 여부를 반영하지 못해 같은 화면의 [A] 와 갈렸다. 세 소비처 모두 공용 SoT
//   (listOperatedTeamParts / getTeamSelectedWeekSummary.operatedParts / loadTeamWeekRostersBulk)로
//   이관했다 — 멤버십 폴백은 공용 resolver 안에 이미 들어 있다. 다시 만들지 말 것.

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
  //    ⚠ 현재 주차에 파트/클래스 override 가 있으면 그 클래스가 이긴다 — 같은 사람이 [A] 요약과
  //      [B] 표에서 다른 등급으로 집계되던 불일치를 없앤다([[teamWeekPositionOverride]]).
  // 현재 주차 = 이 파일의 정식 helper(loadSeasonWeeks.is_current_week) 재사용.
  const currentWeekStart = await resolveCurrentWeekStartDate();
  const weekOverrides = currentWeekStart
    ? await loadWeekPositionOverridesByUser(currentWeekStart, uids)
    : new Map<string, OverridePosition>();
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
      const ovr = weekOverrides.get(m.user_id);
      const tn = (ovr?.rawTeam ?? m.team_name)?.trim();
      if (!tn || !teamNameSet.has(tn)) continue;
      // ⚠ 아래 버킷 분기는 **상태 어휘**("일반"/"심화(…)")다. 클래스 어휘("정규")를 넣으면 어느
      //   분기에도 안 걸려 그 사람이 집계에서 사라진다(2026-07-22 실측 [A] 정규6→4).
      //   공통 변환기가 두 어휘를 함께 주므로 여기서는 statusLabel 만 고르면 된다.
      const label = resolvePositionLabels({
        positionCode: ovr?.positionCode ?? null,
        role: roleByUser.get(m.user_id) ?? null,
        membershipLevel: m.membership_level ?? null,
      }).statusLabel;
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
  mode: ScopeMode = "operating",
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

  // 3~4) 주차별 <운용> 파트 = **공용 SoT 하나**(loadTeamWeekRostersBulk).
  //   [A] 주차 요약(getTeamSelectedWeekSummary)·실무 경험 파트 스코프(listOperatedTeamParts)와
  //   완전히 같은 함수·같은 규칙이다:
  //     후보 = org 프로필 ∪ 그 주차 UPH ∪ 그 주차 override, ∩ 모집단 스코프(mode)
  //          ∩ 집합①(시즌 휴식·활동 중단 제외)
  //     소속 = override(≤W 최신) → UPH(W) → 현재 멤버십  ·  크루 3종만(운영진 제외)
  //   ⚠ 여기서 UPH/override/멤버십을 다시 조립하지 말 것. 종전엔 이 함수만 자체 조립이라
  //     ① 모집단 스코프 ② 시즌 휴식·활동 중단 ③ 크루 여부를 전부 빠뜨렸고, 그래서 시즌 휴식자
  //     한 명만 override 로 배정돼 있던 파트가 [A] 에선 사라졌는데 존재표에는 계속 ● 로 남았다
  //     (2026-07-27 실측: encre 비주얼랩(T) '테스트' 여름4~가을1). 규칙 변경은 공용 SoT 에서.
  //   ⚠ 과거/미래 주차 게이트 없음 — 미래 주차도 현재 배정을 투영(carry-forward)한다. 팀 카드
  //     요약(파트 수/파트명)만 derivePartsFromMatrix 가 todayIso 이하로 한정한다.
  const rosterByKey = await loadTeamWeekRostersBulk({
    organization: organization as OrganizationSlug,
    teamNames: teams.map((t) => t.teamName),
    weeks: weekColumns.map((c) => ({ weekStartDate: c.weekStartDate, seasonKey: c.seasonKey })),
    mode,
    today: todayIso,
  });

  // 존재표 집계 — teamName → partName → Set<weekIdx>, partName 최초 등장 weekIdx(정렬용).
  const presence = new Map<string, Map<string, Set<number>>>();
  const firstSeen = new Map<string, Map<string, number>>();
  for (const t of teams) {
    const pm = new Map<string, Set<number>>();
    const fm = new Map<string, number>();
    for (let wi = 0; wi < weekColumns.length; wi++) {
      const members = rosterByKey.get(teamWeekRosterKey(t.teamName, weekColumns[wi].weekStartDate));
      if (!members || members.length === 0) continue;
      // 셀 = 그 주 그 파트 배정 크루 ≥1 — [A] operatedParts 와 같은 집계기.
      for (const p of operatedPartsFromRoster(members)) {
        const set = pm.get(p.partName) ?? new Set<number>();
        set.add(wi);
        pm.set(p.partName, set);
        if (!fm.has(p.partName) || wi < (fm.get(p.partName) ?? Infinity)) fm.set(p.partName, wi);
      }
    }
    presence.set(t.teamName, pm);
    firstSeen.set(t.teamName, fm);
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
//   ⚠ **탐색 상한 = todayIso 이하 마지막 주차 열**. 매트릭스 셀(present)은 현재 배정을 미래로
//     투영하지만, 팀 카드 요약은 "현재까지 실제 운용된 파트"를 유지해야 한다
//     (사용자 결정 2026-07-24). 미래 투영이 요약값을 밀어내지 않도록 여기서 열을 오늘까지로 한정한다.
//   ⚠ 여기서 파트를 다시 세지 않는다 — 입력 matrix 가 이미 공용 SoT(loadTeamWeekRostersBulk) 산출물이라
//     "열 하나 고르기"만 한다. 운용 판정 규칙이 바뀌면 공용 SoT 만 고치면 세 표시가 함께 움직인다.
//   ⚠ '일반' 폴백은 **표시용**이다(운용 파트 0인 팀도 칩 1개는 보인다). 실제 운용 파트 개수가 필요한
//     소비처(클럽 요약 '파트 수')는 listOperatedTeamParts('일반' 제외)를 쓴다 — 두 숫자가 달라 보이는 건
//     정의 차이지 원천 차이가 아니다.
function derivePartsFromMatrix(
  matrix: PartWeekMatrixDto,
  weekColumns: PartWeekColumnDto[],
  todayIso: string,
): { partCount: number; partNames: string[] } {
  // 오늘 이하 마지막 주차 열까지만 요약 근거로 삼는다(없으면 전 열 — 전부 미래인 이례 케이스 방어).
  let upperIdx = -1;
  for (let wi = weekColumns.length - 1; wi >= 0; wi--) {
    if (weekColumns[wi].weekStartDate <= todayIso) {
      upperIdx = wi;
      break;
    }
  }
  if (upperIdx < 0) upperIdx = weekColumns.length - 1;
  let lastIdx = -1;
  for (let wi = upperIdx; wi >= 0; wi--) {
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
//   · partCount = Σ listOperatedTeamParts(org, team, 현재 주차, mode).length — **공용 SoT 그대로**.
//     = 그 주차 effective 배정 크루 ≥1 인 파트('일반' 제외). 카탈로그 레코드 수 아님(크루 0 파트 제외).
//     ⚠ 포함/제외 규칙(주차 override·휴식자·super admin·'일반')을 여기서 재구현하지 않는다 —
//       규칙이 필요하면 listOperatedTeamParts 쪽을 고쳐 모든 소비처가 함께 움직이게 한다.
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

// "그 주차 시점에 존재했던 팀만" 필터 — 공용 lifecycle resolver(lib/teamLifecycle.ts) 위임.
//   ⚠ is_active(현재값) 하나만으로 반기 전체 요약을 내는 것을 막기 위해 도입(2026-08-08).
//   반기 요약(loadCurrentClubStructure/loadClubStructure)이 팀 엔티티 수를 셀 때 반드시 이 함수를
//   거친다 — is_active 를 직접 필터 조건으로 다시 쓰지 말 것(그 순간 "종료 이후에도 그 반기 전체
//   요약에서 통째로 빠지는" 회귀가 재현된다).
async function filterRowsAliveAtWeek<T extends { team_name: string; is_active: boolean; updated_at?: string | null; leader_user_id: string | null }>(
  organization: string,
  rows: T[],
  weekStartDate: string,
): Promise<T[]> {
  if (rows.length === 0) return rows;
  const lifecycles = await resolveTeamLifecyclesAtWeek({
    organization,
    rows: rows.map((r) => ({
      teamName: r.team_name,
      isActive: r.is_active,
      updatedAt: r.updated_at ?? null,
      currentLeaderUserId: r.leader_user_id,
    })),
    weekStartDate,
  });
  return rows.filter((r) => lifecycles.get(r.team_name)?.exists ?? r.is_active);
}

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
  const todayIso = today ?? getCurrentActivityDateIso();
  const currentWeekStart = await resolveCurrentWeekStartDate(todayIso);
  const results = await Promise.all(
    [...ORGANIZATIONS].map(async (org) => {
      // 현재 반기 + 스코프(is_qa_test) 팀 — is_active 로 미리 거르지 않는다. "지금" 시점 존재 여부는
      //   공용 lifecycle resolver(effectiveFrom/effectiveTo)로 판정한다(2026-08-08, 종료 시점 반영).
      //   currentWeekStart 를 못 구하면(달력 갭) 종전처럼 is_active 만으로 안전 폴백.
      const allRows = await loadHalfRows(org, currentHalfKey, {});
      const scopedAll = allRows.filter((r) => r.is_qa_test === wantQaTest);
      const scoped = currentWeekStart
        ? await filterRowsAliveAtWeek(org, scopedAll, currentWeekStart)
        : scopedAll.filter((r) => r.is_active);
      // 파트 수 SoT = 팀별 listOperatedTeamParts(현재 주차).length 합.
      //   ⚠ 종전엔 user_memberships(is_current·비휴식) 로 따로 셌다. 주차 override 가 반영되지 않고
      //     휴식자 제외 규칙도 달라, 팀 상세/[A] 와 총합이 갈렸다(실측 2026-07-27: 22 vs 24).
      //   '일반' 제외·휴식자·super admin 처리는 전부 공용 SoT 안의 규칙을 그대로 따른다(재구현 금지).
      const partsPerTeam = await Promise.all(
        scoped.map((r) =>
          listOperatedTeamParts({ organization: org, teamName: r.team_name, weekId: null, mode, today }),
        ),
      );
      const partCount = partsPerTeam.reduce((sum, parts) => sum + parts.length, 0);
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

// 임의 반기(halfKey) + 기준 주차(asOfWeekId) 기준 조직 "구조" 숫자 — loadCurrentClubStructure 의
//   반기 파라미터화 버전. `lib/halfPeriod.ts` 의 resolveHalfPeriod() 가 정한 halfKey/asOfWeekId 를
//   그대로 받는다(이 함수 안에서 "현재가 언제인지"를 다시 판단하지 않는다 — 단일 asOf 원천 원칙).
//   ⚠ loadCurrentClubStructure(mode, today) 는 위치 인자 시그니처를 쓰는 기존 소비처가 있어
//     그대로 둔다(무회귀). 이 함수는 별도로 추가한 반기 대응 경로다.
export type HalfClubStructureRow = {
  orgSlug: OrganizationSlug;
  teamEntityCount: number;
  partCount: number;
};
export type HalfClubStructure = {
  perOrg: HalfClubStructureRow[];
  totals: { totalClubs: number; totalTeams: number; totalParts: number };
};

export async function loadClubStructure(opts: {
  halfKey: string;
  asOfWeekId: string | null;
  mode?: ScopeMode;
  today?: string;
}): Promise<HalfClubStructure> {
  const { halfKey, asOfWeekId, mode = "operating", today } = opts;
  const wantQaTest = resolveEffectiveScopeMode(mode) === "test";
  const perOrg: HalfClubStructureRow[] = [];
  const totals = { totalClubs: 0, totalTeams: 0, totalParts: 0 };

  // asOfWeekId → week_start_date(1회 조회, org 무관 공통값). 팀 엔티티 존재 판정에 쓴다
  //   (2026-08-08 — 종전엔 asOfWeekId 를 파트 수 계산에만 쓰고 팀 존재 자체는 is_active 만 봤다.
  //   그 결과 반기 중간에 종료된 팀이 "그 반기가 끝난 시점" 요약에서 통째로 빠지거나, 반대로
  //   반기 중 잠깐 존재했다 사라진 팀이 남아있는 것처럼 보일 수 있었다).
  const asOfWeekStart = asOfWeekId
    ? ((await supabaseAdmin.from("weeks").select("start_date").eq("id", asOfWeekId).maybeSingle())
        .data as { start_date?: string } | null)?.start_date ?? null
    : null;

  const results = await Promise.all(
    [...ORGANIZATIONS].map(async (org) => {
      const allRows = (await loadHalfRows(org, halfKey, {})).filter((r) => r.is_qa_test === wantQaTest);
      const scoped = asOfWeekStart
        ? await filterRowsAliveAtWeek(org, allRows, asOfWeekStart)
        : allRows.filter((r) => r.is_active);
      // asOfWeekId 가 없으면(그 반기에 주차 자체가 없음 — 예: 2022) 팀 entity 도 통상 0행이라
      //   listOperatedTeamParts 를 호출하지 않는다(호출하면 today 로 폴백해 현재 주차를 잘못 본다).
      const partsPerTeam = asOfWeekId
        ? await Promise.all(
            scoped.map((r) =>
              listOperatedTeamParts({
                organization: org,
                teamName: r.team_name,
                weekId: asOfWeekId,
                mode,
                today,
              }),
            ),
          )
        : scoped.map(() => [] as string[]);
      const partCount = partsPerTeam.reduce((sum, parts) => sum + parts.length, 0);
      return { orgSlug: org, teamEntityCount: scoped.length, partCount };
    }),
  );

  for (const r of results) {
    perOrg.push(r);
    if (r.teamEntityCount > 0) totals.totalClubs += 1;
    totals.totalTeams += r.teamEntityCount;
    totals.totalParts += r.partCount;
  }
  return { perOrg, totals };
}

// halfKey 미지정(또는 현재 반기) → 기존 동작 그대로(byte-identical, 무회귀). halfKey 가 과거
//   반기면 counts(전체 클럽/팀/파트 수)만 그 반기 기준으로 바뀐다 — "오늘은 …" 문구의 날짜·주차는
//   항상 실제 오늘(변경 없음, 2026-07-31 사용자 확정: "오늘은" 문구는 실제 오늘 안내이므로 유지).
export async function loadTeamPartsCurrentSummary(
  mode: ScopeMode = "operating",
  today?: string,
  halfKey?: string | null,
): Promise<TeamPartsInfoSummaryDto> {
  const [week, period] = await Promise.all([
    resolveCurrentWeekInfo(today),
    halfKey ? resolveHalfPeriod({ halfKey, today }) : Promise.resolve(null),
  ]);

  if (!period || period.isCurrentHalf) {
    const structure = await loadCurrentClubStructure(mode, today);
    return { currentDate: week.currentDate, currentWeek: week.currentWeek, counts: structure.totals };
  }

  const structure =
    period.structureSource === "unavailable"
      ? { totals: { totalClubs: 0, totalTeams: 0, totalParts: 0 } }
      : await loadClubStructure({ halfKey: period.period, asOfWeekId: period.asOfWeekId, mode, today });
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
  //   ⚠ includeInactive:true — 이 화면(관리 원장)은 삭제(is_active=false)된 팀도 조회 가능해야
  //   한다(2026-08-08). "지금 활동 중인 팀"이 필요한 화면(● 해당 시기 요약 등)은 응답의
  //   teams[].isActive 로 직접 걸러서 쓴다 — 이 함수가 대신 숨기면 원장에서도 사라진다.
  const wantQaTest = resolveEffectiveScopeMode(mode) === "test";
  const teams = selected
    ? (await listHalfTeams(organization, selected, { includeInactive: true })).filter(
        (t) => t.isQaTest === wantQaTest,
      )
    : [];
  const editable = selected != null && isEditableHalf(selected, currentHalfKey);

  // 파트×주차 존재표(선택 반기). 팀별 matrix 를 teams 에 병합 + x축 weekColumns.
  //   ⚠ 반기별 분기 없음 — 과거·현재·미래 반기 모두 공용 SoT 의 같은 규칙으로 계산한다
  //     (종전의 "현재 반기에서만 멤버십 폴백" 게이트 제거 — [A] 와 갈리던 원인).
  const weekColumns: PartWeekColumnDto[] = selected
    ? await fillTeamPartsFromMatrix(organization, selected, teams, mode, todayIso)
    : [];

  // 상단 요약 — 날짜/주차는 항상 실제 오늘, 전체 클럽/팀/파트 수는 선택 반기(selected) 기준.
  //   mode 스코프만 전파(운영/test 동일 함수). 모든 org 응답이 동일 값을 담으므로 프론트는
  //   base(첫 결과)만 읽어도 전 조직 현황을 얻는다.
  const summary = await loadTeamPartsCurrentSummary(mode, today, selected);

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

  // 2) 현재 접속 시점 기준 — 현재 반기 정보 + 날짜/주차 + 현재 주차 요약([A] 와 동일 원천).
  const [currentInfo, week, currentWeekStartDate, currentWeekSummary] = await Promise.all([
    loadTeamPartsInfo(organization, null, today, mode), // half 미지정 → 현재 반기
    resolveCurrentWeekInfo(today),
    resolveCurrentWeekStartDate(today),
    // 상단 '운용 파트 수' SoT — [A] 선택 주차 요약과 **같은 함수·같은 주차(weekId 미지정=현재 주차)**.
    //   ⚠ 종전엔 currentMembershipPartsByTeam(현재 멤버십)으로 따로 셌다. 그래서 주차 override 로만
    //     배정된 파트가 상단에서만 빠져, 같은 화면의 [A] 와 숫자가 갈렸다
    //     (실측 2026-07-27: encre 비주얼랩(T) 상단 3 vs [A] 4 — override 전용 '테스트' 파트 누락).
    getTeamSelectedWeekSummary({ organization, teamName, weekId: null, mode, today }),
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
  // [A] 가 표시하는 목록의 길이 그대로 — 여기서 '일반' 제외 등 규칙을 재구현하지 않는다.
  const operatedPartCount = currentWeekSummary.operatedParts.length;

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
  mode: ScopeMode = "operating",
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

  return listHalfTeamsWithParts(organization, halfKey, mode, today);
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

// ─────────────────────────────────────────────────────────────────────
// 팀장 역할 lifecycle — "팀장 = role='team_leader' AND current_team_name=담당 팀" 결합 모델.
//   팀 리더 지정/교체/삭제 시 role+current_team_name 을 함께 정합(공용 applyMemberRolePosition 재사용).
//   · 승격 직전 포지션 {role,teamName,partName} = cluster4_team_halves.leader_previous_position(JSONB) 보존.
//   · 교체 흐름은 demote-before-promote(그 팀 유일성 슬롯 확보) — 이전 팀장 먼저 복원 후 새 팀장 승격.
//   · 이력/감사 = user_role_audit(기존 공식 SoT) 재사용. user_position_histories(주차·PMS)·user_memberships 미변경.
//   · 모드 무관 동일 경로. 컬럼(leader_previous_position) 미적용(마이그 전)이면 lifecycle 스킵(무회귀).
// ─────────────────────────────────────────────────────────────────────
const TEAM_LEADER_ROLE = "team_leader";

// 승격 직전 포지션 스냅샷(JSONB) — 정확 복원 소스. leader_previous_role(role만)의 확장.
type LeaderPositionSnapshot = { role: string | null; teamName: string | null; partName: string | null };

let leaderPrevPosColumnPresent = false;
async function hasLeaderPrevPositionColumn(): Promise<boolean> {
  if (leaderPrevPosColumnPresent) return true;
  const { error } = await supabaseAdmin
    .from("cluster4_team_halves")
    .select("leader_previous_position")
    .limit(1);
  const present = !(error && (error as { code?: string }).code === "42703");
  if (present) leaderPrevPosColumnPresent = true;
  return present;
}

// 유저의 현재 포지션 스냅샷(READ-ONLY) — 승격 전에 저장할 값.
async function readPositionSnapshot(userId: string): Promise<LeaderPositionSnapshot> {
  const { data } = await supabaseAdmin
    .from("user_profiles")
    .select("role,current_team_name,current_part_name")
    .eq("user_id", userId)
    .maybeSingle();
  const p = data as { role: string | null; current_team_name: string | null; current_part_name: string | null } | null;
  return { role: p?.role ?? null, teamName: p?.current_team_name ?? null, partName: p?.current_part_name ?? null };
}

// 이 팀 행의 저장된 leader_previous_position(복원 소스) 조회. 컬럼/행 부재 → null.
async function readLeaderPreviousPosition(teamHalfId: string): Promise<LeaderPositionSnapshot | null> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_team_halves")
    .select("leader_previous_position")
    .eq("id", teamHalfId)
    .maybeSingle();
  if (error) return null;
  return (data as { leader_previous_position: LeaderPositionSnapshot | null } | null)?.leader_previous_position ?? null;
}

async function leadsOtherActiveTeam(userId: string, excludeTeamHalfId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("cluster4_team_halves")
    .select("id")
    .eq("leader_user_id", userId)
    .eq("is_active", true)
    .neq("id", excludeTeamHalfId)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

// ── 현재 주차 override 동기화 ────────────────────────────────────────────
//   applyMemberRolePosition(→user_memberships)만으로는 부족하다. positionResolver 는
//   override(≤현재 주차 최신) 를 멤버십보다 **먼저** 본다(2026-07-22 SoT, [[project_team-week-
//   position-override-common-sot]]). 그런데 이 유저에게 "이 팀 승격/복원과 무관한" 과거 override
//   행이 이미 있으면(예: 다른 관리자가 예전에 파트만 편집해 둔 행), 그 옛 값이 carry-forward 로
//   계속 이겨서 방금 바꾼 멤버십이 화면에 반영되지 않는다(2026-08-07 실측: T김기연에게 2026-07-27
//   override 행이 있어, 승격 후에도 /api/admin/members 가 옛 팀·파트를 계속 보여줬다). 그래서
//   승격/복원 시 **현재 주차** override 도 함께 upsert 해 override 축과 멤버십 축을 같은 값으로
//   맞춘다 — 과거 주차 override/UPH 는 절대 건드리지 않는다(carry-forward 는 이 시점부터만).
async function upsertLeaderPositionOverride(params: {
  userId: string;
  organization: string;
  rawTeam: string | null;
  rawPart: string | null;
  positionCode: PositionCode | null;
  actorId: string | null;
}): Promise<string | null> {
  const { userId, organization, rawTeam, rawPart, positionCode, actorId } = params;
  if (!rawTeam || !positionCode) return null; // 복원 근거(팀/코드) 없으면 override 를 만들지 않는다.
  const weekStart = await resolveCurrentWeekStartDate(getCurrentActivityDateIso());
  if (!weekStart) return null; // 현재 주차를 못 찾으면(달력 갭) 손대지 않는다 — 무회귀.
  const { data: weekRow } = await supabaseAdmin.from("weeks").select("id").eq("start_date", weekStart).maybeSingle();
  const weekId = (weekRow as { id?: string } | null)?.id ?? null;
  const actor = actorId ?? "system:team-leader-lifecycle";
  // 같은 유저·같은 주차에 **다른** raw_team 으로 남아 있는 행(같은 주차 안에서 승격→복원처럼 팀이 두 번
  //   바뀐 경우)을 먼저 지운다. upsert 충돌 키가 raw_team 까지 포함해 그런 행은 새 값과 공존하는데,
  //   resolveOverrideAt 은 "그 유저의 ≤W 최신 1행"만 보므로 같은 주차에 행이 2개면 어느 게 이기는지
  //   DB 반환 순서에 좌우된다(비결정적) — 팀장은 한 시점에 팀이 하나뿐이라는 모델과도 맞지 않는다.
  const { error: cleanupError } = await supabaseAdmin
    .from("cluster4_team_week_position_overrides")
    .delete()
    .eq("user_id", userId)
    .eq("organization", organization)
    .eq("week_start_date", weekStart)
    .neq("raw_team", rawTeam);
  if (cleanupError) {
    console.warn("[adminTeamHalvesData] 같은 주차 중복 override 정리 실패", { userId, message: cleanupError.message });
  }
  const { error } = await supabaseAdmin.from("cluster4_team_week_position_overrides").upsert(
    {
      user_id: userId,
      organization,
      week_id: weekId,
      week_start_date: weekStart,
      raw_team: rawTeam,
      raw_part: rawPart,
      position_code: positionCode,
      created_by: actor,
      updated_by: actor,
    },
    { onConflict: "user_id,week_start_date,organization,raw_team" },
  );
  if (!error) return null;
  console.warn("[adminTeamHalvesData] 팀장 소속 override upsert 실패", { userId, organization, rawTeam, message: error.message });
  return `소속(팀/파트) 주차 반영 실패(${rawTeam}): ${error.message} (userId=${userId})`;
}

// snapshot.role(승격 전 role) + 현재 멤버십 등급으로 override position_code 를 역산한다.
//   team_leader/ambassador/club_leader 는 등급 무관(role 만으로 확정) — 나머지(crew)는 멤버십
//   등급(일반/심화)이 필요해 재조회한다(멤버십 자체는 이 lifecycle 이 건드리지 않은 값이라 안전).
async function resolveSnapshotPositionCode(userId: string, role: string | null): Promise<PositionCode | null> {
  if (!role) return null;
  const direct = roleLevelToPositionCode(role, null);
  if (direct) return direct;
  const { data } = await supabaseAdmin
    .from("user_memberships")
    .select("team_name,part_name,membership_level,is_current,updated_at")
    .eq("user_id", userId);
  const row = selectMembershipRow((data ?? []) as SelectableMembership[]);
  return roleLevelToPositionCode(role, row?.membership_level ?? null);
}

// 새 팀장 B 승격 — role='team_leader' + current_team_name=팀명(결합 모델). 공용 도메인 서비스 재사용.
//   유일성 충돌(예: 그 팀에 이미 팀장 — 교체 흐름에서 A 를 먼저 강등하지 않은 경우) 등은 note 로 보고.
async function promoteTeamLeader(
  userId: string,
  teamName: string,
  actorId: string | null,
  organization: string,
): Promise<string | null> {
  try {
    await applyMemberRolePosition({
      userId,
      role: TEAM_LEADER_ROLE,
      currentTeamName: teamName,
      currentPartName: null,
      actorId,
      reason: `team_leader_assign:${teamName}`,
    });
    // 팀장 = 파트 없음 정책 유지([[project_team-leader-no-part-policy]]) — rawPart 는 항상 null.
    const overrideNote = await upsertLeaderPositionOverride({
      userId,
      organization,
      rawTeam: teamName,
      rawPart: null,
      positionCode: "operating_team_leader",
      actorId,
    });
    await markWeeklyCardsSnapshotStaleMany([userId]).catch(() => {});
    return overrideNote;
  } catch (e) {
    if (e instanceof MemberPatchError) return `팀장 승격 보류(${teamName}): ${e.message} (userId=${userId})`;
    throw e;
  }
}

// 이전 팀장 A 복원 — 다른 active 팀 리더면 team_leader 유지, 아니면 snapshot({role,team,part})으로 정확 복원.
//   레거시(snapshot=null·복원 근거 없음) → 강등 안 함, note(수동 검토).
async function restoreFormerLeader(params: {
  userId: string | null;
  excludeTeamHalfId: string;
  snapshot: LeaderPositionSnapshot | null;
  actorId: string | null;
  teamLabel: string;
  organization: string;
}): Promise<string | null> {
  const { userId, excludeTeamHalfId, snapshot, actorId, teamLabel, organization } = params;
  if (!userId) return null;
  if (await leadsOtherActiveTeam(userId, excludeTeamHalfId)) return null; // 다른 팀 리더 → 유지.
  const cur = await readPositionSnapshot(userId);
  if (cur.role !== TEAM_LEADER_ROLE) return null; // 이미 팀장 아님 → 손대지 않음.
  if (!snapshot || snapshot.role == null) {
    // 레거시 — 복원 근거 없음. 임의 강등 금지(지시 F).
    return `팀장 해제(${teamLabel}): 이전 포지션 복원 근거 없음(레거시) → 수동 검토 필요 (userId=${userId})`;
  }
  try {
    await applyMemberRolePosition({
      userId,
      role: snapshot.role,
      currentTeamName: snapshot.teamName,
      currentPartName: snapshot.partName,
      actorId,
      reason: `team_leader_remove:${teamLabel}`,
    });
    // 승격 시 얹었던 현재 주차 override 를 원래 소속으로 되돌린다 — 안 하면 방금 강등했는데도
    //   override carry-forward 로 옛(승격 중이던) 팀이 미래 주차까지 계속 보인다.
    let overrideNote: string | null = null;
    if (snapshot.teamName) {
      const positionCode = await resolveSnapshotPositionCode(userId, snapshot.role);
      overrideNote = await upsertLeaderPositionOverride({
        userId,
        organization,
        rawTeam: snapshot.teamName,
        rawPart: snapshot.partName,
        positionCode,
        actorId,
      });
    }
    await markWeeklyCardsSnapshotStaleMany([userId]).catch(() => {});
    return overrideNote;
  } catch (e) {
    if (e instanceof MemberPatchError) return `팀장 해제 복원 보류(${teamLabel}): ${e.message} (userId=${userId})`;
    throw e;
  }
}

export async function registerTeamHalf(
  input: RegisterTeamInput,
  today?: string,
  mode: ScopeMode = "operating",
  actorId: string | null = null,
): Promise<{ teams: TeamHalfTeamDto[]; notes?: string[] }> {
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

  // 팀장 역할 lifecycle — 승격 직전 포지션 스냅샷을 halves 쓰기 전에 읽는다(read-only). 실제 role+team
  //   write 는 halves 저장 성공 후. 컬럼 미적용(마이그 전)이면 lifecycle 스킵(무회귀).
  const roleLifecycle = await hasLeaderPrevPositionColumn();
  const promoSnapshot = roleLifecycle ? await readPositionSnapshot(leaderUserId) : null;
  const prevPosField = roleLifecycle ? { leader_previous_position: promoSnapshot } : {};

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
        ...prevPosField,
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
        ...prevPosField,
      })
      .select("id")
      .single();
    if (error) throw new TeamHalfWriteError(500, error.message);
    teamHalfId = (inserted as { id: string }).id;
  }

  // 산하 "일반" 파트 자동 보장(idempotent) — 팀장 = 기본 파트장. 같은 흐름에서 함께 보장.
  await ensureGeneralPart(teamHalfId, leaderUserId);

  // halves 저장 성공 후 role='team_leader' + current_team_name=팀명 승격(부분 상태 방지). 신규 지정이라
  //   이전 팀장 강등 없음. 유일성 충돌 등은 note 로 보고(팀 등록 자체는 성공).
  const notes: string[] = [];
  if (roleLifecycle) {
    const note = await promoteTeamLeader(leaderUserId, teamName, actorId, organization);
    if (note) notes.push(note);
  }

  return { teams: await listHalfTeamsWithParts(organization, halfKey, mode, today), ...(notes.length ? { notes } : {}) };
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
  actorId: string | null = null,
): Promise<{ teams: TeamHalfTeamDto[]; notes?: string[] }> {
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

  // 팀장 역할 lifecycle 준비(halves 쓰기 전 read-only).
  const oldLeaderId = target.leader_user_id;
  const roleLifecycle = await hasLeaderPrevPositionColumn();
  const leaderChanged = roleLifecycle && !!oldLeaderId && oldLeaderId !== leaderUserId;
  const newLeaderSnapshot = roleLifecycle ? await readPositionSnapshot(leaderUserId) : null;
  const newLeaderAlreadyTL = newLeaderSnapshot?.role === TEAM_LEADER_ROLE;
  // leader_previous_position 은 리더가 바뀌었거나(새 리더 스냅샷 기록) 미승격 리더를 지금 승격할 때만
  //   갱신 — 변경 없는 재저장에서 기존 스냅샷을 team_leader 상태로 덮어쓰지 않는다.
  const prevPosField =
    roleLifecycle && (leaderChanged || !newLeaderAlreadyTL)
      ? { leader_previous_position: newLeaderSnapshot }
      : {};
  // 이전 팀장 A 복원용 스냅샷 — update 가 덮어쓰기 전에 읽는다.
  const oldSnapshot = leaderChanged ? await readLeaderPreviousPosition(teamHalfId) : null;

  const { error: updError } = await supabaseAdmin
    .from("cluster4_team_halves")
    .update({
      team_name: teamName,
      description,
      leader_user_id: leaderUserId,
      leader_crew_code: leaderCrewCode,
      team_id: teamId,
      ...prevPosField,
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

  // demote-before-promote: 교체면 이전 팀장 A 를 **먼저** 복원(그 팀 유일성 슬롯 확보) 후 새 팀장 B 승격.
  //   role 동기화 충돌 등은 note 로만 보고(팀 수정 자체는 성공).
  const notes: string[] = [];
  if (leaderChanged && oldLeaderId) {
    const note = await restoreFormerLeader({
      userId: oldLeaderId,
      excludeTeamHalfId: teamHalfId,
      snapshot: oldSnapshot,
      actorId,
      teamLabel: teamName,
      organization,
    });
    if (note) notes.push(note);
  }
  if (roleLifecycle) {
    const note = await promoteTeamLeader(leaderUserId, teamName, actorId, organization);
    if (note) notes.push(note);
  }

  return { teams: await listHalfTeamsWithParts(organization, halfKey, mode, today), ...(notes.length ? { notes } : {}) };
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
  actorId: string | null = null,
): Promise<{ teams: TeamHalfTeamDto[]; notes?: string[] }> {
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

  // 삭제 전에 복원 소스(previous position 스냅샷) 확보. 팀장 역할 lifecycle.
  const roleLifecycle = await hasLeaderPrevPositionColumn();
  const formerLeaderId = target.leader_user_id;
  const prevPos = roleLifecycle && formerLeaderId ? await readLeaderPreviousPosition(id) : null;

  if (target.is_active) {
    const { error } = await supabaseAdmin
      .from("cluster4_team_halves")
      .update({ is_active: false })
      .eq("id", id);
    if (error) throw new TeamHalfWriteError(500, error.message);
  }
  // 이미 비활성(중복 삭제 요청)이면 idempotent — 그대로 성공 처리.

  // 이전 팀장 복원 — 다른 active 팀 리더면 team_leader 유지, 아니면 snapshot 으로 복원(레거시면 보고).
  const notes: string[] = [];
  if (roleLifecycle && formerLeaderId && target.is_active) {
    const note = await restoreFormerLeader({
      userId: formerLeaderId,
      excludeTeamHalfId: id,
      snapshot: prevPos,
      actorId,
      teamLabel: target.team_name,
      organization: org,
    });
    if (note) notes.push(note);
  }

  return { teams: await listHalfTeamsWithParts(org, half, mode, today), ...(notes.length ? { notes } : {}) };
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

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  halfKeyToLastSeasonKey,
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

export type TeamHalfTeamDto = {
  teamHalfId: string; // cluster4_team_halves.id (수정/삭제·파트 카탈로그 키)
  teamName: string;
  teamId: string | null;
  displayOrder: number;
  isActive: boolean;
  description: string | null;
  leaderUserId: string | null;
  leaderCrewCode: string | null;
  // 팀장 기본정보(시안 box Row2) — user_profiles + 대표 학력. 품계/클래스는 box 미표시.
  leaderName: string | null;
  leaderBirth6: string | null; // YYMMDD
  leaderGender: string | null;
  leaderSchool: string | null;
  leaderMajor: string | null;
  leaderResidence: string | null;
  // 파트(현재 주차 기준) — 점유 파트 없으면 "일반"(min 1).
  partCount: number;
  partNames: string[];
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
  birth6: string | null;
  gender: string | null;
  residence: string | null;
  school: string | null;
  major: string | null;
};
async function getLeaderBasicsBatch(
  userIds: string[],
): Promise<Map<string, LeaderBasic>> {
  const out = new Map<string, LeaderBasic>();
  if (userIds.length === 0) return out;

  const { data: profs, error: pErr } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name,gender,birth_date,address,school_name,department_name")
    .in("user_id", userIds);
  if (pErr) throw new Error(pErr.message);

  const { data: edus, error: eErr } = await supabaseAdmin
    .from("user_educations")
    .select("user_id,school_name,major_name_1,is_primary,sort_order,updated_at")
    .in("user_id", userIds);
  if (eErr) throw new Error(eErr.message);

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
  }>) {
    const edu = eduByUser.get(p.user_id);
    out.set(p.user_id, {
      name: p.display_name,
      birth6: toBirth6(p.birth_date),
      gender: p.gender,
      residence: p.address,
      school: edu?.school ?? p.school_name ?? null,
      major: edu?.major ?? p.department_name ?? null,
    });
  }
  return out;
}

// 현재 주차 기준 팀별 파트 점유. 점유 파트(≥1명) 없으면 "일반"(min 1).
//   파트 SoT = user_memberships.part_name(현재·active). org 는 user_profiles 로 매칭.
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
      "id,team_name,team_id,display_order,is_active,description,leader_user_id,leader_crew_code",
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
    const lb = r.leader_user_id ? leaderBasics.get(r.leader_user_id) : null;
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
      leaderName: lb?.name ?? null,
      leaderBirth6: lb?.birth6 ?? null,
      leaderGender: lb?.gender ?? null,
      leaderSchool: lb?.school ?? null,
      leaderMajor: lb?.major ?? null,
      leaderResidence: lb?.residence ?? null,
      partCount: pi.partCount,
      partNames: pi.partNames,
    };
  });
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

  return {
    organization,
    currentHalfKey,
    selectedHalfKey: selected,
    editable,
    halves,
    teams,
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

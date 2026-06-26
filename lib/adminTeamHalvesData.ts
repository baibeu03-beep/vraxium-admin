import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  halfKeyToLastSeasonKey,
  halfLabel,
  isHalfKey,
  seasonKeyToHalfKey,
  compareHalfKeyDesc,
} from "@/lib/teamHalf";

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
  teamName: string;
  teamId: string | null;
  displayOrder: number;
  isActive: boolean;
};

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
  team_name: string;
  team_id: string | null;
  display_order: number;
  is_active: boolean;
};

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

// org 에 데이터가 존재하는 반기 목록(최신순) + 현재/편집 가능 플래그.
export async function listAvailableHalves(
  organization: string,
  currentHalfKey: string | null,
): Promise<HalfOptionDto[]> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_team_halves")
    .select("half_key")
    .eq("organization_slug", organization);

  if (error) throw new Error(error.message);

  const keys = Array.from(
    new Set(((data ?? []) as Array<{ half_key: string }>).map((r) => r.half_key)),
  ).sort(compareHalfKeyDesc);

  return keys.map((halfKey) => ({
    halfKey,
    label: halfLabel(halfKey),
    lastSeasonKey: halfKeyToLastSeasonKey(halfKey),
    isCurrent: halfKey === currentHalfKey,
    editable: halfKey === currentHalfKey,
  }));
}

// 특정 반기의 활성 팀 목록(노출 순).
export async function listHalfTeams(
  organization: string,
  halfKey: string,
): Promise<TeamHalfTeamDto[]> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_team_halves")
    .select("team_name,team_id,display_order,is_active")
    .eq("organization_slug", organization)
    .eq("half_key", halfKey)
    .eq("is_active", true)
    .order("display_order", { ascending: true });

  if (error) throw new Error(error.message);

  return ((data ?? []) as Row[]).map((r) => ({
    teamName: r.team_name,
    teamId: r.team_id,
    displayOrder: r.display_order,
    isActive: r.is_active,
  }));
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
  const editable = selected != null && selected === currentHalfKey;

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
  if (!currentHalfKey || halfKey !== currentHalfKey) {
    throw new TeamHalfWriteError(
      403,
      "현재 반기만 수정할 수 있습니다. 과거 반기는 조회 전용입니다.",
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

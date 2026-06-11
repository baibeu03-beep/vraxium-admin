// 실무 경험 파트장 입력 그리드 — 데이터 레이어(신규 전용 저장, standalone).
//
// cluster4_experience_part_submissions(헤더) + cluster4_experience_part_submission_cells(셀)만
// 읽고 쓴다. 기존 experience_drafts/검수/개설/snapshot 과 무연동(이번 phase 신청 저장/취소만).
//
// 크루/파트/상태는 user_profiles(role) + user_memberships(team_name/part_name/membership_level/state)
// 에서 resolve 한다. 상태 라벨은 memberStatusLabel 재사용. 평가 대상 = 일반/에이전트(파트장·팀장 제외).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { memberStatusLabel } from "@/lib/adminMembersTypes";
import {
  EXPERIENCE_PART_LINE_KEYS,
  type ExperiencePartLineType,
  type PartInputCellDto,
  type PartInputCrew,
  type PartOverallAggregate,
} from "@/lib/experiencePartInputTypes";

// ── 크루 행(팀 기준 enriched) ──

type TeamCrewRow = {
  userId: string;
  displayName: string;
  partName: string | null;
  role: string | null;
  membershipLevel: string | null;
  membershipState: string | null;
};

// 파트가 아닌 placeholder part_name(미배정 기본값). 등급 단어 '일반' 이 part_name 으로 새는 경우 등.
// 실제 파트만 노출하기 위해 파트 목록/크루 목록에서 제외한다.
const EXCLUDED_PART_NAMES = new Set<string>(["일반"]);

// 평가 대상 크루의 상태 라벨(일반/에이전트)만 반환. 파트장/팀장/기타는 null(목록 제외).
function crewDisplayStatus(
  role: string | null,
  membershipLevel: string | null,
): "일반" | "에이전트" | null {
  const label = memberStatusLabel(role, membershipLevel);
  if (label === "일반") return "일반";
  if (label === "심화(에이전트)") return "에이전트";
  return null;
}

// (org, teamName) 의 활동 크루 행 — user_profiles(role) + user_memberships(현재행) join.
async function loadTeamCrewRows(
  organization: string,
  teamName: string,
): Promise<TeamCrewRow[]> {
  let profileQuery = supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name,role")
    .order("display_name", { ascending: true });
  if (organization) {
    profileQuery = profileQuery.eq("organization_slug", organization);
  }
  const { data: profiles, error: profileError } = await profileQuery;
  if (profileError) throw new Error(profileError.message);
  const profs = (profiles ?? []) as Array<{
    user_id: string;
    display_name: string | null;
    role: string | null;
  }>;
  if (profs.length === 0) return [];

  const userIds = profs.map((p) => p.user_id);
  const { data: memberships, error: memError } = await supabaseAdmin
    .from("user_memberships")
    .select("user_id,team_name,part_name,membership_level,membership_state,is_current")
    .in("user_id", userIds);
  if (memError) throw new Error(memError.message);

  // 테스트 사용자 제외 — 운영 파트/크루 목록에 테스트 데이터(임의 팀/파트 배정)가 섞이지 않도록.
  const { data: markers } = await supabaseAdmin
    .from("test_user_markers")
    .select("user_id");
  const testSet = new Set(
    ((markers ?? []) as Array<{ user_id: string }>).map((m) => m.user_id),
  );

  type MemRow = {
    user_id: string;
    team_name: string | null;
    part_name: string | null;
    membership_level: string | null;
    membership_state: string | null;
    is_current: boolean | null;
  };
  const memMap = new Map<string, MemRow>();
  for (const m of (memberships ?? []) as MemRow[]) {
    const existing = memMap.get(m.user_id);
    if (!existing || (m.is_current && !existing.is_current)) memMap.set(m.user_id, m);
  }

  const rows: TeamCrewRow[] = [];
  for (const p of profs) {
    if (testSet.has(p.user_id)) continue; // 테스트 사용자 제외
    const m = memMap.get(p.user_id);
    if (!m || m.team_name !== teamName) continue;
    // 휴식 크루는 평가 대상에서 제외(active 만).
    if (m.membership_state === "rest") continue;
    // 실제 파트만(미배정/placeholder '일반' 제외).
    const part = m.part_name?.trim() ?? "";
    if (!part || EXCLUDED_PART_NAMES.has(part)) continue;
    rows.push({
      userId: p.user_id,
      displayName: p.display_name ?? "(이름 없음)",
      partName: m.part_name,
      role: p.role,
      membershipLevel: m.membership_level,
      membershipState: m.membership_state,
    });
  }
  return rows;
}

// ── Actor context (기본 팀탭/파트 결정) ──

export async function resolveActorContext(
  userId: string,
): Promise<{ role: string | null; teamName: string | null; partName: string | null }> {
  const { data: prof } = await supabaseAdmin
    .from("user_profiles")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();
  const { data: mems } = await supabaseAdmin
    .from("user_memberships")
    .select("team_name,part_name,is_current")
    .eq("user_id", userId);
  const rows = (mems ?? []) as Array<{
    team_name: string | null;
    part_name: string | null;
    is_current: boolean | null;
  }>;
  const chosen = rows.find((r) => r.is_current) ?? rows[0] ?? null;
  return {
    role: (prof as { role: string | null } | null)?.role ?? null,
    teamName: chosen?.team_name ?? null,
    partName: chosen?.part_name ?? null,
  };
}

// ── Parts / Crews ──

export async function listTeamParts(
  organization: string,
  teamName: string,
): Promise<string[]> {
  const rows = await loadTeamCrewRows(organization, teamName);
  const set = new Set<string>();
  for (const r of rows) if (r.partName) set.add(r.partName);
  return Array.from(set).sort();
}

export async function listPartCrews(
  organization: string,
  teamName: string,
  part: string,
): Promise<PartInputCrew[]> {
  const rows = await loadTeamCrewRows(organization, teamName);
  const out: PartInputCrew[] = [];
  for (const r of rows) {
    if (r.partName !== part) continue;
    const status = crewDisplayStatus(r.role, r.membershipLevel);
    if (!status) continue; // 파트장/팀장 등 제외
    out.push({
      userId: r.userId,
      displayName: r.displayName,
      partName: r.partName,
      statusLabel: status,
    });
  }
  return out;
}

// ── 신청 조회/저장/삭제 ──

async function findHeaderId(
  organization: string,
  weekId: string,
  teamId: string,
  part: string,
): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("cluster4_experience_part_submissions")
    .select("id")
    .eq("organization_slug", organization)
    .eq("week_id", weekId)
    .eq("team_id", teamId)
    .eq("part_name", part)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

async function fetchCells(submissionId: string): Promise<PartInputCellDto[]> {
  const { data } = await supabaseAdmin
    .from("cluster4_experience_part_submission_cells")
    .select("crew_user_id,line_type,checked,score")
    .eq("submission_id", submissionId);
  return ((data ?? []) as Array<{
    crew_user_id: string;
    line_type: ExperiencePartLineType;
    checked: boolean;
    score: number;
  }>).map((c) => ({
    crewUserId: c.crew_user_id,
    lineType: c.line_type,
    checked: c.checked,
    score: c.score,
  }));
}

export async function getPartSubmission(
  organization: string,
  weekId: string,
  teamId: string,
  part: string,
): Promise<{ submitted: boolean; cells: PartInputCellDto[] }> {
  const headerId = await findHeaderId(organization, weekId, teamId, part);
  if (!headerId) return { submitted: false, cells: [] };
  const cells = await fetchCells(headerId);
  return { submitted: true, cells };
}

// 팀 총괄 — 그 팀의 모든 파트 신청을 집계(읽기 전용).
export async function getTeamOverall(
  organization: string,
  weekId: string,
  teamId: string,
  teamName: string,
): Promise<PartOverallAggregate> {
  const { data: headers } = await supabaseAdmin
    .from("cluster4_experience_part_submissions")
    .select("id,part_name")
    .eq("organization_slug", organization)
    .eq("week_id", weekId)
    .eq("team_id", teamId);
  const headerRows = (headers ?? []) as Array<{ id: string; part_name: string }>;
  if (headerRows.length === 0) return { parts: [] };

  const headerIds = headerRows.map((h) => h.id);
  const { data: cellRows } = await supabaseAdmin
    .from("cluster4_experience_part_submission_cells")
    .select("submission_id,crew_user_id,line_type,checked,score")
    .in("submission_id", headerIds);
  const cells = (cellRows ?? []) as Array<{
    submission_id: string;
    crew_user_id: string;
    line_type: ExperiencePartLineType;
    checked: boolean;
    score: number;
  }>;

  // 크루 표시 정보(이름/상태) — 팀 단위 1회 조회 후 맵.
  const crewRows = await loadTeamCrewRows(organization, teamName);
  const crewMap = new Map(
    crewRows.map((r) => [
      r.userId,
      {
        displayName: r.displayName,
        statusLabel: crewDisplayStatus(r.role, r.membershipLevel) ?? "-",
      },
    ]),
  );

  const parts = headerRows
    .map((h) => {
      const partCells = cells.filter((c) => c.submission_id === h.id);
      const byCrew = new Map<string, PartInputCellDto[]>();
      for (const c of partCells) {
        const list = byCrew.get(c.crew_user_id) ?? [];
        list.push({
          crewUserId: c.crew_user_id,
          lineType: c.line_type,
          checked: c.checked,
          score: c.score,
        });
        byCrew.set(c.crew_user_id, list);
      }
      const crews = Array.from(byCrew.entries()).map(([userId, cs]) => {
        const info = crewMap.get(userId);
        return {
          userId,
          displayName: info?.displayName ?? "(이름 없음)",
          statusLabel: info?.statusLabel ?? "-",
          cells: cs,
        };
      });
      return { partName: h.part_name, crews };
    })
    .sort((a, b) => a.partName.localeCompare(b.partName));

  return { parts };
}

export async function savePartSubmission(input: {
  organization: string;
  weekId: string;
  teamId: string;
  part: string;
  submittedBy: string | null;
  cells: PartInputCellDto[];
}): Promise<{ submitted: true }> {
  // 1. 헤더 upsert(파트당 1행/주차) → id.
  const { data: header, error: headerError } = await supabaseAdmin
    .from("cluster4_experience_part_submissions")
    .upsert(
      {
        organization_slug: input.organization,
        week_id: input.weekId,
        team_id: input.teamId,
        part_name: input.part,
        submitted_by: input.submittedBy,
        submitted_at: new Date().toISOString(),
      },
      { onConflict: "organization_slug,week_id,team_id,part_name" },
    )
    .select("id")
    .single();
  if (headerError || !header) {
    throw new Error(headerError?.message ?? "신청 헤더 저장 실패");
  }
  const submissionId = (header as { id: string }).id;

  // 2. 셀 replace(기존 삭제 후 재삽입) — 유효 line_type 만.
  const { error: delError } = await supabaseAdmin
    .from("cluster4_experience_part_submission_cells")
    .delete()
    .eq("submission_id", submissionId);
  if (delError) throw new Error(delError.message);

  const valid = input.cells.filter((c) =>
    (EXPERIENCE_PART_LINE_KEYS as string[]).includes(c.lineType),
  );
  if (valid.length > 0) {
    const { error: insError } = await supabaseAdmin
      .from("cluster4_experience_part_submission_cells")
      .insert(
        valid.map((c) => ({
          submission_id: submissionId,
          crew_user_id: c.crewUserId,
          line_type: c.lineType,
          checked: c.checked,
          score: Math.max(0, Math.min(10, Math.round(c.score))),
        })),
      );
    if (insError) throw new Error(insError.message);
  }

  return { submitted: true };
}

export async function deletePartSubmission(
  organization: string,
  weekId: string,
  teamId: string,
  part: string,
): Promise<{ submitted: false }> {
  // 헤더 삭제 → 셀 CASCADE.
  const { error } = await supabaseAdmin
    .from("cluster4_experience_part_submissions")
    .delete()
    .eq("organization_slug", organization)
    .eq("week_id", weekId)
    .eq("team_id", teamId)
    .eq("part_name", part);
  if (error) throw new Error(error.message);
  return { submitted: false };
}

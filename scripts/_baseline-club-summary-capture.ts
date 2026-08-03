import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadCurrentWeekOverrideLabels } from "@/lib/positionResolver";
import { ORGANIZATIONS, organizationLabelKo, type OrganizationSlug } from "@/lib/organizations";
import { SUPER_ADMIN_EXCLUDE_OR } from "@/lib/superAdmins";
import { resolveUserScope } from "@/lib/userScope";
import { memberStatusLabel } from "@/lib/adminMembersTypes";
import type { ScopeMode } from "@/lib/userScopeShared";
import { loadClubCurrentSummary } from "@/lib/adminClubSummaryData";
import { loadTeamPartsInfo } from "@/lib/adminTeamHalvesData";
import { writeFileSync } from "node:fs";

// 반기 기능 구현 전 baseline 캡처 — 현재(운영 모드) 화면이 실제로 보여주는 숫자 +
// 각 버킷을 구성하는 사용자 ID 집합을 함께 저장한다. buildClubRoleCounts(비공개 함수)의
// 로직을 그대로 재현해 userId 단위까지 기록한다(숫자만 같고 구성원이 바뀌는 회귀 탐지용).

type Bucket =
  | "teamLeader"
  | "ambassador"
  | "regularCrew"
  | "partLeader"
  | "agent";

async function buildClubRoleCountsWithIds(
  organization: OrganizationSlug,
  mode: ScopeMode,
): Promise<Record<Bucket, string[]>> {
  const { data: profs, error: pErr } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,role")
    .eq("organization_slug", organization)
    .or(SUPER_ADMIN_EXCLUDE_OR);
  if (pErr) throw new Error(pErr.message);

  const scope = await resolveUserScope(mode, null);
  const roster = ((profs ?? []) as Array<{ user_id: string; role: string | null }>).filter(
    (p) => scope.includes(p.user_id),
  );

  const levelByUser = new Map<string, string | null>();
  const uids = roster.map((r) => r.user_id);
  for (let i = 0; i < uids.length; i += 100) {
    const chunk = uids.slice(i, i + 100);
    if (chunk.length === 0) break;
    const { data: mems, error: mErr } = await supabaseAdmin
      .from("user_memberships")
      .select("user_id,membership_level,is_current")
      .in("user_id", chunk);
    if (mErr) throw new Error(mErr.message);
    for (const m of (mems ?? []) as Array<{
      user_id: string;
      membership_level: string | null;
      is_current: boolean | null;
    }>) {
      if (!levelByUser.has(m.user_id) || m.is_current)
        levelByUser.set(m.user_id, m.membership_level);
    }
  }

  const buckets: Record<Bucket, string[]> = {
    teamLeader: [],
    ambassador: [],
    regularCrew: [],
    partLeader: [],
    agent: [],
  };
  const weekOverrides = await loadCurrentWeekOverrideLabels(roster.map((r) => r.user_id), organization);
  for (const r of roster) {
    const label =
      weekOverrides.get(r.user_id)?.statusLabel ??
      memberStatusLabel(r.role, levelByUser.get(r.user_id) ?? null);
    switch (label) {
      case "팀장":
        buckets.teamLeader.push(r.user_id);
        break;
      case "앰배서더":
        buckets.ambassador.push(r.user_id);
        break;
      case "심화(파트장)":
        buckets.partLeader.push(r.user_id);
        break;
      case "심화(에이전트)":
        buckets.agent.push(r.user_id);
        break;
      case "일반":
      case "크루":
        buckets.regularCrew.push(r.user_id);
        break;
      default:
        break;
    }
  }
  for (const k of Object.keys(buckets) as Bucket[]) buckets[k].sort();
  return buckets;
}

async function main() {
  const mode: ScopeMode = "operating";
  const summary = await loadClubCurrentSummary({ mode, orgs: [...ORGANIZATIONS] });

  const idsByOrg: Record<string, Record<Bucket, string[]>> = {};
  for (const org of ORGANIZATIONS) {
    idsByOrg[org] = await buildClubRoleCountsWithIds(org, mode);
  }

  const teamsByOrg: Record<string, unknown> = {};
  for (const org of ORGANIZATIONS) {
    const dto = await loadTeamPartsInfo(org, null, undefined, mode);
    teamsByOrg[org] = {
      currentHalfKey: dto.currentHalfKey,
      selectedHalfKey: dto.selectedHalfKey,
      teams: dto.teams.map((t) => ({
        teamName: t.teamName,
        leaderCrewCode: t.leaderCrewCode,
        partCount: t.partCount,
        partNames: t.partNames,
      })),
    };
  }

  const out = {
    capturedAt: "baseline-pre-implementation",
    orgLabels: Object.fromEntries(ORGANIZATIONS.map((o) => [o, organizationLabelKo(o)])),
    summary,
    idsByOrg,
    teamsByOrg,
  };

  const path = "scripts/_baseline-club-summary-before.json";
  writeFileSync(path, JSON.stringify(out, null, 2), "utf-8");
  console.log("baseline 저장 완료:", path);
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

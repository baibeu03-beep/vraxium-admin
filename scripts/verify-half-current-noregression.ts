// 구현 전 baseline(scripts/_baseline-club-summary-before.json) 대 구현 후 결과를 비교한다.
// 숫자뿐 아니라 각 버킷을 구성하는 사용자 ID 집합까지 비교(요구: 우연히 숫자만 같은 회귀 탐지).
import { readFileSync } from "node:fs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadCurrentWeekOverrideLabels } from "@/lib/positionResolver";
import { ORGANIZATIONS, type OrganizationSlug } from "@/lib/organizations";
import { SUPER_ADMIN_EXCLUDE_OR } from "@/lib/superAdmins";
import { resolveUserScope } from "@/lib/userScope";
import { memberStatusLabel } from "@/lib/adminMembersTypes";
import type { ScopeMode } from "@/lib/userScopeShared";
import { loadClubCurrentSummary } from "@/lib/adminClubSummaryData";
import { loadTeamPartsInfo } from "@/lib/adminTeamHalvesData";
import { resolveHalfPeriod } from "@/lib/halfPeriod";

type Bucket = "teamLeader" | "ambassador" | "regularCrew" | "partLeader" | "agent";

async function currentIdsByOrg(
  organization: OrganizationSlug,
  mode: ScopeMode,
): Promise<Record<Bucket, string[]>> {
  const { data: profs } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,role")
    .eq("organization_slug", organization)
    .or(SUPER_ADMIN_EXCLUDE_OR);
  const scope = await resolveUserScope(mode, null);
  const roster = ((profs ?? []) as Array<{ user_id: string; role: string | null }>).filter((p) =>
    scope.includes(p.user_id),
  );
  const levelByUser = new Map<string, string | null>();
  const uids = roster.map((r) => r.user_id);
  for (let i = 0; i < uids.length; i += 100) {
    const chunk = uids.slice(i, i + 100);
    if (chunk.length === 0) break;
    const { data: mems } = await supabaseAdmin
      .from("user_memberships")
      .select("user_id,membership_level,is_current")
      .in("user_id", chunk);
    for (const m of (mems ?? []) as Array<{ user_id: string; membership_level: string | null; is_current: boolean | null }>) {
      if (!levelByUser.has(m.user_id) || m.is_current) levelByUser.set(m.user_id, m.membership_level);
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
    const label = weekOverrides.get(r.user_id)?.statusLabel ?? memberStatusLabel(r.role, levelByUser.get(r.user_id) ?? null);
    switch (label) {
      case "팀장": buckets.teamLeader.push(r.user_id); break;
      case "앰배서더": buckets.ambassador.push(r.user_id); break;
      case "심화(파트장)": buckets.partLeader.push(r.user_id); break;
      case "심화(에이전트)": buckets.agent.push(r.user_id); break;
      case "일반": case "크루": buckets.regularCrew.push(r.user_id); break;
      default: break;
    }
  }
  for (const k of Object.keys(buckets) as Bucket[]) buckets[k].sort();
  return buckets;
}

function sameArray(a: string[], b: string[]): boolean {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

async function main() {
  const baseline = JSON.parse(readFileSync("scripts/_baseline-club-summary-before.json", "utf-8"));
  const mode: ScopeMode = "operating";
  let failures = 0;

  // 1) asOf 주차가 is_current_week 과 일치하는지.
  const period = await resolveHalfPeriod({ halfKey: "2026-H2" }); // baseline 캡처 시점 halfKey
  console.log("현재 반기 period:", JSON.stringify(period));
  if (!period.isCurrentHalf || period.rosterSource !== "live" || period.structureSource !== "live") {
    console.log("FAIL 현재 반기가 live/live 가 아님");
    failures++;
  } else {
    console.log("OK   현재 반기 = live/live");
  }

  // 2) loadClubCurrentSummary(halfKey 미지정) 숫자가 baseline 과 완전히 같은지.
  const after = await loadClubCurrentSummary({ mode });
  const beforeSummary = baseline.summary;
  const numKeys = [
    "staffCount","teamLeaderCount","teamEntityCount","ambassadorCount","clubbingCount",
    "regularCrewCount","advancedCrewCount","partCount","partLeaderCount","agentCount",
  ] as const;
  for (const org of ORGANIZATIONS) {
    const b = beforeSummary.rows.find((r: { clubId: string }) => r.clubId === org);
    const a = after.rows.find((r) => r.clubId === org);
    for (const k of numKeys) {
      const ok = b[k] === a?.[k];
      console.log(`${ok ? "OK  " : "FAIL"} rows.${org}.${k} before=${b[k]} after=${a?.[k]}`);
      if (!ok) failures++;
    }
  }
  for (const k of numKeys) {
    const ok = beforeSummary.totals[k] === after.totals[k];
    console.log(`${ok ? "OK  " : "FAIL"} totals.${k} before=${beforeSummary.totals[k]} after=${after.totals[k]}`);
    if (!ok) failures++;
  }
  {
    const ok = JSON.stringify(beforeSummary.structureTotals) === JSON.stringify(after.structureTotals);
    console.log(`${ok ? "OK  " : "FAIL"} structureTotals before=${JSON.stringify(beforeSummary.structureTotals)} after=${JSON.stringify(after.structureTotals)}`);
    if (!ok) failures++;
  }

  // 3) 버킷별 사용자 ID 집합까지 비교(숫자만 같고 구성원이 바뀌는 회귀 탐지).
  for (const org of ORGANIZATIONS) {
    const beforeIds = baseline.idsByOrg[org] as Record<Bucket, string[]>;
    const afterIds = await currentIdsByOrg(org, mode);
    for (const bucket of Object.keys(beforeIds) as Bucket[]) {
      const ok = sameArray(beforeIds[bucket], afterIds[bucket]);
      console.log(`${ok ? "OK  " : "FAIL"} ids.${org}.${bucket} before=${beforeIds[bucket].length}명 after=${afterIds[bucket].length}명`);
      if (!ok) {
        failures++;
        console.log("  before:", beforeIds[bucket]);
        console.log("  after :", afterIds[bucket]);
      }
    }
  }

  // 4) 팀·파트 구성(팀명/파트) baseline 과 동일한지.
  for (const org of ORGANIZATIONS) {
    const dto = await loadTeamPartsInfo(org, null, undefined, mode);
    const beforeTeams = baseline.teamsByOrg[org].teams;
    const afterTeams = dto.teams.map((t) => ({
      teamName: t.teamName,
      leaderCrewCode: t.leaderCrewCode,
      partCount: t.partCount,
      partNames: t.partNames,
    }));
    const ok = JSON.stringify(beforeTeams) === JSON.stringify(afterTeams);
    console.log(`${ok ? "OK  " : "FAIL"} teams.${org} (팀명/파트 구성)`);
    if (!ok) {
      failures++;
      console.log("  before:", JSON.stringify(beforeTeams));
      console.log("  after :", JSON.stringify(afterTeams));
    }
  }

  console.log(`\n${failures === 0 ? "✅ 현재 반기 무회귀 확인 — baseline 과 완전 일치" : `❌ ${failures}건 불일치 — 원인 규명 필요`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

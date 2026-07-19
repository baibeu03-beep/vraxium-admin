// Current-code reconciliation for T강민지 experience statuses (W2).
//   각 status: roster(현재코드) · matched · performers∩ · unselected · 저장원장 비교.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveCheckScopeRoster } from "@/lib/processCheckScopeRoster";
import { listTeamCrews, listPartCrews } from "@/lib/adminExperiencePartInput";
import { previewRegularAccrual } from "@/lib/processPointAccrual";

const TARGET = "00b75923-2109-4214-806a-37667d64ac5e"; // T강민지
const ORG = "phalanx";
const MODE = "test" as const;

function has(ids: string[] | Set<string>, id: string) {
  return ids instanceof Set ? ids.has(id) : ids.includes(id);
}

async function matchedIds(refId: string): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from("process_check_review_recipients")
    .select("user_id")
    .eq("source", "regular").eq("ref_id", refId).eq("match_type", "matched");
  return [...new Set(((data ?? []) as { user_id: string | null }[]).map((r) => r.user_id).filter((x): x is string => !!x))];
}
async function ledgerFor(refId: string): Promise<Array<{ user_id: string; a: number; b: number; c: number; cancelled: boolean }>> {
  const { data } = await supabaseAdmin
    .from("process_point_awards")
    .select("user_id,point_check,point_advantage,point_penalty,cancelled_at")
    .eq("source", "regular").eq("ref_id", refId);
  return ((data ?? []) as any[]).map((r) => ({ user_id: r.user_id, a: r.point_check, b: r.point_advantage, c: r.point_penalty, cancelled: !!r.cancelled_at }));
}
async function teamName(teamId: string): Promise<string | null> {
  const { data } = await supabaseAdmin.from("cluster4_teams").select("team_name").eq("id", teamId).maybeSingle();
  return (data as { team_name: string } | null)?.team_name ?? null;
}

const STATUSES: Array<{ id: string; label: string; teamId: string; part: string | null; created: string }> = [
  { id: "a4fae98a-e026-4639-8e21-ff01299837a3", label: "[브리핑] 팀 시작 (팀총괄)", teamId: "13e60f37-152c-4e53-8d65-f633cc48d81c", part: null, created: "07-13 05:12" },
  { id: "29ad0ece-dae5-4c5d-a380-245eed279a60", label: "[브리핑] 파트 시작 (part=응대·본인파트)", teamId: "13e60f37-152c-4e53-8d65-f633cc48d81c", part: "응대", created: "07-13 05:18" },
  { id: "aa79f2a2-aad7-4215-bc50-ff0050048432", label: "[브리핑] 파트 시작 (part=정책·타파트)", teamId: "13e60f37-152c-4e53-8d65-f633cc48d81c", part: "정책", created: "07-13 05:34" },
  { id: "6d770d44-9f69-492a-b94f-fdc569c4d15c", label: "[브리핑] 가이드 적용 (팀총괄·본인팀)", teamId: "13e60f37-152c-4e53-8d65-f633cc48d81c", part: null, created: "07-15 06:12" },
];

async function main() {
  const tName = await teamName("13e60f37-152c-4e53-8d65-f633cc48d81c");
  console.log(`team 13e60f37 = "${tName}"`);

  // 현재코드: 본인이 팀/파트 로스터에 포함되는가?
  const teamCrews = await listTeamCrews(ORG, tName!, MODE);
  const partCrewsResp = await listPartCrews(ORG, tName!, "응대", MODE);
  const partCrewsJeongchaek = await listPartCrews(ORG, tName!, "정책", MODE);
  console.log(`\nlistTeamCrews("${tName}") count=${teamCrews.length} · target included=${teamCrews.some((c) => c.userId === TARGET)}`);
  console.log(`listPartCrews("응대") count=${partCrewsResp.length} · target included=${partCrewsResp.some((c) => c.userId === TARGET)}`);
  console.log(`listPartCrews("정책") count=${partCrewsJeongchaek.length} · target included=${partCrewsJeongchaek.some((c) => c.userId === TARGET)}`);
  console.log(`(target=T강민지 role=part_leader, part=응대)`);

  for (const s of STATUSES) {
    console.log(`\n──────────────────────────────────────────────`);
    console.log(`STATUS ${s.id}\n  ${s.label}  created=${s.created}`);
    const roster = await resolveCheckScopeRoster({ hub: "experience", organization: ORG as any, mode: MODE, teamId: s.teamId, partName: s.part });
    const matched = await matchedIds(s.id);
    const rosterSet = new Set(roster);
    const performers = matched.filter((id) => rosterSet.has(id)); // teamScoped intersection
    const unselected = roster.filter((id) => !new Set(performers).has(id));
    const ledger = await ledgerFor(s.id);
    const ledgerTarget = ledger.find((l) => l.user_id === TARGET);

    console.log(`  roster(현재코드) count=${roster.length}  target∈roster=${has(rosterSet, TARGET)}`);
    console.log(`  matched(cafe) count=${matched.length}  target∈matched=${matched.includes(TARGET)}`);
    console.log(`  → CURRENT desired: target∈performers=${performers.includes(TARGET)}  target∈unselected=${unselected.includes(TARGET)}`);
    console.log(`  STORED ledger: target row = ${ledgerTarget ? `A=${ledgerTarget.a} B=${ledgerTarget.b} C=${ledgerTarget.c} cancelled=${ledgerTarget.cancelled}` : "NONE"}`);
    // preview (current-code planned counts)
    const prev = await previewRegularAccrual(s.id);
    if ("skipped" in prev && prev.skipped) console.log(`  preview: SKIPPED (${prev.reason})`);
    else if (!("skipped" in prev) || !prev.skipped) {
      const p = prev as any;
      console.log(`  preview: rosterCount=${p.rosterCount} performerCount=${p.performerCount} unselectedCount=${p.unselectedCount} eraAllowed=${p.eraAllowed} pen=${p.pointPenalty}`);
    }
    const currentWants = performers.includes(TARGET) || unselected.includes(TARGET);
    const storedHas = !!ledgerTarget && !ledgerTarget.cancelled;
    console.log(`  >>> VERDICT: current-code wants target=${currentWants} · stored has target=${storedHas} · ${currentWants === storedHas ? "CONSISTENT" : "**DRIFT**"}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

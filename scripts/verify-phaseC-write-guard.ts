// 검증(READ-ONLY 위주) — Phase C: 임퍼소네이션 서버 write 가드.
//   npx tsx --env-file=.env.local scripts/verify-phaseC-write-guard.ts
// assertImpersonationCapability 진리표(순수, write 0) + resolveTeamNameById + 비활성 폴백.
// 실제 lib write 는 호출하지 않음(가드는 route 단계에서 lib 앞에 위치 → 순수 함수 검증으로 충분).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { resolveActorContext } from "@/lib/adminExperiencePartInput";
import {
  assertImpersonationCapability,
  resolveTeamNameById,
  type ImpersonationActor,
  type ExperienceWriteAction,
} from "@/lib/experienceImpersonation";
import { memberStatusLabel } from "@/lib/adminMembersTypes";

let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

// active=true 가드가 throw(403) 하는지.
function expectDeny(label: string, actor: ImpersonationActor, action: ExperienceWriteAction, targetTeam: string | null, targetPart?: string | null) {
  try {
    assertImpersonationCapability({ active: true, actor, action, targetTeamName: targetTeam, targetPart });
    ck(label, false, "허용됨(차단 기대)");
  } catch (e) {
    ck(label, (e as { status?: number }).status === 403, `403: ${(e as Error).message.slice(0, 40)}`);
  }
}
function expectAllow(label: string, actor: ImpersonationActor, action: ExperienceWriteAction, targetTeam: string | null, targetPart?: string | null) {
  try {
    assertImpersonationCapability({ active: true, actor, action, targetTeamName: targetTeam, targetPart });
    ck(label, true);
  } catch (e) {
    ck(label, false, `차단됨: ${(e as Error).message}`);
  }
}

async function findByRole(want: "team_leader" | "part_leader" | "agent") {
  const ids = [...(await fetchTestUserMarkerIds())];
  const { data: profs } = await supabaseAdmin.from("user_profiles").select("user_id,role").in("user_id", ids);
  const roleById = new Map(((profs ?? []) as any[]).map((p) => [p.user_id, p.role]));
  const { data: mems } = await supabaseAdmin.from("user_memberships").select("user_id,team_name,part_name,membership_level,is_current").in("user_id", ids);
  const cur = new Map<string, any>();
  for (const m of (mems ?? []) as any[]) { const e = cur.get(m.user_id); if (!e || (m.is_current && !e.is_current)) cur.set(m.user_id, m); }
  for (const id of ids) {
    const m = cur.get(id); if (!m) continue;
    const label = memberStatusLabel(roleById.get(id) ?? null, m.membership_level);
    const r = label === "팀장" ? "team_leader" : label === "심화(파트장)" ? "part_leader" : label === "심화(에이전트)" ? "agent" : "member";
    if (r === want) return { userId: id, team: m.team_name as string, part: m.part_name as string };
  }
  return null;
}

async function main() {
  const pl = await findByRole("part_leader");
  const ag = await findByRole("agent");
  const tl = await findByRole("team_leader");
  const OTHER = "다른팀(T)"; // 자기 팀과 다른 임의 팀명

  // ── part_leader ──
  if (pl) {
    const actor = await resolveActorContext(pl.userId);
    const a: ImpersonationActor = { memberRole: actor.memberRole, teamName: actor.teamName, partName: actor.partName };
    ck("[part_leader] actor 해석", a.memberRole === "part_leader", `${a.teamName}/${a.partName}`);
    expectAllow("[part_leader] 자기 팀+자기 파트 part_save 허용", a, "part_save", a.teamName, a.partName);
    expectDeny("[part_leader] 자기 팀+다른 파트 part_save → 403", a, "part_save", a.teamName, "__다른파트__");
    expectDeny("[part_leader] 다른 팀 part_save → 403", a, "part_save", OTHER, a.partName);
    expectDeny("[part_leader] open → 403", a, "open", a.teamName);
    expectDeny("[part_leader] review → 403", a, "review", a.teamName);
  }

  // ── team_leader ──
  if (tl) {
    const actor = await resolveActorContext(tl.userId);
    const a: ImpersonationActor = { memberRole: actor.memberRole, teamName: actor.teamName, partName: actor.partName };
    ck("[team_leader] actor 해석", a.memberRole === "team_leader", `${a.teamName}`);
    expectAllow("[team_leader] 자기 팀 open 허용", a, "open", a.teamName);
    expectAllow("[team_leader] 자기 팀 review 허용", a, "review", a.teamName);
    expectAllow("[team_leader] 자기 팀 part_save 허용", a, "part_save", a.teamName, "아무파트");
    expectDeny("[team_leader] 다른 팀 open → 403", a, "open", OTHER);
  }

  // ── agent ──
  if (ag) {
    const actor = await resolveActorContext(ag.userId);
    const a: ImpersonationActor = { memberRole: actor.memberRole, teamName: actor.teamName, partName: actor.partName };
    ck("[agent] actor 해석", a.memberRole === "agent", `${a.teamName}`);
    expectAllow("[agent] 자기 팀 review 허용", a, "review", a.teamName);
    expectDeny("[agent] 다른 팀 review → 403", a, "review", OTHER);
    expectDeny("[agent] open → 403", a, "open", a.teamName);
    expectDeny("[agent] part_save → 403", a, "part_save", a.teamName, "아무파트");
  }

  // ── 비활성(owner/admin) → 가드 미적용(통과) ──
  {
    const a: ImpersonationActor = { memberRole: "member", teamName: null, partName: null };
    try {
      assertImpersonationCapability({ active: false, actor: a, action: "open", targetTeamName: "아무팀" });
      ck("[owner/admin] active=false → 가드 미적용(통과)", true);
    } catch { ck("[owner/admin] active=false → 가드 미적용(통과)", false); }
  }

  // ── resolveTeamNameById 권위 해석 ──
  if (pl) {
    const { data: tRow } = await supabaseAdmin.from("cluster4_teams").select("id").eq("team_name", pl.team).maybeSingle();
    const teamId = (tRow as { id: string } | null)?.id ?? "";
    const resolved = await resolveTeamNameById(teamId);
    ck("[resolveTeamNameById] team_id → 권위 팀명", resolved === pl.team, `${resolved}`);
    ck("[resolveTeamNameById] 미존재 id → null(fail-closed)", (await resolveTeamNameById("00000000-0000-0000-0000-000000000000")) === null);
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

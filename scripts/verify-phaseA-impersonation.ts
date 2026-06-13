// 검증(READ-ONLY) — Phase A: 테스트 유저 임퍼소네이션 기반(actor 치환).
//   npx tsx --env-file=.env.local scripts/verify-phaseA-impersonation.ts
// DB write 0. snapshot 무접촉. resolveImpersonation/resolveEffectiveActorUserId + resolveActorContext.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { resolveActorContext } from "@/lib/adminExperiencePartInput";
import {
  resolveImpersonation,
  resolveEffectiveActorUserId,
} from "@/lib/experienceImpersonation";
import { memberStatusLabel } from "@/lib/adminMembersTypes";

const ADMIN_ID = "00000000-0000-0000-0000-0000000admin1"; // 더미 admin id(임퍼 비활성 폴백 확인용)
let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

// 테스트 유저 중 특정 memberRole 1명 찾기.
async function findTestUserByRole(want: "team_leader" | "part_leader" | "agent") {
  const testIds = [...(await fetchTestUserMarkerIds())];
  const { data: profs } = await supabaseAdmin
    .from("user_profiles").select("user_id,role").in("user_id", testIds);
  const roleById = new Map(((profs ?? []) as { user_id: string; role: string | null }[]).map((p) => [p.user_id, p.role]));
  const { data: mems } = await supabaseAdmin
    .from("user_memberships").select("user_id,team_name,part_name,membership_level,is_current").in("user_id", testIds);
  const cur = new Map<string, any>();
  for (const m of (mems ?? []) as any[]) { const e = cur.get(m.user_id); if (!e || (m.is_current && !e.is_current)) cur.set(m.user_id, m); }
  for (const id of testIds) {
    const m = cur.get(id); if (!m) continue;
    const label = memberStatusLabel(roleById.get(id) ?? null, m.membership_level);
    const role = label === "팀장" ? "team_leader" : label === "심화(파트장)" ? "part_leader" : label === "심화(에이전트)" ? "agent" : "member";
    if (role === want) return { userId: id, team: m.team_name, part: m.part_name };
  }
  return null;
}

async function main() {
  const testSet = await fetchTestUserMarkerIds();

  // ── part_leader actAs (mode=test) → actor team/part/role 정확 ──
  const pl = await findTestUserByRole("part_leader");
  if (pl) {
    const imp = await resolveImpersonation({ mode: "test", actAsTestUserId: pl.userId });
    ck("[part_leader] resolveImpersonation active", imp.active && imp.userId === pl.userId, imp.reason);
    const actor = await resolveActorContext(pl.userId);
    ck("[part_leader] actor.memberRole=part_leader", actor.memberRole === "part_leader", `role=${actor.memberRole}`);
    ck("[part_leader] actor.team/part 정확", actor.teamName === pl.team && actor.partName === pl.part, `${actor.teamName}/${actor.partName}`);
  } else ck("[part_leader] 표본 존재", false, "테스트 part_leader 없음");

  // ── agent actAs → role 정확 ──
  const ag = await findTestUserByRole("agent");
  if (ag) {
    const actor = await resolveActorContext(ag.userId);
    ck("[agent] actor.memberRole=agent", actor.memberRole === "agent", `role=${actor.memberRole} team=${actor.teamName}`);
  } else ck("[agent] 표본 존재", false, "테스트 agent 없음");

  // ── team_leader actAs → team 정확 ──
  const tl = await findTestUserByRole("team_leader");
  if (tl) {
    const actor = await resolveActorContext(tl.userId);
    ck("[team_leader] actor.memberRole=team_leader", actor.memberRole === "team_leader", `role=${actor.memberRole}`);
    ck("[team_leader] actor.team 정확", actor.teamName === tl.team, `${actor.teamName}`);
  } else ck("[team_leader] 표본 존재", false, "테스트 team_leader 없음");

  // ── 실사용자 actAs → 비활성 ──
  const { data: realProf } = await supabaseAdmin.from("user_profiles").select("user_id").eq("organization_slug", "oranke").limit(400);
  const realId = ((realProf ?? []) as { user_id: string }[]).map((r) => r.user_id).find((id) => !testSet.has(id)) ?? null;
  if (realId) {
    const imp = await resolveImpersonation({ mode: "test", actAsTestUserId: realId });
    ck("[실사용자] actAs 비활성(거부)", imp.active === false, imp.reason);
    const eff = await resolveEffectiveActorUserId(ADMIN_ID, { mode: "test", actAsTestUserId: realId });
    ck("[실사용자] effective=admin 폴백(임퍼 안 됨)", eff.effectiveUserId === ADMIN_ID && !eff.impersonation.active);
  } else ck("[실사용자] 표본 존재", false);

  // ── operating 모드 + 테스트 유저 actAs → 비활성 ──
  if (pl) {
    const imp = await resolveImpersonation({ mode: "operating", actAsTestUserId: pl.userId });
    ck("[operating] actAs 비활성(무시)", imp.active === false, imp.reason);
    const eff = await resolveEffectiveActorUserId(ADMIN_ID, { mode: "operating", actAsTestUserId: pl.userId });
    ck("[operating] effective=admin 폴백", eff.effectiveUserId === ADMIN_ID);
  }

  // ── 빈 actAs → 비활성 ──
  const none = await resolveImpersonation({ mode: "test", actAsTestUserId: null });
  ck("[빈값] actAs 없음 → 비활성", none.active === false, none.reason);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

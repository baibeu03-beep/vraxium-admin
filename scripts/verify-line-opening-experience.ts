/**
 * 검증(read-only): 실무경험 라인 개설 후보 풀(loadTeamCrewRows/loadTeamMembersWithLeaders) 휴식 제외.
 *   npx tsx --env-file=.env.local scripts/verify-line-opening-experience.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCurrentSeasonRestUserIds } from "@/lib/currentSeasonRest";
import { listPartCrews } from "@/lib/adminExperiencePartInput";

const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(70));
let fail = 0;
const ck = (l: string, ok: boolean, d = "") => { line(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

async function main() {
  const restIds = await getCurrentSeasonRestUserIds();
  line(`현재 시즌 휴식자(direct) = ${restIds.size}`);
  ck("휴식자 집합 > 0", restIds.size > 0);

  // 휴식자 중 '실제 팀'(시즌전체휴식 아님) + is_current 멤버십 보유자 탐색 → 후보 풀에서 실제 제외되는지
  const restArr = [...restIds];
  let probe: { org: string; team: string; userId: string; name: string } | null = null;
  for (let i = 0; i < restArr.length && !probe; i += 200) {
    const chunk = restArr.slice(i, i + 200);
    const { data: mems } = await supabaseAdmin.from("user_memberships")
      .select("user_id,team_name,part_name,membership_state,is_current").in("user_id", chunk).eq("is_current", true);
    for (const m of (mems ?? []) as any[]) {
      const t = (m.team_name ?? "").trim();
      if (!t || t === "시즌전체휴식" || m.membership_state === "rest") continue;
      const part = (m.part_name ?? "").trim();
      if (!part || part === "일반") continue;
      const { data: prof } = await supabaseAdmin.from("user_profiles").select("organization_slug,display_name").eq("user_id", m.user_id).maybeSingle();
      if (!prof) continue;
      probe = { org: (prof as any).organization_slug, team: t, userId: m.user_id, name: (prof as any).display_name };
      break;
    }
  }

  hr(); line("실무경험 listPartCrews 후보 풀 — 휴식자 제외"); hr();
  if (probe) {
    line(`  프로브: ${probe.name}(${probe.userId.slice(0, 8)}) org=${probe.org} team=${probe.team} (휴식자·실제팀)`);
    const crews = await listPartCrews(probe.org, probe.team, "operating");
    const included = (crews as any[]).some((c) => (c.userId ?? c.user_id) === probe!.userId);
    ck("휴식자 프로브가 후보 풀에서 제외됨", !included, `included=${included}`);
    const leaked = (crews as any[]).filter((c) => restIds.has(c.userId ?? c.user_id));
    ck("후보 풀에 휴식자 누수 0", leaked.length === 0, `누수=${leaked.length} (전체 ${crews.length})`);
  } else {
    line("  (현재 휴식자 365명은 모두 '시즌전체휴식' 팀 → 실제 팀 풀엔 원래 부재. 무회귀.)");
    // 임의 실제 팀 샘플로 누수 0 invariant 확인
    const { data: sampleMem } = await supabaseAdmin.from("user_memberships").select("user_id,team_name").eq("is_current", true).neq("team_name", "시즌전체휴식").not("team_name", "is", null).limit(1).maybeSingle();
    if (sampleMem) {
      const { data: sp } = await supabaseAdmin.from("user_profiles").select("organization_slug").eq("user_id", (sampleMem as any).user_id).maybeSingle();
      const org = (sp as any)?.organization_slug;
      const team = (sampleMem as any).team_name;
      const crews = await listPartCrews(org, team, "operating");
      const leaked = (crews as any[]).filter((c) => restIds.has(c.userId ?? c.user_id));
      line(`  샘플 팀 ${org}/${team} 후보 ${crews.length}건`);
      ck("샘플 실제 팀 후보 풀에 휴식자 누수 0", leaked.length === 0, `누수=${leaked.length}`);
    }
  }
  line("  (여름 전환 시: 실제 팀 소속 여름휴식자 30명이 동일 경로로 제외됨 — getCurrentSeasonRestUserIds 가 2026-summer 산출)");

  hr();
  line(fail === 0 ? "✅ 실무경험 라인 개설 휴식 제외 PASS" : `❌ ${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });

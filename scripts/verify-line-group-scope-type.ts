// 라인급 scope_type(파트 전용 SoT) 직접 검증 — 2026-07-24.
//   run: npx tsx --env-file=.env.local scripts/verify-line-group-scope-type.ts
//   전제: 마이그 2026-07-24_process_line_group_scope_type.sql 적용 · encre 비주얼랩(T) 파트[무드,아트,포토].
//   direct(lib 함수 직접 호출 — 인증 불필요). net-zero(TAG 시드 cleanup). snapshot/포인트 원장 무접촉.
//
//   검증: 등록 라운드트립(scopeType 저장/유지·비-experience PART→TEAM 강제) · 보드 스코프 확장/필터
//         (team_all 파트 펼침·team_overall 파트 제외·part 총괄 제외) · 파트별 상태 독립(무드 체크≠아트)
//         · 주차 상세 카드 파트 펼침(partName) — /admin/team-parts/info/weeks/[weekId].
import { createClient } from "@supabase/supabase-js";
import {
  createProcessLineGroup,
  deleteProcessLineGroup,
  createProcessAct,
  deleteProcessAct,
  listProcessLineGroups,
} from "@/lib/adminProcessesData";
import { getProcessCheckBoard } from "@/lib/adminProcessCheckData";
import { loadTeamPartsInfoActCheckManagement } from "@/lib/adminTeamPartsInfoActCheckData";
import type { OrganizationSlug } from "@/lib/organizations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});
const ORG = "encre";
const TEAM_ID = "ad6304ba-c566-445a-afd6-1b1bb8939925"; // 비주얼랩(T)
const ADMIN = "aac4639b-7c22-4a53-9f2e-08076d5aa620";
const MODE = "test" as const;
const TAG = "ZZ-scopetype";
const J = (o: unknown) => JSON.stringify(o);

let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };
const findAct = (b: { acts: Array<{ actId: string; partLabel: string; status: string }> }, id: string) =>
  b.acts.filter((a) => a.actId === id);

const actInput = (lineGroupId: string, name: string) => ({
  lineGroupId, hub: "experience" as const, actName: name, durationMinutes: 10,
  occurWeek: "N" as const, occurDow: 2, occurTime: "06:30",
  checkWeek: "N" as const, checkDow: 3, checkTime: "21:00",
  pointCheck: 1, pointAdvantage: 0, pointPenalty: 0,
  cafe: "occur" as const, checkTarget: "check" as const, actType: "required" as const,
  overview: "scope_type 검증용", remarks: null,
});

async function cleanup() {
  const g = (await sb.from("process_line_groups").select("id").like("name", `${TAG}%`)).data ?? [];
  const ids = (g as { id: string }[]).map((x) => x.id);
  if (!ids.length) return;
  const acts = (await sb.from("process_acts").select("id").in("line_group_id", ids)).data ?? [];
  const actIds = (acts as { id: string }[]).map((x) => x.id);
  if (actIds.length) {
    await sb.from("process_check_logs").delete().in("act_id", actIds);
    await sb.from("process_check_statuses").delete().in("act_id", actIds);
    await sb.from("process_acts").delete().in("id", actIds);
  }
  await sb.from("process_line_groups").delete().in("id", ids);
}

void (async () => {
  await cleanup();
  try {
    // ── A. 등록 라운드트립 ──────────────────────────────────────────────────
    const gTeam = await createProcessLineGroup({ hub: "experience", name: `${TAG} 총괄관리`, scopeType: "TEAM" }, ADMIN);
    const gPart = await createProcessLineGroup({ hub: "experience", name: `${TAG} 가공파트`, scopeType: "PART" }, ADMIN);
    ck("[등록] TEAM 라인급 scopeType=TEAM 반환", gTeam.scopeType === "TEAM", gTeam.scopeType);
    ck("[등록] PART 라인급 scopeType=PART 반환", gPart.scopeType === "PART", gPart.scopeType);

    const listed = await listProcessLineGroups("experience");
    const lt = listed.find((x) => x.id === gTeam.id);
    const lp = listed.find((x) => x.id === gPart.id);
    ck("[유지] 재조회 TEAM scopeType=TEAM", lt?.scopeType === "TEAM", lt?.scopeType);
    ck("[유지] 재조회 PART scopeType=PART", lp?.scopeType === "PART", lp?.scopeType);

    // 비-experience 허브는 PART 요청해도 TEAM 강제.
    const gClub = await createProcessLineGroup({ hub: "club", name: `${TAG} 클럽PART시도`, scopeType: "PART" }, ADMIN);
    ck("[강제] 비-experience 허브 PART→TEAM 강제", gClub.scopeType === "TEAM", gClub.scopeType);
    await deleteProcessLineGroup(gClub.id);

    // ── 액트 시드 ────────────────────────────────────────────────────────────
    const aTeam = await createProcessAct(actInput(gTeam.id, `${TAG} 총괄액트`), ADMIN);
    const aPart = await createProcessAct(actInput(gPart.id, `${TAG} 파트액트`), ADMIN);

    // ── B. 보드 스코프 확장/필터 (/admin/processes/check/experience) ──────────
    const bAll = await getProcessCheckBoard("experience", ORG, TEAM_ID, MODE, "team_all", null, null);
    const weekId = bAll.selectedWeekId ?? bAll.week?.weekId ?? null;
    const parts = [...bAll.teamParts].sort();
    ck("[전제] 비주얼랩(T) 파트 ≥2", parts.length >= 2, J(parts));

    const partRows = findAct(bAll, aPart.id);
    ck("[team_all] PART 액트 = 파트마다 1행 펼침", partRows.length === parts.length && partRows.every((r) => parts.includes(r.partLabel)), J(partRows.map((r) => r.partLabel)));
    const teamRows = findAct(bAll, aTeam.id);
    ck("[team_all] TEAM 액트 = 1행(팀 총괄)", teamRows.length === 1 && teamRows[0].partLabel === "팀 총괄", J(teamRows.map((r) => r.partLabel)));

    const bOverall = await getProcessCheckBoard("experience", ORG, TEAM_ID, MODE, "team_overall", null, null);
    ck("[team_overall] TEAM 액트 포함·PART 액트 제외", findAct(bOverall, aTeam.id).length === 1 && findAct(bOverall, aPart.id).length === 0);

    const P1 = parts[0], P2 = parts[1];
    const bP1 = await getProcessCheckBoard("experience", ORG, TEAM_ID, MODE, "part", P1, null);
    ck(`[part ${P1}] PART 액트만·partLabel=${P1}·TEAM 액트 제외`, findAct(bP1, aPart.id).length === 1 && findAct(bP1, aPart.id)[0].partLabel === P1 && findAct(bP1, aTeam.id).length === 0);

    // ── C. 파트별 상태 독립 ────────────────────────────────────────────────────
    // P1 만 completed 상태행 직접 주입(scope_mode=test) → P1 완료·P2 미완료여야 함.
    await sb.from("process_check_statuses").insert({
      organization_slug: ORG, hub: "experience", week_id: weekId, line_group_id: gPart.id, act_id: aPart.id,
      team_id: TEAM_ID, part_name: P1, scope_mode: MODE, status: "completed",
      requested_at: new Date(0).toISOString(), scheduled_check_at: new Date(0).toISOString(), completed_at: new Date(0).toISOString(),
    });
    const bP1b = await getProcessCheckBoard("experience", ORG, TEAM_ID, MODE, "part", P1, null);
    const bP2b = await getProcessCheckBoard("experience", ORG, TEAM_ID, MODE, "part", P2, null);
    ck(`[독립] ${P1} 체크 후 ${P1}=completed`, findAct(bP1b, aPart.id)[0]?.status === "completed", findAct(bP1b, aPart.id)[0]?.status);
    ck(`[독립] ${P1} 체크가 ${P2} 로 안 번짐(≠completed)`, findAct(bP2b, aPart.id)[0]?.status !== "completed", findAct(bP2b, aPart.id)[0]?.status);

    // ── D. 주차 상세 카드 파트 펼침 (/admin/team-parts/info/weeks/[weekId]) ────
    if (weekId) {
      const detail = await loadTeamPartsInfoActCheckManagement(weekId, ORG as OrganizationSlug, MODE);
      const team = detail.practicalExperience.teams.find((t) => t.teamId === TEAM_ID);
      const partLine = team?.lines.find((l) => l.lineId === gPart.id);
      const teamLine = team?.lines.find((l) => l.lineId === gTeam.id);
      const partCards = partLine ? Object.values(partLine.regularActsByDay).flat().filter((c) => c.actId === aPart.id) : [];
      const teamCards = teamLine ? Object.values(teamLine.regularActsByDay).flat().filter((c) => c.actId === aTeam.id) : [];
      const partNames = partCards.map((c) => c.partName).filter(Boolean).sort();
      ck("[상세] PART 액트 카드 = 파트마다 1장·partName 채움", partCards.length === parts.length && J(partNames) === J(parts), J(partCards.map((c) => c.partName)));
      ck("[상세] TEAM 액트 카드 partName=null", teamCards.length === 1 && teamCards[0].partName === null, J(teamCards.map((c) => c.partName)));
      const p1Card = partCards.find((c) => c.partName === P1);
      const p2Card = partCards.find((c) => c.partName === P2);
      ck(`[상세] ${P1} 카드 isChecked=true·${P2} 카드 isChecked=false`, p1Card?.isChecked === true && p2Card?.isChecked === false, `${P1}=${p1Card?.isChecked} ${P2}=${p2Card?.isChecked}`);
    } else {
      ck("[상세] weekId 확보(현재 주차)", false, "weekId null");
    }
  } finally {
    await cleanup();
  }
  console.log(`\n  RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

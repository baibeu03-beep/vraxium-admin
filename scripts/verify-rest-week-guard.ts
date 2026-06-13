// 검증(READ-ONLY 위주) — 공식 휴식 주차 라인개설 서버 가드.
//   npx tsx --env-file=.env.local scripts/verify-rest-week-guard.ts
// isWeekOfficialRestById(UI 판정 일치) + assertWeekOpenable(휴식=throw·일반=통과) + savePartSubmission/openTeamOverall 거부.
// 거부 경로만 호출(throw before write) → DB write 0. snapshot 무접촉.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  getCurrentWeekStartMs,
  getOpenableWeekStartMs,
  describeWeekByStartMs,
} from "@/lib/cluster4WeekPolicy";
import { fetchActiveRestPeriods } from "@/lib/officialRestPeriodsData";
import { matchOfficialRestPeriods } from "@/lib/officialRestPeriodsTypes";
import { isWeekOfficialRestById, assertWeekOpenable } from "@/lib/cluster4OfficialRestWeek";
import { savePartSubmission } from "@/lib/adminExperiencePartInput";
import { openTeamOverall } from "@/lib/adminExperienceTeamOverall";

const ORG = "oranke";
const DAY = 86_400_000;
let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };
async function expectThrow(label: string, fn: () => Promise<unknown>, wantStatus = 422) {
  try { await fn(); ck(label, false, "throw 기대"); }
  catch (e) { ck(label, (e as { status?: number }).status === wantStatus, `${(e as { status?: number }).status}: ${(e as Error).message.slice(0, 40)}`); }
}

async function main() {
  // UI 판정 재현(weeks-options 미러) → 서버 판정과 비교.
  const todayIso = new Date().toISOString().slice(0, 10);
  const curMs = getCurrentWeekStartMs(todayIso)!;
  const openMs = getOpenableWeekStartMs(todayIso);
  const restPeriods = await fetchActiveRestPeriods();
  const uiByKey = new Map<string, { weekId?: string; uiRest: boolean; label: string; isOpenTarget: boolean }>();
  for (let off = 0; off < 8; off++) {
    const info = describeWeekByStartMs(curMs - off * 7 * DAY);
    if (!info) continue;
    const dateRest = matchOfficialRestPeriods({ startDate: info.weekStart, endDate: info.weekEnd }, restPeriods).length > 0;
    uiByKey.set(`${info.isoYear}::${info.isoWeek}`, {
      uiRest: info.isOfficialRest || dateRest,
      label: `${info.year} ${info.seasonName} W${info.weekNumber}`,
      isOpenTarget: openMs != null && curMs - off * 7 * DAY === openMs,
    });
  }
  // weeks 행 매칭.
  const orExpr = [...uiByKey.keys()].map((k) => { const [y, w] = k.split("::"); return `and(iso_year.eq.${y},iso_week.eq.${w})`; }).join(",");
  const { data: weekRows } = await supabaseAdmin.from("weeks").select("id,iso_year,iso_week").or(orExpr);
  for (const r of (weekRows ?? []) as any[]) { const e = uiByKey.get(`${r.iso_year}::${r.iso_week}`); if (e) e.weekId = r.id; }

  // ── UI 판정 == 서버 판정(isWeekOfficialRestById) ──
  console.log("── UI(weeks-options) vs 서버(isWeekOfficialRestById) 판정 일치 ──");
  let restWeekId: string | null = null, normalWeekId: string | null = null, restLabel = "", normalLabel = "";
  for (const e of uiByKey.values()) {
    if (!e.weekId) continue;
    const { rest } = await isWeekOfficialRestById(e.weekId);
    ck(`[parity] ${e.label}${e.isOpenTarget ? "(개설대상)" : ""} UI=${e.uiRest} == 서버=${rest}`, rest === e.uiRest);
    if (rest && !restWeekId) { restWeekId = e.weekId; restLabel = e.label; }
    if (!rest && !normalWeekId) { normalWeekId = e.weekId; normalLabel = e.label; }
  }
  console.log(`\n표본: 휴식주차=${restLabel}(${restWeekId?.slice(0,8)}) · 일반주차=${normalLabel}(${normalWeekId?.slice(0,8)})\n`);

  // ── assertWeekOpenable ──
  if (normalWeekId) { await assertWeekOpenable(normalWeekId); ck("[assert] 일반 주차 통과", true); }
  if (restWeekId) await expectThrow("[assert] 휴식 주차 422 throw", () => assertWeekOpenable(restWeekId!));

  // ── savePartSubmission / openTeamOverall: 휴식 주차 거부(operating·test 둘 다) + write 0 ──
  const { data: tRow } = await supabaseAdmin.from("cluster4_teams").select("id").eq("organization_slug", ORG).eq("team_name", "과일(T)").maybeSingle();
  const teamId = (tRow as { id: string } | null)?.id ?? null;
  if (restWeekId && teamId) {
    const hdr = async () => (await supabaseAdmin.from("cluster4_experience_part_submissions").select("id", { count: "exact", head: true }).eq("organization_slug", ORG).eq("week_id", restWeekId).eq("team_id", teamId)).count ?? 0;
    const before = await hdr();
    for (const mode of ["operating", "test"] as const) {
      await expectThrow(`[savePartSubmission] 휴식 주차(${mode}) 거부`, () =>
        savePartSubmission({ organization: ORG, weekId: restWeekId!, teamId, part: "젤리", submittedBy: null, mode, cells: [] }));
    }
    ck("[savePartSubmission] 거부 시 헤더 write 0", (await hdr()) === before, `before=${before}`);

    const ovBefore = (await supabaseAdmin.from("cluster4_experience_team_overall").select("id", { count: "exact", head: true }).eq("organization_slug", ORG).eq("week_id", restWeekId).eq("team_id", teamId)).count ?? 0;
    for (const mode of ["operating", "test"] as const) {
      await expectThrow(`[openTeamOverall] 휴식 주차(${mode}) 거부`, () =>
        openTeamOverall({ organization: ORG, weekId: restWeekId!, teamId, teamName: "과일(T)", leaderCells: [], outputs: [], adminId: null, mode }));
    }
    const ovAfter = (await supabaseAdmin.from("cluster4_experience_team_overall").select("id", { count: "exact", head: true }).eq("organization_slug", ORG).eq("week_id", restWeekId).eq("team_id", teamId)).count ?? 0;
    ck("[openTeamOverall] 거부 시 team_overall write 0", ovAfter === ovBefore, `${ovBefore}→${ovAfter}`);
  }

  // ── 일반 주차(W13)는 가드 통과(이후 정상 로직) — savePartSubmission 빈 cells 로 통과 후 정리 ──
  if (normalWeekId && teamId) {
    const hdr = async () => (await supabaseAdmin.from("cluster4_experience_part_submissions").select("id", { count: "exact", head: true }).eq("organization_slug", ORG).eq("week_id", normalWeekId).eq("team_id", teamId).eq("part_name", "젤리")).count ?? 0;
    const before = await hdr();
    try {
      await savePartSubmission({ organization: ORG, weekId: normalWeekId, teamId, part: "젤리", submittedBy: null, mode: "test", cells: [] });
      ck("[일반주차] savePartSubmission 가드 통과(저장 성공)", true);
    } catch (e) { ck("[일반주차] savePartSubmission 가드 통과", false, (e as Error).message); }
    // 정리(net-zero) — 이 테스트로 생성된 헤더 삭제.
    if (before === 0) await supabaseAdmin.from("cluster4_experience_part_submissions").delete().eq("organization_slug", ORG).eq("week_id", normalWeekId).eq("team_id", teamId).eq("part_name", "젤리");
    ck("[일반주차] 정리 후 net-zero", (await hdr()) === before);
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

// 주차 기준 운용 파트 반영 검증 — 2026-07-24.
//   run: npx tsx --env-file=.env.local scripts/verify-week-based-operated-parts.ts
//   신규 운용 파트(그 주차 배정 크루 ≥1)가 experience 체크 드롭다운 + 주차 상세 파트 확장에 즉시 반영되는지.
//   direct(lib 함수)·net-zero(override/시드 정리). snapshot/포인트/멤버십 무접촉(override는 read-only 파생).
//   픽스처: encre 비주얼랩(T) [무드,아트,포토]. mode=test.
import { createClient } from "@supabase/supabase-js";
import { getTeamSelectedWeekSummary, listOperatedTeamParts } from "@/lib/adminTeamSelectedWeekSummary";
import { getProcessCheckBoard } from "@/lib/adminProcessCheckData";
import { loadTeamPartsInfoActCheckManagement } from "@/lib/adminTeamPartsInfoActCheckData";
import { createProcessLineGroup, deleteProcessLineGroup, createProcessAct } from "@/lib/adminProcessesData";
import type { OrganizationSlug } from "@/lib/organizations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});
const ORG = "encre" as OrganizationSlug;
const TEAM_ID = "ad6304ba-c566-445a-afd6-1b1bb8939925"; // 비주얼랩(T)
const TEAM_NAME = "비주얼랩(T)";
const ADMIN = "aac4639b-7c22-4a53-9f2e-08076d5aa620";
const MODE = "test" as const;
const NEWPART = "ZZ신규파트";
const TAG = "ZZ-weekpart";
const J = (o: unknown) => JSON.stringify(o);
let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

const actInput = (lineGroupId: string, name: string) => ({
  lineGroupId, hub: "experience" as const, actName: name, durationMinutes: 10,
  occurWeek: "N" as const, occurDow: 2, occurTime: "06:30",
  checkWeek: "N" as const, checkDow: 3, checkTime: "21:00",
  pointCheck: 1, pointAdvantage: 0, pointPenalty: 0,
  cafe: "occur" as const, checkTarget: "check" as const, actType: "required" as const,
  overview: "주차 파트 검증용", remarks: null,
});

async function cleanup() {
  await sb.from("cluster4_team_week_position_overrides").delete().eq("organization", ORG).eq("raw_part", NEWPART);
  const g = (await sb.from("process_line_groups").select("id").like("name", `${TAG}%`)).data ?? [];
  const ids = (g as { id: string }[]).map((x) => x.id);
  if (ids.length) {
    const acts = (await sb.from("process_acts").select("id").in("line_group_id", ids)).data ?? [];
    const actIds = (acts as { id: string }[]).map((x) => x.id);
    if (actIds.length) {
      await sb.from("process_check_statuses").delete().in("act_id", actIds);
      await sb.from("process_acts").delete().in("id", actIds);
    }
    await sb.from("process_line_groups").delete().in("id", ids);
  }
}

void (async () => {
  await cleanup();
  try {
    // ── 기준선(주입 전) ──────────────────────────────────────────────────────
    const summary = await getTeamSelectedWeekSummary({ organization: ORG, teamName: TEAM_NAME, weekId: null, mode: MODE });
    const week = summary.week;
    if (!week) { ck("[전제] 현재 주차 확보", false); throw new Error("no week"); }
    const curWeekId = week.weekId;
    const curWeekStart = week.weekStartDate;
    const baseParts = summary.operatedParts.map((p) => p.partName).filter((p) => p !== "일반").sort();
    ck("[전제] 비주얼랩(T) 운용 파트 ≥2", baseParts.length >= 2, J(baseParts));

    // SoT 통일 — 요약.operatedParts == listOperatedTeamParts == 보드 드롭다운.
    const lop = await listOperatedTeamParts({ organization: ORG, teamName: TEAM_NAME, weekId: curWeekId, mode: MODE });
    ck("[SoT] listOperatedTeamParts == 요약 operatedParts", J(lop) === J(baseParts), J(lop));
    const board = await getProcessCheckBoard("experience", ORG, TEAM_ID, MODE, "team_all", null, curWeekId);
    ck("[SoT] 체크 보드 teamParts == operatedParts", J([...board.teamParts].sort()) === J(baseParts), J(board.teamParts));

    // 주입할 크루 = 현재 주차/팀에 기존 override 없는 크루(실 override 미접촉).
    const existing = (await sb.from("cluster4_team_week_position_overrides")
      .select("user_id").eq("organization", ORG).eq("week_start_date", curWeekStart).eq("raw_team", TEAM_NAME)).data ?? [];
    const usedUids = new Set((existing as { user_id: string }[]).map((r) => r.user_id));
    const crew = summary.crewRows.find((c) => !usedUids.has(c.userId));
    if (!crew) { ck("[전제] 주입 가능 크루 확보", false, "모든 크루가 기존 override 보유"); throw new Error("no free crew"); }

    // ── 신규 운용 파트 주입(현재 주차부터 carry-forward) ──────────────────────
    const { error: insErr } = await sb.from("cluster4_team_week_position_overrides").insert({
      user_id: crew.userId, organization: ORG, week_start_date: curWeekStart,
      raw_team: TEAM_NAME, raw_part: NEWPART, position_code: "regular",
    });
    ck("[주입] 신규 파트 override 삽입", !insErr, insErr?.message ?? "");

    // 주입 후 — 드롭다운/보드에 신규 파트 노출(현재 주차 기준).
    const lop2 = await listOperatedTeamParts({ organization: ORG, teamName: TEAM_NAME, weekId: curWeekId, mode: MODE });
    ck("[반영] listOperatedTeamParts 에 신규 파트 노출", lop2.includes(NEWPART), J(lop2));
    const board2 = await getProcessCheckBoard("experience", ORG, TEAM_ID, MODE, "team_all", null, curWeekId);
    ck("[반영] 체크 보드 드롭다운에 신규 파트 노출", board2.teamParts.includes(NEWPART), J(board2.teamParts));

    // 주차 민감성 — 주입 이전 과거 주차에는 미노출(carry-forward 는 전방만).
    const past = summary.selectableWeeks.find((w) => w.weekStartDate < curWeekStart);
    if (past) {
      const lopPast = await listOperatedTeamParts({ organization: ORG, teamName: TEAM_NAME, weekId: past.weekId, mode: MODE });
      ck("[주차민감] 과거 주차엔 신규 파트 미노출", !lopPast.includes(NEWPART), `past=${past.weekStartDate} ${J(lopPast)}`);
    } else {
      ck("[주차민감] 과거 주차 확보(skip 불가)", false, "선택 가능 과거 주차 없음");
    }

    // ── 주차 상세 파트 확장에 신규 파트 카드 생성 ──────────────────────────────
    const gPart = await createProcessLineGroup({ hub: "experience", name: `${TAG} 파트`, scopeType: "PART" }, ADMIN);
    const aPart = await createProcessAct(actInput(gPart.id, `${TAG} 액트`), ADMIN);
    const detail = await loadTeamPartsInfoActCheckManagement({ weekId: curWeekId, organization: ORG, mode: MODE });
    const team = detail.practicalExperience.teams.find((t) => t.teamId === TEAM_ID);
    const partLine = team?.lines.find((l) => l.lineId === gPart.id);
    const cards = partLine ? Object.values(partLine.regularActsByDay).flat().filter((c) => c.actId === aPart.id) : [];
    const cardPartNames = cards.map((c) => c.partName);
    ck("[상세] 주차 상세 파트 카드에 신규 파트 인스턴스 생성", cardPartNames.includes(NEWPART), J(cardPartNames));

    // op==test 파리티(구조) — 동일 함수·동일 DTO(모집단만 mode). operating 도 배열 반환.
    const lopOp = await listOperatedTeamParts({ organization: ORG, teamName: TEAM_NAME, weekId: curWeekId, mode: "operating" });
    ck("[op==test] operating 도 동일 구조 배열 반환", Array.isArray(lopOp), `op=${J(lopOp)}`);

    // 회귀 — 기존 파트(무드 등)는 여전히 노출(신규 주입이 기존을 지우지 않음).
    ck("[회귀] 기존 운용 파트 보존", baseParts.every((p) => lop2.includes(p)), J(lop2));
  } finally {
    await cleanup();
  }
  console.log(`\n  RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

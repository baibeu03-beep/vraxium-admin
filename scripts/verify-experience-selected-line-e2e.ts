/**
 * verify-experience-selected-line-e2e.ts
 * 사용자별 선택 라인 보존 — test 스코프 라이브 E2E(실 DB write + 라우트가 감싸는 실 함수 호출 + 원복).
 *
 * 시나리오: phalanx 의 한 test 팀/파트에서 A/B/C 3명에게 서로 다른 도출 라인(EN0002/03/04)을 선택 →
 *   openTeamOverall(mode:test) 개설 → cluster4_lines / cluster4_line_targets / 크루 카드(라이브) /
 *   snapshot 재계산·조회 를 대조. 도출은 3라인 분리, 분석/견문(단일 옵션)은 A 1명 포함.
 *   HTTP 라우트는 데이터레이어 thin wrapper(구조적 direct==HTTP). demo-mode off·admin smoke 자격 부재로
 *   고객 라우트 per-user HTTP 는 이 환경에서 생략 — 동일 read 함수(getCluster4WeeklyCardsForProfileUser)를
 *   직접 호출해 크루 weekly-cards / 회원 상세(resolveCrewWeekCard 가 감싸는 loadOverlaidCards)를 검증.
 *
 * 검증 후 개설 취소 + 생성 데이터/셀 완전 원복(finally). (라인 개설 포인트는 정책상 원복 안 됨 — 테스트 계정.)
 * run: npx tsx --env-file=.env.local scripts/verify-experience-selected-line-e2e.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { assertWeekOpenable } from "@/lib/cluster4OfficialRestWeek";
import { resolveUserScope } from "@/lib/userScope";
import { listExperienceOverallLineOptions } from "@/lib/adminExperienceLineData";
import {
  openTeamOverall,
  loadTeamMembersWithLeaders,
} from "@/lib/adminExperienceTeamOverall";
import { savePartSubmission, deletePartSubmission } from "@/lib/adminExperiencePartInput";
import type { ExperiencePartLineType } from "@/lib/experiencePartInputTypes";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import {
  recomputeAndStoreWeeklyCardsSnapshot,
  readWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";

const ORG = "phalanx";
const CANDIDATE_WEEKS = [
  "d3260418-fcd3-4c23-875f-e51502cf9bd3", // 2026-07-13 (현재주차)
  "2d21a7cc-37ce-4223-acac-419bc5fa094b", // w4
  "1dc3bcec-7fff-43a0-ba84-e1a0565e3875", // w7 (전팀 clean 확인됨)
];

type ExpLine = {
  partType: string;
  experienceCategory: string | null;
  experienceLineMasterId: string | null;
  lineId: string | null;
  lineName: string | null;
};

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

async function masterName(masterId: string): Promise<string> {
  const { data } = await supabaseAdmin
    .from("cluster4_experience_line_masters")
    .select("line_name")
    .eq("id", masterId)
    .maybeSingle();
  return (data as { line_name: string } | null)?.line_name ?? "(?)";
}

async function main() {
  const scope = await resolveUserScope("test", null);
  const opts = await listExperienceOverallLineOptions(ORG);
  const derivs = opts.derivation;
  if (derivs.length < 3) throw new Error(`phalanx 도출 옵션 부족(${derivs.length})`);
  // candidates[0](line_code 최소)는 구 코드가 전원에게 배정하던 라인 — 대조를 위해 A/B/C 는 그 외 3개 사용.
  const sorted = [...derivs].sort((a, b) => a.lineCode.localeCompare(b.lineCode));
  const firstLine = sorted[0]; // 구 버그가 전원 배정하던 라인.
  const pick = sorted.slice(1, 4); // A,B,C 서로 다른 라인.
  const analysis = opts.analysis[0] ?? null;
  const evaluation = opts.evaluation[0] ?? null;

  // 개설 가능 + 대상 팀 clean(team_overall 없음) 주차 선택.
  let weekId: string | null = null;
  let teamId: string | null = null;
  let teamName: string | null = null;
  let part: string | null = null;
  let users: string[] = [];

  for (const w of CANDIDATE_WEEKS) {
    try {
      await assertWeekOpenable(w, ORG, "experience");
    } catch {
      continue;
    }
    // test 팀/파트에서 >=3 크루 & 이 주차 team_overall 미존재 찾기.
    const { data: teams } = await supabaseAdmin
      .from("cluster4_teams")
      .select("id,team_name")
      .eq("organization_slug", ORG)
      .eq("is_active", true);
    for (const t of (teams ?? []) as Array<{ id: string; team_name: string }>) {
      if (!t.team_name.includes("(T)")) continue; // test 팀만.
      const { data: existing } = await supabaseAdmin
        .from("cluster4_experience_team_overall")
        .select("id")
        .eq("organization_slug", ORG)
        .eq("week_id", w)
        .eq("team_id", t.id)
        .maybeSingle();
      if (existing) continue; // 이미 개설/검수 이력 — skip.
      const members = await loadTeamMembersWithLeaders(ORG, t.team_name, "test");
      // 파트별 test 크루 그룹(파트장 아닌 일반/에이전트 우선, 3명).
      const byPart = new Map<string, string[]>();
      for (const m of members) {
        if (!scope.includes(m.userId)) continue;
        const list = byPart.get(m.partName) ?? [];
        list.push(m.userId);
        byPart.set(m.partName, list);
      }
      const good = Array.from(byPart.entries()).find(([, u]) => u.length >= 3);
      if (!good) continue;
      // 이 파트에 기존 part_submission 이 있으면 skip(원복 안전).
      const { data: ph } = await supabaseAdmin
        .from("cluster4_experience_part_submissions")
        .select("id")
        .eq("organization_slug", ORG)
        .eq("week_id", w)
        .eq("team_id", t.id)
        .eq("part_name", good[0])
        .maybeSingle();
      if (ph) continue;
      weekId = w; teamId = t.id; teamName = t.team_name; part = good[0]; users = good[1].slice(0, 3);
      break;
    }
    if (weekId) break;
  }

  if (!weekId || !teamId || !teamName || !part) {
    console.log("개설 가능 + clean 대상 팀/주차를 찾지 못함 — E2E 중단(데이터 변경 없음).");
    return;
  }
  const [A, B, C] = users;
  const selById: Record<string, string> = { [A]: pick[0].id, [B]: pick[1].id, [C]: pick[2].id };
  console.log(`대상: ${ORG} · week=${weekId} · team=${teamName}(${teamId}) · part=${part}`);
  console.log(`구 버그 라인(candidates[0]) = ${firstLine.lineCode} ${firstLine.lineName}`);
  console.log(`A=${A} → ${pick[0].lineCode} ${pick[0].lineName}`);
  console.log(`B=${B} → ${pick[1].lineCode} ${pick[1].lineName}`);
  console.log(`C=${C} → ${pick[2].lineCode} ${pick[2].lineName}`);
  console.log(`분석(단일)=${analysis?.lineCode ?? "없음"} · 견문(단일)=${evaluation?.lineCode ?? "없음"}\n`);

  let opened = false;
  try {
    // 1) 파트 신청 셀 write(A: 도출/분석/견문, B·C: 도출). savePartSubmission = 실제 개설신청 경로.
    const cells: Array<{ crewUserId: string; lineType: ExperiencePartLineType; checked: boolean; score: number; selectedLineId: string }> = [
      { crewUserId: A, lineType: "derivation", checked: true, score: 7, selectedLineId: selById[A] },
      { crewUserId: B, lineType: "derivation", checked: true, score: 7, selectedLineId: selById[B] },
      { crewUserId: C, lineType: "derivation", checked: true, score: 7, selectedLineId: selById[C] },
    ];
    if (analysis) cells.push({ crewUserId: A, lineType: "analysis", checked: true, score: 7, selectedLineId: analysis.id });
    if (evaluation) cells.push({ crewUserId: A, lineType: "evaluation", checked: true, score: 7, selectedLineId: evaluation.id });
    await savePartSubmission({ organization: ORG, weekId, teamId, part, submittedBy: null, cells, mode: "test" });

    // 2) 개설 완료(실 함수 = 라우트가 감싸는 것).
    const result = await openTeamOverall({
      organization: ORG, weekId, teamId, teamName, leaderCells: [], outputs: [], adminId: null, mode: "test",
    });
    opened = true;
    console.log(`[open] lines=${result.linesCreated} targets=${result.targetsCreated} evals=${result.evaluationsCreated} warnings=${result.warnings.length}`);
    if (result.warnings.length) result.warnings.forEach((w) => console.log(`   ⚠ ${w}`));

    // 3) 생성 라인/타깃 대조 데이터 수집.
    const { data: tgtRows } = await supabaseAdmin
      .from("cluster4_line_targets")
      .select("line_id,target_user_id,cluster4_lines(id,experience_line_master_id,main_title,part_type)")
      .in("target_user_id", [A, B, C])
      .eq("week_id", weekId);
    type TgtRow = { line_id: string; target_user_id: string; cluster4_lines: { id: string; experience_line_master_id: string | null; main_title: string; part_type: string } };
    const tgts = (tgtRows ?? []) as unknown as TgtRow[];
    // 도출 카테고리 타깃만(experience). 사용자별.
    const tgtByUser = new Map<string, TgtRow[]>();
    for (const t of tgts) {
      if (t.cluster4_lines?.part_type !== "experience") continue;
      const list = tgtByUser.get(t.target_user_id) ?? [];
      list.push(t);
      tgtByUser.set(t.target_user_id, list);
    }

    // 4) 라이브 카드 + snapshot 조회(각 사용자).
    console.log("\n── 대조표 (도출) ──");
    console.log("user            | selected_line_id | line master id   | target line_id   | card lineId      | card lineName | snap lineName");
    for (const u of [A, B, C]) {
      const liveCards = await getCluster4WeeklyCardsForProfileUser(u);
      const liveCard = liveCards.find((c) => c.weekId === weekId);
      const liveExp = (liveCard?.lines ?? []).filter((l) => l.partType === "experience" && l.experienceCategory === "derivation" && l.lineId) as ExpLine[];
      // snapshot 재계산 후 조회.
      await recomputeAndStoreWeeklyCardsSnapshot(u);
      const snap = await readWeeklyCardsSnapshot(u);
      const snapCard = (snap.status === "hit" || snap.status === "stale") ? snap.cards.find((c) => c.weekId === weekId) : null;
      const snapExp = (snapCard?.lines ?? []).filter((l) => l.partType === "experience" && l.experienceCategory === "derivation" && l.lineId) as ExpLine[];

      const myTgt = (tgtByUser.get(u) ?? []).find((t) => t.cluster4_lines.experience_line_master_id === selById[u]);
      const liveMatch = liveExp.find((l) => l.experienceLineMasterId === selById[u]);
      const snapMatch = snapExp.find((l) => l.experienceLineMasterId === selById[u]);
      const wantName = await masterName(selById[u]);

      const short = (s: string | null | undefined) => (s ? s.slice(0, 8) : "∅");
      console.log(
        `${u.slice(0, 8)}… | ${short(selById[u])}         | ${short(myTgt?.cluster4_lines.experience_line_master_id)}         | ${short(myTgt?.line_id)}         | ${short(liveMatch?.lineId)}         | ${liveMatch?.lineName ?? "∅"} | ${snapMatch?.lineName ?? "∅"}`,
      );

      // 검증: 라이브/snapshot lineName == 선택 라인 master line_name, 그리고 firstLine(구버그 라인) 이 아님.
      check(`${u.slice(0, 8)} 라이브 카드 = 선택 라인명(${wantName})`, liveMatch?.lineName === wantName, liveMatch?.lineName ?? "없음");
      check(`${u.slice(0, 8)} snapshot = 라이브(동일 lineName/lineId)`, !!snapMatch && snapMatch.lineName === liveMatch?.lineName && snapMatch.lineId === liveMatch?.lineId);
      check(`${u.slice(0, 8)} 배정 master = 선택 master(첫 라인 폴백 아님)`, myTgt?.cluster4_lines.experience_line_master_id === selById[u] && selById[u] !== firstLine.id);
    }

    // 교차 오염: A/B/C 의 도출 lineId 가 서로 다름.
    const distinctLineIds = new Set<string>();
    for (const u of [A, B, C]) {
      const t = (tgtByUser.get(u) ?? []).find((x) => x.cluster4_lines.experience_line_master_id === selById[u]);
      if (t) distinctLineIds.add(t.line_id);
    }
    check("A/B/C 도출 라인 3개로 분리(교차 오염 없음)", distinctLineIds.size === 3, `distinct=${distinctLineIds.size}`);

    // 분석/견문(단일 옵션) — A 만 포함, 정상 배정 확인.
    for (const [catKey, opt] of [["analysis", analysis], ["evaluation", evaluation]] as const) {
      if (!opt) continue;
      const liveCards = await getCluster4WeeklyCardsForProfileUser(A);
      const liveCard = liveCards.find((c) => c.weekId === weekId);
      const l = ((liveCard?.lines ?? []) as ExpLine[]).find((x) => x.partType === "experience" && x.experienceCategory === catKey && x.experienceLineMasterId === opt.id);
      check(`A ${catKey} 라이브 카드 = 선택 라인명(${opt.lineName})`, !!l && l.lineName === opt.lineName, l?.lineName ?? "없음");
    }
  } finally {
    // ── 원복 ──
    console.log("\n── 원복 ──");
    try {
      const { data: hdr } = await supabaseAdmin
        .from("cluster4_experience_team_overall")
        .select("id")
        .eq("organization_slug", ORG).eq("week_id", weekId).eq("team_id", teamId).maybeSingle();
      const hdrId = (hdr as { id: string } | null)?.id ?? null;
      if (hdrId) {
        const { data: ol } = await supabaseAdmin
          .from("cluster4_experience_team_overall_opened_lines")
          .select("line_id").eq("overall_id", hdrId);
        const lineIds = ((ol ?? []) as Array<{ line_id: string }>).map((r) => r.line_id);
        if (lineIds.length) {
          const { data: tg } = await supabaseAdmin.from("cluster4_line_targets").select("id").in("line_id", lineIds);
          const tgIds = ((tg ?? []) as Array<{ id: string }>).map((r) => r.id);
          if (tgIds.length) {
            await supabaseAdmin.from("cluster4_experience_line_evaluations").delete().in("line_target_id", tgIds);
            await supabaseAdmin.from("cluster4_line_targets").delete().in("id", tgIds);
          }
          await supabaseAdmin.from("cluster4_lines").delete().in("id", lineIds);
        }
        await supabaseAdmin.from("cluster4_experience_team_overall_opened_lines").delete().eq("overall_id", hdrId);
        await supabaseAdmin.from("cluster4_experience_team_overall_cells").delete().eq("overall_id", hdrId);
        await supabaseAdmin.from("cluster4_experience_team_overall_outputs").delete().eq("overall_id", hdrId);
        await supabaseAdmin.from("cluster4_experience_team_overall").delete().eq("id", hdrId);
        console.log(`  team_overall 헤더/라인 ${lineIds.length}개 삭제`);
      }
      await deletePartSubmission(ORG, weekId, teamId, part);
      console.log("  part_submission(셀 포함) 삭제");
      // 스냅샷 재계산으로 카드 원복.
      for (const u of users) await recomputeAndStoreWeeklyCardsSnapshot(u).catch(() => {});
      console.log("  A/B/C snapshot 재계산 완료");
      console.log(`  (주의) 라인 개설 포인트(source='line')는 정책상 원복 안 됨 — 테스트 계정 잔여 가능. opened=${opened}`);
    } catch (e) {
      console.error("  ⚠ 원복 중 오류:", e instanceof Error ? e.message : e);
    }
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
}

main().then(() => process.exit(fail === 0 ? 0 : 1)).catch((e) => { console.error(e); process.exit(1); });

/**
 * [회귀 검증] 실무 경험 N 입력 dedupe (2026-07-19 정책).
 *   정책: experience 라인 = config_key(category)별 조직·주차당 최대 1회 · experience 액트 = act_id별
 *         최대 1회("팀 시작"/"파트 시작"은 별개 act_id 라 각각 1회). team_id/instance 수는 오픈 판단
 *         근거로만 쓰고 합산 횟수를 늘리지 않는다.
 *   org/week/mode/팀명 하드코딩 없음 — 공통 resolveRecognitionInputs 검증. 오랑캐 W1 은 회귀 fixture.
 *   READ-ONLY (DB write 없음). npx tsx --env-file=.env.local scripts/verify-experience-recognition-dedup.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadWeekOpeningConfig } from "@/lib/adminTeamPartsInfoWeekDetailData";
import { resolveRecognitionInputs, prepareWeekRecognition } from "@/lib/weekRecognitionResolve";
import type { SavedConfig } from "@/lib/adminTeamPartsInfoWeekDetailData";
import type { OrganizationSlug } from "@/lib/organizations";

type RInputs = Awaited<ReturnType<typeof resolveRecognitionInputs>>;

let pass = 0, fail = 0;
function ck(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`, extra ?? ""); }
}
const pts = (a: number, b: number) => Math.max(0, a) + Math.max(0, b);
const dupIds = (arr: { id: string }[]) => {
  const seen = new Set<string>(), dups: string[] = [];
  for (const x of arr) { if (seen.has(x.id)) dups.push(x.id); seen.add(x.id); }
  return dups;
};

// 임의(synthetic) 팀 id — 실제 DB 팀 아님. resolver 는 config 키를 그대로 팀 집합으로 쓴다.
const TEAMS_3 = ["synthTeamA", "synthTeamB", "synthTeamC"];
const TEAMS_1 = ["synthTeamA"];
const EXP_TYPES = ["derive", "analysis", "research", "management", "expansion"] as const;

// 아무 주차·조직(실무경험 라인 계산은 config 키 기반이라 DB 팀 무관). competency 격리 위해 checked=false.
const FIX_WEEK = "496656d0-8d92-4738-b69b-e5e28aa1d57a"; // 2026-summer W1
const FIX_ORG = "oranke" as OrganizationSlug;

// actLGs = 명시 체크(true), actLGsFalse = 명시 미체크(false). experience 액트는 부재 시 기본 체크(true)
//   이므로 "닫힘"을 검증하려면 line_group 을 명시적으로 false 로 설정해야 한다(기존 actChecked 정책).
function mkConfig(teams: string[], opts: { expTypes?: string[]; actLGs?: string[]; actLGsFalse?: string[] }): SavedConfig {
  const expTypes = opts.expTypes ?? [...EXP_TYPES];
  const actLGs = opts.actLGs ?? [];
  const actLGsFalse = opts.actLGsFalse ?? [];
  const pe: Record<string, Record<string, boolean>> = {};
  const ae: Record<string, Record<string, boolean>> = {};
  for (const t of teams) {
    pe[t] = {}; for (const ty of EXP_TYPES) pe[t][ty] = expTypes.includes(ty);
    ae[t] = {}; for (const lg of actLGs) ae[t][lg] = true; for (const lg of actLGsFalse) ae[t][lg] = false;
  }
  return {
    practicalInfo: {},
    practicalExperience: pe,
    practicalCompetency: { checked: false },
    actCheck: { info: {}, club: {}, experience: ae },
  } as unknown as SavedConfig;
}

async function main() {
  // 실무경험 액트(line_group_id) 동적 조회 — 하드코딩 회피.
  const { data: ea } = await supabaseAdmin
    .from("process_acts")
    .select("id,act_name,act_type,line_group_id,point_check,point_advantage")
    .eq("hub", "experience").eq("is_active", true).eq("check_target", "check");
  const expActs = (ea ?? []) as Array<{ id: string; act_name: string; act_type: string; line_group_id: string; point_check: number; point_advantage: number }>;
  console.log(`실무경험 액트 ${expActs.length}종: ` + expActs.map((a) => `${a.act_name}(${a.line_group_id.slice(0, 6)})`).join(", "));
  const allLGs = expActs.map((a) => a.line_group_id);
  const expActId = new Set(expActs.map((a) => a.id));

  // ── 테스트 1: 같은 scope에 팀 3개 → 시작 액트 1회 · 라인 config_key별 1회 ──
  console.log("\n[테스트 1] 팀 3개, 모든 라인급 체크");
  {
    const cfg = mkConfig(TEAMS_3, { actLGs: allLGs });
    const { acts, lines } = await resolveRecognitionInputs({ weekId: FIX_WEEK, organization: FIX_ORG, config: cfg, openConfirmed: true });
    const expLines = lines.filter((l) => l.hub === "experience");
    ck("실무경험 라인 = 5종(config_key별 1개)", expLines.length === 5, { got: expLines.length });
    ck("각 라인 id = exp:{type} (팀 접미사 없음)", expLines.every((l) => /^exp:[a-z]+$/.test(l.id)), { ids: expLines.map((l) => l.id) });
    for (const a of expActs) {
      const occ = acts.filter((x) => x.id === `act:${a.id}`);
      ck(`액트 "${a.act_name}" 정확히 1회 · open`, occ.length === 1 && occ[0].isOpen === true, { occ: occ.length });
    }
    ck("acts 배열 중복 id 없음", dupIds(acts).length === 0, dupIds(acts));
    ck("lines 배열 중복 id 없음", dupIds(lines).length === 0, dupIds(lines));
  }

  // ── 테스트 2: 팀 시작 + 파트 시작 별개 act_id → 각각 1회 ──
  console.log("\n[테스트 2] 별개 시작 액트(팀/파트) 각각 1회");
  {
    const cfg = mkConfig(TEAMS_3, { actLGs: allLGs });
    const { acts } = await resolveRecognitionInputs({ weekId: FIX_WEEK, organization: FIX_ORG, config: cfg, openConfirmed: true });
    const openExp = acts.filter((a) => expActId.has(a.id.replace(/^act:/, "")) && a.isOpen);
    const distinctIds = new Set(openExp.map((a) => a.id));
    ck("서로 다른 시작 액트가 각각 1회씩 반영", openExp.length === distinctIds.size, { open: openExp.length, distinct: distinctIds.size });
  }

  // ── 테스트 3: 동일 설정 팀 다수여도 증가 없음 ──
  console.log("\n[테스트 3] 팀 수(1 vs 3)와 무관하게 동일");
  {
    const c1 = await resolveRecognitionInputs({ weekId: FIX_WEEK, organization: FIX_ORG, config: mkConfig(TEAMS_1, { actLGs: allLGs }), openConfirmed: true });
    const c3 = await resolveRecognitionInputs({ weekId: FIX_WEEK, organization: FIX_ORG, config: mkConfig(TEAMS_3, { actLGs: allLGs }), openConfirmed: true });
    const expSum = (r: RInputs) => {
      let s = 0;
      for (const a of r.acts) if (a.isOpen && expActId.has(a.id.replace(/^act:/, ""))) s += pts(a.pointA, a.pointB);
      for (const l of r.lines) if (l.isOpen && l.hub === "experience") s += pts(l.pointA, l.pointB);
      return s;
    };
    ck("팀1 실무경험 기여 == 팀3 실무경험 기여", expSum(c1) === expSum(c3), { t1: expSum(c1), t3: expSum(c3) });
    ck("팀3 실무경험 라인 여전히 5개", c3.lines.filter((l) => l.hub === "experience").length === 5);
  }

  // ── 테스트 4: 일부/전체 scope 닫힘 ──
  console.log("\n[테스트 4] scope 닫힘");
  {
    // 라인 일부만 열림(derive만)
    const partial = await resolveRecognitionInputs({ weekId: FIX_WEEK, organization: FIX_ORG, config: mkConfig(TEAMS_3, { expTypes: ["derive"], actLGs: [allLGs[0]] }), openConfirmed: true });
    const openLines = partial.lines.filter((l) => l.hub === "experience" && l.isOpen);
    ck("derive만 열림 → 실무경험 오픈 라인 1개", openLines.length === 1 && openLines[0].id === "exp:derive", { ids: openLines.map((l) => l.id) });
    // 전부 닫힘 → 실무경험 기여 0 (액트 line_group 명시 false + 전 type false)
    const closed = await resolveRecognitionInputs({ weekId: FIX_WEEK, organization: FIX_ORG, config: mkConfig(TEAMS_3, { expTypes: [], actLGsFalse: allLGs }), openConfirmed: true });
    const anyOpenExp = closed.lines.some((l) => l.hub === "experience" && l.isOpen) || closed.acts.some((a) => a.isOpen && expActId.has(a.id.replace(/^act:/, "")));
    ck("전 scope 닫힘 → 실무경험 오픈 항목 0", !anyOpenExp);
  }

  // ── 테스트 5: 다른 허브 회귀 방지(팀 수 무관) ──
  console.log("\n[테스트 5] info/competency/일반 액트 팀 수 무관");
  {
    const c1 = await resolveRecognitionInputs({ weekId: FIX_WEEK, organization: FIX_ORG, config: mkConfig(TEAMS_1, { actLGs: allLGs }), openConfirmed: true });
    const c3 = await resolveRecognitionInputs({ weekId: FIX_WEEK, organization: FIX_ORG, config: mkConfig(TEAMS_3, { actLGs: allLGs }), openConfirmed: true });
    const infoLines = (r: RInputs) => r.lines.filter((l) => l.hub === "info").length;
    const nonExpActs = (r: RInputs) => r.acts.filter((a) => !expActId.has(a.id.replace(/^act:/, ""))).length;
    ck("info 라인 수 팀1==팀3", infoLines(c1) === infoLines(c3), { t1: infoLines(c1), t3: infoLines(c3) });
    ck("비-experience 액트 수 팀1==팀3", nonExpActs(c1) === nonExpActs(c3), { t1: nonExpActs(c1), t3: nonExpActs(c3) });
  }

  // ── 통합: 오랑캐 2026 여름 W1 실 config 재계산(현재 DB·역량 target 포함) ──
  console.log("\n[통합] 오랑캐 2026 여름 W1 실 config 재계산");
  {
    const { config } = await loadWeekOpeningConfig(FIX_WEEK, FIX_ORG);
    const { acts, lines } = await resolveRecognitionInputs({ weekId: FIX_WEEK, organization: FIX_ORG, config: config!, openConfirmed: true });
    let reqSum = 0, expLineSum = 0;
    for (const a of acts) if (a.isOpen && a.actType === "required") reqSum += pts(a.pointA, a.pointB);
    for (const l of lines) if (l.isOpen && l.hub === "experience") expLineSum += pts(l.pointA, l.pointB);
    ck("필수 고정 액트 합계 = 51 (기존 55)", reqSum === 51, { reqSum });
    ck("실무 경험 라인 합계 = 7 (기존 21)", expLineSum === 7, { expLineSum });
    const rec = await prepareWeekRecognition({ weekId: FIX_WEEK, organization: FIX_ORG, config: config! });
    ck("현재 config: A=58", rec.result.minimalA === 58, { A: rec.result.minimalA });
    ck("현재 config: B=88", rec.result.diligentB === 88, { B: rec.result.diligentB });
    ck("현재 config: N=70 (기존 88)", rec.result.recognitionCountN === 70, { N: rec.result.recognitionCountN });
    console.log(`   → A=${rec.result.minimalA} B=${rec.result.diligentB} N=${rec.result.recognitionCountN} (저장 N=84 는 latch·미갱신)`);
  }

  console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAIL"} — pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
}
main().catch((e) => { console.error("❌", e); process.exit(1); });

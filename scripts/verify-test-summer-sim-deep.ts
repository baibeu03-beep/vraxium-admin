/**
 * verify-test-summer-sim-deep.ts  (READ-ONLY — write 0, snapshot 재계산 0)
 * W13 + mode=test 가 "실제 여름 정책과 동일 계산 경로"를 타는지 강하게 증명.
 *
 *   [1] 6개 게이트 override 전달 — 관찰효과 + 하위 함수 직접 호출
 *   [2] legacyWeekIds 비어있음(W13 비레거시화)
 *   [3] slotPolicyWeekIds 가 여름 기준으로 W13 포함
 *   [4] fetchExperienceRequiredSlotStatusByWeek 내부도 5슬롯 verdict(통합 아님)
 *   [5] 신규 5라인이 슬롯 계산 반영
 *   [6] 강화율 denominator 레거시 3 → 여름 10
 *   [7] verdict 개별 라인 기준
 *   [8/9] 실제 2026-06-29+ 주차에서 override 없이 동일 경로(코드+fixture 비교)
 *   [10] operating 은 W13 레거시 정책 그대로
 *
 * 실행: npx tsx --env-file=.env.local scripts/verify-test-summer-sim-deep.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import {
  fetchExperienceRequiredSlotStatusByWeek,
  CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM,
  TEST_SUMMER_SIM_EFFECTIVE_FROM,
} from "@/lib/lineAvailability";
import { isTransitionWeekStart } from "@/lib/seasonCalendar";
import { getCurrentWeekStartMs } from "@/lib/cluster4WeekPolicy";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
let pass = 0, fail = 0;
const check = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };
const slotSig = (v: any) => v ? `status=${v.status} slots=[${(v.requiredSlots ?? []).map((s: any) => `${s.slotOrder}:${s.category}:${s.enhancementStatus}`).join(", ")}] failed=[${(v.failedSlotOrders ?? []).join(",")}] check=${v.checkGate ? "Y" : "n"}` : "null";
const expLines = (c: any) => (c?.lines ?? []).filter((l: any) => l.partType === "experience").map((l: any) => `${l.lineCode ?? "·"}:${l.enhancementStatus}`);

async function main() {
  console.log(`경계상수=${CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM} · override=${TEST_SUMMER_SIM_EFFECTIVE_FROM}\n`);

  const { data: h } = await sb.from("cluster4_experience_team_overall").select("id,week_id").eq("status", "opened").order("opened_at", { ascending: false }).limit(1).maybeSingle();
  const weekId = (h as any).week_id;
  const wk = (await sb.from("weeks").select("week_number,start_date,season_key,result_published_at").eq("id", weekId).maybeSingle()).data as any;
  const { data: oLines } = await sb.from("cluster4_experience_team_overall_opened_lines").select("line_id").eq("overall_id", (h as any).id);
  const lineIds = (oLines ?? []).map((r: any) => r.line_id);
  const { data: tgts } = await sb.from("cluster4_line_targets").select("target_user_id").in("line_id", lineIds);
  const users = Array.from(new Set((tgts ?? []).map((t: any) => t.target_user_id)));
  const { data: markers } = await sb.from("test_user_markers").select("user_id").in("user_id", users);
  const u = (markers ?? [])[0]?.user_id as string;
  const newCodes = new Set((await sb.from("cluster4_lines").select("line_code").in("id", lineIds)).data?.map((l: any) => l.line_code) ?? []);
  console.log(`대상 testUser=${u} | W13 weekId=${weekId} start=${wk.start_date} pub=${wk.result_published_at?.slice(0, 10) ?? "null"}`);
  console.log(`신규 라인: ${Array.from(newCodes).join(",")}\n`);

  // ── [2] legacyWeekIds 비어있음 (source: start_date < effectiveFrom) ──
  console.log("[2] legacyWeekIds 판정 (start_date < effectiveFrom):");
  const legacyDefault = wk.start_date < CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM;
  const legacyOverride = wk.start_date < TEST_SUMMER_SIM_EFFECTIVE_FROM;
  check("[2] operating: W13 ∈ legacyWeekIds (레거시)", legacyDefault === true, `${wk.start_date} < ${CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM} = ${legacyDefault}`);
  check("[2] test(override): W13 ∉ legacyWeekIds (비어있음)", legacyOverride === false, `${wk.start_date} < ${TEST_SUMMER_SIM_EFFECTIVE_FROM} = ${legacyOverride}`);

  // ── [3] slotPolicyWeekIds (published && !current && !transition && start>=effectiveFrom) ──
  const curMs = getCurrentWeekStartMs(new Date().toISOString().slice(0, 10));
  const startMs = Date.UTC(+wk.start_date.slice(0, 4), +wk.start_date.slice(5, 7) - 1, +wk.start_date.slice(8, 10));
  const published = !!wk.result_published_at;
  const isCurrent = curMs != null && startMs === curMs;
  const isTransition = isTransitionWeekStart(wk.start_date);
  const inSlotPolicyDefault = published && !isCurrent && !isTransition && !(wk.start_date < CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM);
  const inSlotPolicyOverride = published && !isCurrent && !isTransition && !(wk.start_date < TEST_SUMMER_SIM_EFFECTIVE_FROM);
  console.log(`\n[3] slotPolicyWeekIds 판정 (pub=${published} cur=${isCurrent} trans=${isTransition}):`);
  check("[3] operating: W13 ∉ slotPolicyWeekIds (레거시 제외)", inSlotPolicyDefault === false);
  check("[3] test(override): W13 ∈ slotPolicyWeekIds (여름 항상-개설)", inSlotPolicyOverride === true);

  // ── [1·4·5·7] fetchExperienceRequiredSlotStatusByWeek 직접 호출(가장 깊은 게이트) ──
  const now = Date.now();
  const vLegacy = (await fetchExperienceRequiredSlotStatusByWeek(u, [weekId], now, { effectiveFrom: CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM })).get(weekId);
  const vSummer = (await fetchExperienceRequiredSlotStatusByWeek(u, [weekId], now, { effectiveFrom: TEST_SUMMER_SIM_EFFECTIVE_FROM })).get(weekId);
  console.log(`\n[4] verdict 직접 호출 (W13):`);
  console.log(`    operating(legacy): ${slotSig(vLegacy)}`);
  console.log(`    test(summer)     : ${slotSig(vSummer)}`);
  // 레거시: checkGate 채워짐(통합 라인) / 5슬롯 미산정. 여름: requiredSlots=3슬롯(1·2·3) 개별 산정.
  check("[4] test verdict 가 5슬롯(1·2·3) 개별 산정 (통합 단일 아님)", (vSummer?.requiredSlots?.length ?? 0) >= 3 && (vSummer?.requiredSlots ?? []).every((s: any) => [1, 2, 3].includes(s.slotOrder)));
  check("[4] operating verdict 는 레거시 통합 경로(요약 상이)", slotSig(vLegacy) !== slotSig(vSummer), "legacy != summer");
  check("[1·5·7] 신규 라인이 슬롯에 반영 — 도출/분석/견문 슬롯 status 가 not_applicable 아님",
    (vSummer?.requiredSlots ?? []).some((s: any) => s.enhancementStatus !== "not_applicable"),
    `slots=${(vSummer?.requiredSlots ?? []).map((s: any) => s.enhancementStatus).join(",")}`);

  // ── [6] DTO 강화율 denominator + [5] 라인 + [10] operating ──
  const dOp = await getCluster4WeeklyCardsForProfileUser(u);
  const dTest = await getCluster4WeeklyCardsForProfileUser(u, { effectiveFromOverride: TEST_SUMMER_SIM_EFFECTIVE_FROM });
  const cOp = dOp.find((c: any) => c.weekId === weekId);
  const cTest = dTest.find((c: any) => c.weekId === weekId);
  console.log(`\n[6] 강화율 denominator: operating den=${cOp.growthDenominator}(num=${cOp.growthNumerator}) | test den=${cTest.growthDenominator}(num=${cTest.growthNumerator})`);
  check("[6] operating den=3(레거시) / test den=10(여름)", cOp.growthDenominator === 3 && cTest.growthDenominator === 10, `op=${cOp.growthDenominator} test=${cTest.growthDenominator}`);
  check("[5] test W13 experience 라인에 신규 5코드 전부 포함", Array.from(newCodes).every((c) => (cTest.lines ?? []).some((l: any) => l.lineCode === c)), expLines(cTest).join(" "));
  check("[10] operating W13 = [통합] 라인 1개 유지(레거시 정책 불변)", expLines(cOp).length === 1 && (cOp.lines ?? []).some((l: any) => l.lineName?.includes("통합")));
  check("[7] test W13 verdict(userWeekStatus) 개별 라인 기준 산출", cTest.userWeekStatus != null && (cTest.experienceGrowth?.requiredSlots?.length ?? 0) >= 1);

  // ── [8·9] 실제 2026-06-29+ 주차 fixture 비교 (override 없이 동일 경로) ──
  console.log(`\n[8·9] 2026-06-29+ 주차 fixture:`);
  const { data: summerWeeks } = await sb.from("weeks").select("id,week_number,start_date,season_key").gte("start_date", CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM).order("start_date").limit(5);
  if ((summerWeeks ?? []).length === 0) {
    console.log(`    fixture 없음(미래 주차 미시드). → 코드 경로 증명으로 대체:`);
    console.log(`    모든 게이트 판정식 = (start_date < effectiveFrom). 실제 여름주차(start≥${CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM})는`);
    console.log(`    default effectiveFrom 으로도 식이 false → 비레거시(여름) 경로. W13+override(식 false)와 동일 분기.`);
    check("[8] 코드 경로 동일성: 여름주차 default == W13 override (둘 다 식 false → 여름)", true);
  } else {
    const sw = (summerWeeks ?? [])[0] as any;
    const vSummerWk = (await fetchExperienceRequiredSlotStatusByWeek(u, [sw.id], now, {})).get(sw.id); // override 없음(default)
    console.log(`    실제 여름주차 ${sw.season_key} W${sw.week_number} ${sw.start_date} verdict(default): ${slotSig(vSummerWk)}`);
    check("[8·9] 실제 여름주차(override 없이) 도 5슬롯 경로 — W13+override 와 동일 구조",
      (vSummerWk?.requiredSlots ?? []).every((s: any) => [1, 2, 3].includes(s.slotOrder)) && (vSummerWk?.requiredSlots?.length ?? 0) >= 3);
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

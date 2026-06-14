/**
 * verify-experience-denominator-scope.ts
 * 허브 강화율 분모 팀/역할 스코프 + 통합 제외 검증.
 *   목표: 권예준 = 도출(fail)+분석(s)+견문(s)+관리에이전트(s) = 4개 중 3개.
 *         타팀 라인·타역할 라인·레거시 통합 제외. operating 레거시 주차 불변.
 * 실행: npx tsx --env-file=.env.local scripts/verify-experience-denominator-scope.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { TEST_SUMMER_SIM_EFFECTIVE_FROM, CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM } from "@/lib/lineAvailability";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const KWON = "ddce842a-23a4-49a1-b947-78b2a3f9ca64"; // T권예준 (agent)
const UNIFIED = "EXBS-EN260525";

let pass = 0, fail = 0;
const check = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };
const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object" ? Object.keys(x).sort().reduce((o: any, k) => (o[k] = canon(x[k]), o), {}) : x);
function expView(card: any) {
  const lines = (card?.lines ?? []).filter((l: any) => l.partType === "experience");
  const den = lines.filter((l: any) => l.enhancementStatus !== "not_applicable");
  const num = den.filter((l: any) => l.enhancementStatus === "success");
  return { lines, den: den.length, num: num.length, codes: lines.map((l: any) => `${l.lineCode ?? "·"}:${l.enhancementStatus}`) };
}

async function main() {
  const { data: h } = await sb.from("cluster4_experience_team_overall").select("week_id").eq("status", "opened").order("opened_at", { ascending: false }).limit(1).maybeSingle();
  const weekId = (h as any).week_id;
  const wk = (await sb.from("weeks").select("week_number,start_date,season_key").eq("id", weekId).maybeSingle()).data as any;
  console.log(`주차 ${wk.season_key} W${wk.week_number} ${wk.start_date} (레거시=${wk.start_date < CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM})\n`);

  // ── 권예준: operating(레거시) vs summer-sim ──
  const dOp = await getCluster4WeeklyCardsForProfileUser(KWON);
  const dTest = await getCluster4WeeklyCardsForProfileUser(KWON, { effectiveFromOverride: TEST_SUMMER_SIM_EFFECTIVE_FROM });
  const op = expView(dOp.find((c: any) => c.weekId === weekId));
  const test = expView(dTest.find((c: any) => c.weekId === weekId));
  const opCard = dOp.find((c: any) => c.weekId === weekId);
  const testCard = dTest.find((c: any) => c.weekId === weekId);
  console.log(`[권예준 operating] experience: ${op.codes.join(", ")} → ${op.den}개 중 ${op.num}개 (growth ${opCard.growthNumerator}/${opCard.growthDenominator})`);
  console.log(`[권예준 summer-sim] experience: ${test.codes.join(", ")} → ${test.den}개 중 ${test.num}개 (growth ${testCard.growthNumerator}/${testCard.growthDenominator})`);

  // operating 레거시: 통합 1개(불변).
  check("[operating] W13 = [통합] 1라인(레거시 정책 불변)", op.den === 1 && op.lines[0]?.lineCode === UNIFIED);

  // summer-sim: 정확히 4개 중 3개.
  check("[목표] summer-sim 분모=4 / 분자=3 (4개 중 3개)", test.den === 4 && test.num === 3, `${test.den}/${test.num}`);
  const codeSet = new Map(test.lines.filter((l: any) => l.enhancementStatus !== "not_applicable").map((l: any) => [l.lineCode, l.enhancementStatus]));
  check("[포함] 도출 EXOK-EN0002 = fail", codeSet.get("EXOK-EN0002") === "fail", String(codeSet.get("EXOK-EN0002")));
  check("[포함] 분석 EXOK-EN0003 = success", codeSet.get("EXOK-EN0003") === "success");
  check("[포함] 견문 EXOK-EN0004 = success", codeSet.get("EXOK-EN0004") === "success");
  check("[포함] 관리에이전트 EXBS-EL0002 = success", codeSet.get("EXBS-EL0002") === "success");
  check("[제외] 레거시 통합 EXBS-EN260525 없음", !codeSet.has(UNIFIED));
  check("[제외] 타역할 _파트장 EXBS-EL0001 없음", !codeSet.has("EXBS-EL0001"));

  // ── HTTP mode=test ──
  const snapRow = async () => (await sb.from("cluster4_weekly_card_snapshots").select("cards,computed_at,dto_version,is_stale").eq("user_id", KWON).maybeSingle()).data;
  const before = JSON.stringify(await snapRow());
  let httpCards: any[] = []; let st = 0;
  try { const r = await fetch(`${BASE}/api/cluster4/weekly-cards?demoUserId=${KWON}&mode=test`); st = r.status; httpCards = (await r.json()).data ?? []; } catch {}
  const httpView = expView(httpCards.find((c: any) => c.weekId === weekId));
  console.log(`\n[HTTP mode=test] status=${st} experience: ${httpView.codes.join(", ")} → ${httpView.den}개 중 ${httpView.num}개`);
  check("[HTTP] mode=test = 4개 중 3개", httpView.den === 4 && httpView.num === 3);
  check("[direct==HTTP] summer-sim experience (canonical)", JSON.stringify(canon(test.lines)) === JSON.stringify(canon(httpView.lines)));
  check("[direct==HTTP] 전체 카드 배열(canonical)", JSON.stringify(canon(dTest)) === JSON.stringify(canon(httpCards)));
  const after = JSON.stringify(await snapRow());
  check("[snapshot 무영향] mode=test 전후 row byte 동일(무저장)", before === after);

  // operating HTTP 불변.
  let opHttp: any[] = [];
  try { const r = await fetch(`${BASE}/api/cluster4/weekly-cards?demoUserId=${KWON}`); opHttp = (await r.json()).data ?? []; } catch {}
  const opHttpView = expView(opHttp.find((c: any) => c.weekId === weekId));
  check("[operating HTTP 불변] W13 = [통합] 1라인", opHttpView.den === 1 && opHttpView.lines[0]?.lineCode === UNIFIED);

  // ── 역역방향 역할 스코프: 파트장 크루는 _파트장 보고 _에이전트 미포함 ──
  // 음료(T) W13 EXBS-EL0001(파트장) 타깃 = 파트장 크루.
  const { data: plLine } = await sb.from("cluster4_lines").select("id").eq("line_code", "EXBS-EL0001").eq("team_id", "ddc2385f-0e54-4e04-ae41-1e4c06ad330d").eq("is_active", true).maybeSingle();
  const { data: plT } = plLine ? await sb.from("cluster4_line_targets").select("target_user_id").eq("line_id", (plLine as any).id).eq("week_id", weekId) : { data: [] };
  const partLeader = (plT ?? [])[0]?.target_user_id as string | undefined;
  if (partLeader) {
    const dPL = await getCluster4WeeklyCardsForProfileUser(partLeader, { effectiveFromOverride: TEST_SUMMER_SIM_EFFECTIVE_FROM });
    const plView = expView(dPL.find((c: any) => c.weekId === weekId));
    const plCodes = new Set(plView.lines.map((l: any) => l.lineCode));
    console.log(`\n[파트장 ${partLeader.slice(0, 8)} summer-sim] experience: ${plView.codes.join(", ")} → ${plView.den}개 중 ${plView.num}개`);
    check("[역할 역방향] 파트장: _파트장(EXBS-EL0001) 포함", plCodes.has("EXBS-EL0001"));
    check("[역할 역방향] 파트장: _에이전트(EXBS-EL0002) 분모 제외(타역할)", !plView.lines.some((l: any) => l.lineCode === "EXBS-EL0002" && l.enhancementStatus !== "not_applicable"));
    check("[역할 역방향] 파트장: 통합 제외", !plCodes.has(UNIFIED));
  } else console.log("\n[역할 역방향] 파트장 타깃 없음 — 생략");

  console.log(`\n[실여름 운영 동일성] 필터는 fetchLineDetailsByWeek 의 !isLegacyWeek 분기 — 실여름 주차(start≥${CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM})도 isLegacyWeek=false 라 동일 코드 적용. (실여름 fixture 0건이라 summer-sim 으로 동일 분기 실증)`);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

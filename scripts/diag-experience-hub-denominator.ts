/**
 * diag-experience-hub-denominator.ts  (READ-ONLY — write 0)
 * 실무 경험 허브 "총 N개 중 M개" 분모/분자 구성 조사.
 * 실행: npx tsx --env-file=.env.local scripts/diag-experience-hub-denominator.ts [userId]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { TEST_SUMMER_SIM_EFFECTIVE_FROM } from "@/lib/lineAvailability";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";

function expLines(card: any) {
  return (card?.lines ?? []).filter((l: any) => l.partType === "experience");
}
function dumpTable(card: any) {
  const lines = expLines(card);
  console.log(`    slot | category    | code         | enh         | status  | num/den/rate | lineId(8) | targetId(8) | lineName`);
  for (const l of lines) {
    console.log(
      `    ${String(l.experienceSlotOrder ?? "-").padEnd(4)} | ${String(l.experienceCategory ?? "-").padEnd(11)} | ${String(l.lineCode ?? "·").padEnd(12)} | ${String(l.enhancementStatus).padEnd(11)} | ${String(l.status).padEnd(7)} | ${l.numerator}/${l.denominator}/${l.rate} | ${(l.lineId ?? "null").slice(0, 8)} | ${(l.lineTargetId ?? "null").slice(0, 8)} | ${l.lineName ?? "-"}`,
    );
  }
  const den = lines.filter((l: any) => l.enhancementStatus !== "not_applicable").length;
  const num = lines.filter((l: any) => l.enhancementStatus === "success").length;
  console.log(`    → 실무경험 허브 표시: 총 ${den}개(na 제외) 중 ${num}개(success). 카드 lines.length(experience)=${lines.length}`);
  // 라인별 num/den 이 허브 집계와 동일한지(=프론트가 line.num/den 을 쓰는지).
  const perLineDen = Array.from(new Set(lines.map((l: any) => l.denominator)));
  console.log(`    → 라인별 denominator 값 집합: [${perLineDen.join(",")}] (단일값이면 프론트가 line.denominator 로 "총 N" 표시 가능)`);
  return { den, num, lines };
}

async function main() {
  const argUser = process.argv[2];
  // 대상 주차/유저: 최근 opened 팀총괄(W13).
  const { data: h } = await sb.from("cluster4_experience_team_overall").select("id,week_id,team_id").eq("status", "opened").order("opened_at", { ascending: false }).limit(1).maybeSingle();
  const weekId = (h as any).week_id;
  const wk = (await sb.from("weeks").select("week_number,start_date,season_key").eq("id", weekId).maybeSingle()).data as any;
  const { data: oLines } = await sb.from("cluster4_experience_team_overall_opened_lines").select("line_id,category").eq("overall_id", (h as any).id);
  const lineIds = (oLines ?? []).map((r: any) => r.line_id);
  const { data: lrows } = await sb.from("cluster4_lines").select("id,line_code,main_title,experience_line_master_id").in("id", lineIds);
  const { data: tgts } = await sb.from("cluster4_line_targets").select("id,line_id,target_user_id").in("line_id", lineIds);
  const users = Array.from(new Set((tgts ?? []).map((t: any) => t.target_user_id)));
  const { data: markers } = await sb.from("test_user_markers").select("user_id").in("user_id", users);
  const u = argUser || (markers ?? [])[0]?.user_id;
  console.log(`대상 user=${u} | week=${wk?.season_key} W${wk?.week_number} ${wk?.start_date} (weekId=${weekId})\n`);

  // 개설된 라인 원천(중복 진단).
  console.log(`[개설 라인 원천] cluster4_lines (이번 주차 팀총괄):`);
  for (const l of (lrows ?? []) as any[]) {
    const n = (tgts ?? []).filter((t: any) => t.line_id === l.id);
    const mine = n.filter((t: any) => t.target_user_id === u).length;
    console.log(`    ${l.line_code} | lineId=${l.id.slice(0, 8)} | targets=${n.length}(이 유저=${mine}) | master=${l.experience_line_master_id?.slice(0, 8) ?? "null"}`);
  }

  // direct operating vs test.
  const dOp = await getCluster4WeeklyCardsForProfileUser(u);
  const dTest = await getCluster4WeeklyCardsForProfileUser(u, { effectiveFromOverride: TEST_SUMMER_SIM_EFFECTIVE_FROM });
  const cOp = dOp.find((c: any) => c.weekId === weekId);
  const cTest = dTest.find((c: any) => c.weekId === weekId);

  console.log(`\n[operating] W13 experience 허브:`);
  const op = dumpTable(cOp);
  console.log(`    week-level growth: ${cOp.growthNumerator}/${cOp.growthDenominator}`);

  console.log(`\n[test summer sim] W13 experience 허브:`);
  const test = dumpTable(cTest);
  console.log(`    week-level growth: ${cTest.growthNumerator}/${cTest.growthDenominator}`);

  // 통합 라인 분모 포함 여부.
  const unifiedInTest = test.lines.some((l: any) => l.lineCode === "EXBS-EN260525" && l.enhancementStatus !== "not_applicable");
  console.log(`\n[7] 통합 라인(EXBS-EN260525) test 분모 포함? ${unifiedInTest}`);

  // HTTP test.
  let httpTest: any[] = []; let st = 0;
  try { const r = await fetch(`${BASE}/api/cluster4/weekly-cards?demoUserId=${u}&mode=test`); st = r.status; httpTest = (await r.json()).data ?? []; } catch {}
  const hcTest = httpTest.find((c: any) => c.weekId === weekId);
  const hExp = expLines(hcTest);
  const hDen = hExp.filter((l: any) => l.enhancementStatus !== "not_applicable").length;
  const hNum = hExp.filter((l: any) => l.enhancementStatus === "success").length;
  // 키정렬 canonical 비교(jsonb 무관).
  const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object" ? Object.keys(x).sort().reduce((o: any, k) => (o[k] = canon(x[k]), o), {}) : x);
  const directEqHttp = JSON.stringify(canon(expLines(cTest))) === JSON.stringify(canon(hExp));
  console.log(`\n[10] HTTP test(mode=test) status=${st}: 허브 ${hDen}개 중 ${hNum}개`);
  console.log(`[10] direct(test) == HTTP(test) experience lines (canonical): ${directEqHttp}`);

  console.log(`\n=== 요약 ===`);
  console.log(`  operating 분모/분자: ${op.den}/${op.num} (week growth ${cOp.growthDenominator})`);
  console.log(`  test     분모/분자: ${test.den}/${test.num} (week growth ${cTest.growthDenominator})`);
  console.log(`  "총 ${test.den}개 중 ${test.num}개" = mode=test 에서만. operating 은 "총 ${op.den}개 중 ${op.num}개".`);
}

main().catch((e) => { console.error(e); process.exit(1); });

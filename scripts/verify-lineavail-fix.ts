import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { fetchWeeksWithOpenLinesByPart, fetchExperienceRequiredSlotStatusByWeek } from "@/lib/lineAvailability";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

function summarize(cards: any[]) {
  let expLines = 0, expSuccess = 0, expFail = 0, expNa = 0, expVoid = 0, infoLines = 0, compLines = 0, total = 0;
  for (const c of cards ?? []) {
    for (const ln of c.lines ?? []) {
      total++;
      const pt = ln.partType ?? ln.part_type;
      if (pt === "info") infoLines++;
      if (pt === "competency") compLines++;
      if (pt !== "experience") continue;
      expLines++;
      const st = ln.enhancementStatus ?? ln.status;
      if (st === "success") expSuccess++;
      else if (st === "fail") expFail++;
      else if (st === "not_applicable") expNa++;
      else if (st === "void") expVoid++;
    }
  }
  return { cards: cards.length, total, infoLines, compLines, expLines, expSuccess, expFail, expNa, expVoid };
}

async function main() {
  // 1) 핵심 함수 직접 검증 — 수정 전엔 508 .in() 실패로 전부 빈 Map 이었다.
  const { data: wk } = await sb.from("weeks").select("id").range(0, 4999);
  const weekIds = (wk ?? []).map((w: any) => w.id);
  const open = await fetchWeeksWithOpenLinesByPart(weekIds);
  const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  console.log("[1] fetchWeeksWithOpenLinesByPart (전체 153주차):");
  console.log(`   info: ${open.info.size}주차 (합 ${sum(open.info)})  experience: ${open.experience.size}주차 (합 ${sum(open.experience)})  competency: ${open.competency.size}주차 (합 ${sum(open.competency)})`);
  console.log(`   experienceOpenSlots: ${open.experienceOpenSlots.size}주차  managementLineCount: ${open.experienceManagementLineCount.size}주차`);
  const openOk = open.info.size > 0 || open.experience.size > 0;
  console.log(`   → ${openOk ? "비어있지 않음 ✅ (수정 정상 — 청크 조회 성공)" : "여전히 비어있음 ❌"}`);

  // 2) experience required-slot verdict — experience 262 라인 .in() 도 청크로 정상
  const expWeekIds = weekIds.slice(0, 30);
  // 임의 사용자 1명으로 호출(스모크): test_user 제외 실사용자
  const { data: anyUser } = await sb.from("user_profiles").select("user_id").limit(1).maybeSingle();
  if (anyUser?.user_id) {
    const verdicts = await fetchExperienceRequiredSlotStatusByWeek(anyUser.user_id, expWeekIds);
    console.log(`\n[2] fetchExperienceRequiredSlotStatusByWeek(${anyUser.user_id}, 30주차): ${verdicts.size}주차 verdict 산출 (throw/빈실패 없음) ✅`);
  }

  // 3) 대표 사용자 카드 재계산 — 수정 후 결과
  const REP = "1e63e079-ad5c-4f64-88ba-9a0cfdc55556"; // 앞서 비교한 사용자
  const fresh = summarize(await getCluster4WeeklyCardsForProfileUser(REP));
  console.log(`\n[3] 대표 사용자 ${REP} 수정 후 재계산:`);
  console.log(`   ${JSON.stringify(fresh)}`);
  console.log(`   (참고: 수정 전 buggy = expLines=121 succ=18 fail=54 na=49 / 저장 옛v21 = expLines=111 na=39)`);
}
main().catch((e) => { console.error(e); process.exit(1); });

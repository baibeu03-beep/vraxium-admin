/** 확정(공표) 주차의 "강화 대기"(pending) 발생 전수 조회 — snapshot 기준 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data: weeks } = await sb.from("weeks").select("start_date, result_published_at");
  const publishedStarts = new Set((weeks ?? []).filter((w: any) => w.result_published_at != null).map((w: any) => w.start_date));
  const { data: mk } = await sb.from("test_user_markers").select("user_id");
  const testers = new Set((mk ?? []).map((m: any) => m.user_id));
  const { data: snaps } = await sb.from("cluster4_weekly_card_snapshots").select("user_id, cards");
  let totalCards = 0;
  const combos = new Map<string, number>(); // `${part}|placeholder?|status|reason` → count
  let pubPendingCards = 0, runTallyPending = 0;
  const affectedUsers = new Set<string>(); const affectedReal = new Set<string>();
  let denWithPending = 0, denSample = "";
  for (const s of (snaps ?? []) as any[]) {
    for (const c of (s.cards ?? []) as any[]) {
      totalCards++;
      const wsd = String(c.startDate).slice(0, 10);
      const pend = (c.lines ?? []).filter((l: any) => l.enhancementStatus === "pending");
      if (pend.length === 0) continue;
      if (publishedStarts.has(wsd)) {
        pubPendingCards++;
        affectedUsers.add(s.user_id);
        if (!testers.has(s.user_id)) affectedReal.add(s.user_id);
        for (const l of pend as any[]) {
          const k = `${l.partType}|${l.lineId ? "real-line" : "placeholder"}|status=${l.status}|${l.enhancementReason ?? ""}`;
          combos.set(k, (combos.get(k) ?? 0) + 1);
        }
        // den 기여 확인: 역량 pending 1건일 때 den 에 포함되는지 — partType 별 enh!=na 칸 수와 den 비교
        const nonNa = (c.lines ?? []).filter((l: any) => l.enhancementStatus !== "not_applicable").length;
        if (!denSample) denSample = `sample: week=${wsd} den=${c.growthDenominator} nonNaLines=${nonNa} pendLines=${pend.length}`;
        if (c.growthDenominator === nonNa) denWithPending++;
      } else if (c.userWeekStatus === "running" || c.userWeekStatus === "tallying") {
        runTallyPending++;
      }
    }
  }
  console.log("snapshot 사용자:", (snaps ?? []).length, "| 카드:", totalCards);
  console.log("확정(공표) 주차 + pending 보유 카드:", pubPendingCards, "| 사용자:", affectedUsers.size, `(실유저 ${affectedReal.size})`);
  console.log("running/tallying 주차 pending 카드(유지 대상):", runTallyPending);
  console.log("\n확정 주차 pending 조합별:");
  for (const [k, n] of [...combos.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n}× ${k}`);
  console.log("\nden==nonNa(placeholder가 분모 포함) 카드:", denWithPending, "/", pubPendingCards, "|", denSample);
  console.log("실유저 affected:", [...affectedReal].map((u) => String(u).slice(0, 8)).join(","));
}
main();

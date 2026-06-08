/** [5] direct≠HTTP 원인 진단 — 1명 샘플 gateView 필드 diff (read-only). */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM } from "@/lib/lineAvailability";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const UID = process.argv[2] ?? "58a4c844-6fd2-4108-8d2d-51c701018a7b";

type GateCard = {
  startDate?: string;
  userWeekStatus?: string;
  experienceGrowth?: { checkGate?: unknown } | null;
};
const view = (cards: unknown[]) =>
  (cards as GateCard[])
    .filter((c) => c.startDate && c.startDate < CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM)
    .map((c) => ({
      startDate: c.startDate,
      userWeekStatus: c.userWeekStatus,
      checkGate: c.experienceGrowth?.checkGate ?? null,
    }));

async function main() {
  const direct = view((await getCluster4WeeklyCardsForProfileUser(UID)) as unknown[]);
  const res = await fetch(
    `http://localhost:3000/api/cluster4/weekly-cards?userId=${UID}`,
    { headers: { "x-internal-api-key": process.env.INTERNAL_API_KEY ?? "" } },
  );
  const json = (await res.json()) as { data?: unknown };
  const d = json.data;
  const http = view(Array.isArray(d) ? d : ((d as { cards?: unknown[] } | null)?.cards ?? []));

  const { data: snap } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("dto_version,is_stale,computed_at")
    .eq("user_id", UID)
    .maybeSingle();
  console.log("snapshot meta:", JSON.stringify(snap));
  console.log("direct legacy cards:", direct.length, "| http legacy cards:", http.length);
  const byStart = new Map(http.map((c) => [c.startDate, c]));
  let diffs = 0;
  for (const d of direct) {
    const h = byStart.get(d.startDate);
    if (!h) { console.log("HTTP에 없음:", d.startDate); diffs++; continue; }
    const a = JSON.stringify(d), b = JSON.stringify(h);
    if (a !== b && diffs < 6) {
      diffs++;
      console.log(`DIFF ${d.startDate}\n  direct: ${a}\n  http  : ${b}`);
    }
  }
  console.log("total diffs:", diffs);
}
main().catch((e) => { console.error(e); process.exit(1); });

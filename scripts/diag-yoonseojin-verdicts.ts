import { config } from "dotenv";
config({ path: ".env.local" });
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const userId = "76a42307-f3b2-4c08-92ab-f339a20b7d38";

async function main() {
  const { data: ws } = await sb
    .from("user_week_statuses")
    .select("week_start_date, status, season_key, updated_at, created_at")
    .eq("user_id", userId)
    .order("week_start_date", { ascending: true });
  console.log("user_week_statuses (updated_at):");
  for (const r of (ws ?? []) as any[]) {
    console.log(` ${r.week_start_date} | ${String(r.status).padEnd(13)} | ${r.season_key} | created=${r.created_at} updated=${r.updated_at}`);
  }

  const snap: any = await readWeeklyCardsSnapshot(userId);
  console.log("\nsnapshot status:", snap.status, "computedAt:", snap.computedAt, "reason:", snap.reason);
  const cards: any[] = snap?.cards ?? [];
  console.log("\nseason | week | userWeekStatus | expGrowth.status | requiredSlots enh | lines(part:status/enh)");
  for (const c of [...cards].sort((a, b) => a.startDate.localeCompare(b.startDate))) {
    if (c.seasonKey !== "2026-winter" && c.seasonKey !== "2025-autumn") continue;
    const eg = c.experienceGrowth ?? {};
    const slots = (eg.requiredSlots ?? []).map((s: any) => `${s.slotOrder}:${s.enhancementStatus}`).join(",");
    const lines = (c.lines ?? []).map((l: any) => `${l.partType ?? l.part}:${l.status}/${l.enhancementStatus}`).join(" ");
    console.log(` ${c.seasonKey} | ${c.weekLabel} | ${c.userWeekStatus} | ${eg.status} | [${slots}]`);
    console.log(`    lines: ${lines}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

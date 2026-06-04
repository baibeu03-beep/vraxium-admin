import { config } from "dotenv";
config({ path: ".env.local" });
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const userId = "76a42307-f3b2-4c08-92ab-f339a20b7d38";

async function main() {
  const { data: tu } = await sb.from("test_users").select("*").eq("user_id", userId);
  console.log("test_users row:", tu);
  const { data: prof } = await sb.from("user_profiles").select("user_id, display_name, is_test_user, growth_status").eq("user_id", userId).maybeSingle();
  console.log("profile:", prof);

  const snap: any = await readWeeklyCardsSnapshot(userId);
  console.log("snapshot keys:", snap ? Object.keys(snap) : null);
  const cards: any[] = snap?.cards ?? [];
  const winter = cards.filter((c) => c.seasonKey === "2026-winter");
  console.log(`winter cards: ${winter.length}`);
  // 1주차 카드 전체 dump (lines 등 큰 필드 요약)
  const c = winter[0];
  if (c) {
    const slim: any = {};
    for (const [k, v] of Object.entries(c)) {
      if (Array.isArray(v)) slim[k] = `[array len=${v.length}]`;
      else if (v && typeof v === "object") slim[k] = JSON.stringify(v).slice(0, 200);
      else slim[k] = v;
    }
    console.log("winter wk1 card:", JSON.stringify(slim, null, 2));
  }
  for (const w of winter) {
    console.log(` ${w.startDate} ${w.weekLabel} | userWeekStatus=${w.userWeekStatus} statusLabel=${w.statusLabel} | growth=${w.growthNumerator}/${w.growthDenominator} | statusIcon=${w.statusIconKey ?? w.statusIcon} tone=${w.statusTone}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

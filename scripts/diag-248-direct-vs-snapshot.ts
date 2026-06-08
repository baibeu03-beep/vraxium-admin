/** 248 박시은 direct vs snapshot 필드 단위 diff (read-only). */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : 1)))
      : val,
  );

async function main() {
  const { data: u } = await sb.from("users").select("id").eq("legacy_user_id", 248).limit(2);
  const uid = (u as Array<{ id: string }>)[0].id;
  const direct = (await getCluster4WeeklyCardsForProfileUser(uid)) as Array<Record<string, unknown>>;
  const { data: snap } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("cards,computed_at,dto_version")
    .eq("user_id", uid)
    .maybeSingle();
  const s = snap as { cards: Array<Record<string, unknown>>; computed_at: string; dto_version: number };
  console.log("snapshot computed_at:", s.computed_at, "dto_version:", s.dto_version);
  for (const d of direct) {
    const sc = s.cards.find((c) => c.startDate === d.startDate);
    if (!sc) {
      console.log(d.startDate, "snapshot 에 없음");
      continue;
    }
    const keys = Object.keys(d).filter((k) => canon(d[k]) !== canon(sc[k]));
    if (keys.length) {
      console.log(String(d.startDate), "diff:", keys.join(","));
      for (const k of keys.slice(0, 4)) {
        console.log("   ", k, "direct:", canon(d[k]).slice(0, 140));
        console.log("   ", " ".repeat(k.length), "snap  :", canon(sc[k]).slice(0, 140));
      }
    }
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

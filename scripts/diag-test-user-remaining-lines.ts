import { config } from "dotenv"; config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

async function main() {
  const { data: m } = await sb.from("test_user_markers").select("user_id");
  const markers = new Set(((m ?? []) as { user_id: string }[]).map((r) => r.user_id));
  // encre 마커 1명
  const { data: profs } = await sb
    .from("user_profiles")
    .select("user_id")
    .eq("organization_slug", "encre")
    .order("user_id")
    .limit(800);
  const ids = ((profs ?? []) as { user_id: string }[]).map((r) => r.user_id);
  const testUser = ids.find((id) => markers.has(id))!;
  console.log("test user:", testUser, "isMarker:", markers.has(testUser));

  const cards = (await getCluster4WeeklyCardsForProfileUser(testUser)) as Array<{
    weekId?: string;
    lines?: Array<{ lineId?: string | null; partType?: string | null; lineName?: string | null; enhancementStatus?: string | null; status?: string | null; canEdit?: boolean }>;
  }>;

  for (const c of cards) {
    const withId = (c.lines ?? []).filter((l) => l.lineId);
    if (withId.length === 0) continue;
    for (const l of withId) {
      const { data: tg } = await sb
        .from("cluster4_line_targets")
        .select("target_user_id,target_mode")
        .eq("line_id", l.lineId!);
      const uids = ((tg ?? []) as { target_user_id: string | null; target_mode: string }[])
        .filter((r) => r.target_mode === "user" && r.target_user_id)
        .map((r) => r.target_user_id as string);
      const targetsUser = uids.includes(testUser);
      const allMarker = uids.length > 0 && uids.every((id) => markers.has(id));
      const noneMarker = uids.length === 0 || uids.every((id) => !markers.has(id));
      const cls = uids.length === 0 ? "operating(0tgt)" : allMarker ? "test" : noneMarker ? "operating" : "mixed";
      console.log(
        `  wk ${String(c.weekId).slice(0, 8)} ${l.partType} ${l.lineId!.slice(0, 8)} st=${l.status}/${l.enhancementStatus} canEdit=${l.canEdit} | uids=${uids.length} targetsUser=${targetsUser} cls=${cls}`,
      );
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

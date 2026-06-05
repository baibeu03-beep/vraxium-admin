/** READ-ONLY 진단5: w12 official_rest uws 유저들의 snapshot statusLabel + 테스터 여부. */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const { data: bad } = await sb.from("user_week_statuses")
    .select("user_id").eq("week_start_date", "2026-05-18").eq("status", "official_rest");
  const userIds = [...new Set((bad ?? []).map((r: any) => r.user_id))];
  console.log("w12 official_rest 유저 수:", userIds.length);

  const { data: markers } = await sb.from("test_user_markers").select("user_id").in("user_id", userIds);
  const testerSet = new Set((markers ?? []).map((r: any) => r.user_id));
  console.log("그중 테스터:", testerSet.size, "/ 비테스터:", userIds.length - testerSet.size);
  const nonTesters = userIds.filter((u) => !testerSet.has(u));
  if (nonTesters.length) console.log("비테스터 목록:", nonTesters.slice(0, 10));

  // snapshot 에서 w12 카드 statusLabel 확인 (테스터 3명 + 비테스터 3명)
  const sample = [...userIds.filter((u) => testerSet.has(u)).slice(0, 3), ...nonTesters.slice(0, 3)];
  for (const uid of sample) {
    const { data: snap } = await sb.from("cluster4_weekly_card_snapshots")
      .select("dto_version,is_stale,computed_at,cards").eq("user_id", uid).maybeSingle();
    if (!snap) { console.log(`\n${uid} (tester=${testerSet.has(uid)}): snapshot 없음`); continue; }
    const cards = Array.isArray(snap.cards) ? snap.cards : [];
    const w12 = cards.find((c: any) => c.startDate === "2026-05-18");
    console.log(`\n${uid} (tester=${testerSet.has(uid)}): v${snap.dto_version} stale=${snap.is_stale} computed=${snap.computed_at}`);
    if (w12) console.log(`  w12 card: statusLabel=${w12.statusLabel} statusTone=${w12.statusTone} isRestWeek=${w12.isRestWeek} weekNumber=${w12.weekNumber} seasonName=${w12.seasonName ?? "?"}`);
    else console.log("  w12 카드 없음. startDates:", cards.map((c: any) => c.startDate).slice(-8));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

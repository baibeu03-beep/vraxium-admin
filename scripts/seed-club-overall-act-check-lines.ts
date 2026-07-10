/**
 * [클럽 총괄] 액트 체크 라인급 2종 시드 (idempotent).
 *   process_line_groups(hub='club') 에 고정 UUID 로 upsert.
 *   npx tsx --env-file=.env.local scripts/seed-club-overall-act-check-lines.ts
 */
import { createClient } from "@supabase/supabase-js";
import { CLUB_ACT_CHECK_LINE_SEED } from "@/lib/adminTeamPartsInfoActCheckData";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const rows = CLUB_ACT_CHECK_LINE_SEED.map((l, i) => ({
    id: l.id,
    hub: "club" as const,
    name: l.name,
    sort_order: i,
    is_active: true,
  }));
  const { error } = await sb.from("process_line_groups").upsert(rows, { onConflict: "id" });
  if (error) {
    console.error("❌ seed 실패:", error.message);
    process.exit(1);
  }
  const { data } = await sb
    .from("process_line_groups")
    .select("id,hub,name,sort_order,is_active")
    .in("id", CLUB_ACT_CHECK_LINE_SEED.map((l) => l.id));
  console.log("✅ seed 완료:", JSON.stringify(data, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });

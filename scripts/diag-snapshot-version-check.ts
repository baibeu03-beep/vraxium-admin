// diag: weekly-cards snapshot dto_version/is_stale 확인 (전체 분포 + 검증 3인)
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { supabaseAdmin } = await import("../lib/supabaseAdmin");
  const { data, error } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,dto_version,is_stale,computed_at,card_count");
  if (error) throw error;
  const rows = data ?? [];
  const byVersion = new Map<string, number>();
  let staleCount = 0;
  for (const r of rows as any[]) {
    const k = String(r.dto_version);
    byVersion.set(k, (byVersion.get(k) ?? 0) + 1);
    if (r.is_stale) staleCount++;
  }
  console.log("total snapshots:", rows.length, "| stale:", staleCount, "| by dto_version:", Object.fromEntries(byVersion));
  const targets: Record<string, string> = {
    "T윤서진": "76a42307-f3b2-4c08-92ab-f339a20b7d38",
    "T윤도현": "bf3b4305-751a-49e3-88ad-95a20e5c4dad",
    "유지민": "3c9d2dfe-629c-4d81-b847-80e42e656d4c",
  };
  for (const [name, uid] of Object.entries(targets)) {
    const r = (rows as any[]).find((x) => x.user_id === uid);
    console.log(name, r ? `v${r.dto_version} stale=${r.is_stale} cards=${r.card_count} computed=${r.computed_at}` : "NO ROW");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

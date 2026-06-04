import { supabaseAdmin } from "@/lib/supabaseAdmin";
async function main() {
  const { data, error } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("dto_version,is_stale");
  if (error) { console.log("ERR:" + error.message); return; }
  const cnt = new Map<string, number>();
  for (const r of (data ?? []) as { dto_version: number; is_stale: boolean }[]) {
    const k = `v${r.dto_version}${r.is_stale ? "(stale)" : ""}`;
    cnt.set(k, (cnt.get(k) ?? 0) + 1);
  }
  console.log("total=" + (data?.length ?? 0) + " " + [...cnt.entries()].sort().map(([k, v]) => `${k}=${v}`).join(","));
}
main();

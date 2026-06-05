/** READ-ONLY 진단: user_edit_windows cluster4.weekly_reviews 행 분포 (403 원인 검증). */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const now = new Date().toISOString();
  const { data, error } = await sb.from("user_edit_windows")
    .select("user_id,resource_key,week_id,opened_at,expires_at,granted_by")
    .eq("resource_key", "cluster4.weekly_reviews")
    .order("user_id");
  if (error) throw error;
  console.log("cluster4.weekly_reviews 행 총:", data?.length);
  const byUser = new Map<string, any[]>();
  for (const r of data ?? []) { if (!byUser.has(r.user_id)) byUser.set(r.user_id, []); byUser.get(r.user_id)!.push(r); }
  for (const [uid, rows] of byUser) {
    const open = rows.filter((r) => r.opened_at <= now && r.expires_at > now);
    console.log(`user=${uid}: 총 ${rows.length}행, 현재 열린 행 ${open.length}개` + (open.length > 1 ? "  ← maybeSingle 실패 → 403 재현 조건!" : ""));
    for (const r of rows) console.log(`   week_id=${r.week_id ?? "NULL(legacy 전역)"} open=${r.opened_at} exp=${r.expires_at} ${r.opened_at <= now && r.expires_at > now ? "[OPEN]" : "[closed]"}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data: mk } = await sb.from("test_user_markers").select("user_id");
  const testSet = new Set((mk ?? []).map((m: any) => m.user_id));
  const { data: profs } = await sb.from("user_profiles").select("user_id, display_name, organization_slug, activity_started_at");
  const real = ((profs ?? []) as any[]).filter((p) => !testSet.has(p.user_id));
  console.log("실유저 수:", real.length);
  // 각 실유저 uws min/max
  for (const p of real) {
    const { data: ws } = await sb.from("user_week_statuses")
      .select("week_start_date").eq("user_id", p.user_id).order("week_start_date", { ascending: true });
    const rows = (ws ?? []) as any[];
    const min = rows[0]?.week_start_date ?? null;
    const max = rows[rows.length - 1]?.week_start_date ?? null;
    if (min || p.activity_started_at) {
      console.log(`${p.display_name} (${p.organization_slug}) | uws ${min} ~ ${max} (${rows.length}) | started=${String(p.activity_started_at ?? "").slice(0, 10)}`);
    }
  }
}
main();

import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  // 타깃이 걸린 info 라인 (w12/w13 admin 개설분) 전체 컬럼
  const { data: t } = await sb.from("cluster4_line_targets").select("line_id, week_id, target_user_id").order("created_at", { ascending: false });
  const lineIds = [...new Set((t ?? []).map((r: any) => r.line_id))];
  const { data: lines } = await sb.from("cluster4_lines").select("*").in("id", lineIds);
  for (const l of (lines ?? []) as any[]) {
    if (l.part_type === "info") { console.log(JSON.stringify(l, null, 1)); break; }
  }
  // 247021bc / 369d11e5 가 테스터인지 실유저인지
  const { data: p } = await sb.from("user_profiles").select("user_id, display_name, organization_slug").in("user_id", ["247021bc-0000-0000-0000-000000000000"]);
  const ids = ["247021bc", "369d11e5", "b2e2d277", "4263f72d", "f26e0bab", "00b75923"];
  const { data: all } = await sb.from("user_profiles").select("user_id, display_name, organization_slug");
  for (const pref of ids) {
    const hit = (all ?? []).find((u: any) => String(u.user_id).startsWith(pref));
    console.log(pref, "→", hit?.display_name, hit?.organization_slug);
  }
}
main();

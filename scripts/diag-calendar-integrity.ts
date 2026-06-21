import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const { count: total } = await sb.from("cluster4_lines").select("*", { count: "exact", head: true }).eq("part_type", "info").eq("activity_type_id", "calendar");
  const { count: active } = await sb.from("cluster4_lines").select("*", { count: "exact", head: true }).eq("part_type", "info").eq("activity_type_id", "calendar").eq("is_active", true);
  for (const [lbl, wid] of [["W10", "6cc59d70-3aa6-4823-8854-5b82691d1a84"], ["W11", "67e07106-564e-4dab-b180-8f11c909973a"]] as const) {
    const { count } = await sb.from("cluster4_lines").select("*", { count: "exact", head: true }).eq("part_type", "info").eq("activity_type_id", "calendar").eq("is_active", true).eq("week_id", wid);
    console.log(`${lbl} active calendar lines = ${count} (중복 없음=1 기대)`);
  }
  const { data: w13 } = await sb.from("cluster4_lines").select("main_title,line_code,is_active").eq("id", "9d21e661-3b0f-41b1-9ff1-5073fb5476ce").single();
  console.log(`calendar 라인 총 ${total} (82→+14=96 기대) | active ${active}`);
  console.log(`W13 테스트 라인 무접촉: title="${w13?.main_title}" code=${w13?.line_code} active=${w13?.is_active}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

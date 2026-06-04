import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data } = await sb.from("cluster4_lines")
    .select("main_title, activity_type_id, info_subtitle, info_growth_point, output_links, output_link_1, is_recurring_content, source_type, recognition_mode")
    .eq("part_type", "info").eq("activity_type_id", "calendar").not("week_id", "is", null).limit(1);
  console.log(JSON.stringify(data?.[0] ?? null, null, 1));
}
main();

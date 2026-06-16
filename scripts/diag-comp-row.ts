import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
(async () => {
  const { data } = await sb.from("cluster4_lines").select("*").eq("id","e0d7ca9a-d8f1-4b50-bc0a-0b1d5b5ff428").single();
  console.log(JSON.stringify(data, null, 1));
  const { data: t } = await sb.from("cluster4_line_targets").select("*").eq("line_id","e0d7ca9a-d8f1-4b50-bc0a-0b1d5b5ff428").limit(1);
  console.log("TARGET:", JSON.stringify(t?.[0], null, 1));
})();

import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function pageAll(): Promise<string[]> {
  const ids: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("user_week_statuses")
      .select("user_id").order("id", { ascending: true }).range(from, from + 999);
    if (error) throw new Error("paged scan: " + error.message);
    const page = data ?? [];
    ids.push(...page.map((r: any) => r.user_id));
    if (page.length < 1000) break;
  }
  return ids;
}

async function main() {
  const all = await pageAll();
  const unique = Array.from(new Set(all));
  console.log("user_week_statuses total rows:", all.length, "| unique users:", unique.length);

  // estimate URL length for a single .in()
  const urlEstimate = unique.join(",").length;
  console.log("approx joined-ids length (bytes):", urlEstimate);

  // 1) single .in() with ALL ids — reproduce
  try {
    const t0 = Date.now();
    const { data, error } = await sb.from("user_profiles")
      .select("user_id,display_name,organization_slug").in("user_id", unique);
    if (error) { console.error("SINGLE .in() supabase error:", JSON.stringify(error)); }
    else console.log("SINGLE .in() OK in", Date.now()-t0, "ms rows:", data?.length);
  } catch (e: any) {
    console.error("SINGLE .in() THREW name:", e?.name, "msg:", e?.message);
    if (e?.cause) console.error("  cause:", e.cause);
  }

  // 2) chunked .in() (200 per chunk)
  try {
    const t0 = Date.now();
    let total = 0;
    for (let i = 0; i < unique.length; i += 200) {
      const chunk = unique.slice(i, i + 200);
      const { data, error } = await sb.from("user_profiles")
        .select("user_id,display_name,organization_slug").in("user_id", chunk);
      if (error) throw new Error("chunk error: " + error.message);
      total += data?.length ?? 0;
    }
    console.log("CHUNKED .in(200) OK in", Date.now()-t0, "ms total rows:", total);
  } catch (e: any) {
    console.error("CHUNKED THREW:", e?.message);
  }
}
main();

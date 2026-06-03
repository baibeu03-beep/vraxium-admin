import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function colHas(col: string) {
  const { data, error } = await sb.from("user_profiles").select(`user_id,${col}`).limit(5000);
  if (error) return { col, exists: false, err: error.message };
  let nonEmpty = 0;
  for (const r of data ?? []) {
    const v = (r as Record<string, unknown>)[col];
    if (v != null && String(v).trim() !== "") nonEmpty++;
  }
  const samples = (data ?? [])
    .map((r) => (r as Record<string, unknown>)[col])
    .filter((v) => v != null && String(v).trim() !== "")
    .slice(0, 5);
  return { col, exists: true, rows: data?.length ?? 0, nonEmpty, samples };
}
async function main() {
  for (const c of ["profile_tagline", "profile_keyword", "tagline", "keyword", "bio", "intro_message", "one_line_intro"]) {
    console.log(JSON.stringify(await colHas(c)));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function check(name: string) {
  const { data: p } = await sb.from("user_profiles")
    .select("user_id,display_name,status,growth_status,organization_slug")
    .ilike("display_name", `%${name}%`).maybeSingle();
  if (!p) { console.log(name, "— not found"); return; }
  const uid = p.user_id;
  const { data: ws } = await sb.from("user_week_statuses").select("status").eq("user_id", uid);
  const rows = (ws ?? []) as { status: string }[];
  let s = 0, f = 0, pr = 0, or2 = 0;
  for (const r of rows) {
    if (r.status === "success") s++; else if (r.status === "fail") f++;
    else if (r.status === "personal_rest") pr++; else if (r.status === "official_rest") or2++;
  }
  const growable = rows.length - or2;
  const rate = growable > 0 ? Math.round(((s + pr) / growable) * 100) : 0;
  const { count: actCt } = await sb.from("user_activity_details")
    .select("*", { count: "exact", head: true }).eq("user_id", uid);
  const actRate = growable * 12 > 0 ? Math.round(((actCt ?? 0) / (growable * 12)) * 1000) / 10 : 0;
  console.log(`${p.display_name} (${p.organization_slug}): sched=${rate}% act=${actRate}% [${s}s ${f}f ${pr}p ${or2}o = ${rows.length}w] details=${actCt ?? 0}`);
}

async function main() {
  for (const name of ["신서윤", "안다현", "황지유", "한채은", "이유나"]) {
    await check(name);
  }
}
main().catch(console.error);

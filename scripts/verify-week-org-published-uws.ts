import { supabaseAdmin } from "@/lib/supabaseAdmin";

const { data: states, error } = await supabaseAdmin
  .from("cluster4_week_org_result_states")
  .select("week_id,organization_slug,weeks!inner(start_date)")
  .eq("status", "published");
if (error) throw error;

const mismatches: Array<{ weekId: string; organization: string; startDate: string }> = [];
for (const state of states ?? []) {
  const startDate = (state.weeks as unknown as { start_date: string }).start_date;
  const { count, error: countError } = await supabaseAdmin
    .from("user_week_statuses")
    .select("user_profiles!inner(user_id)", { count: "exact", head: true })
    .eq("week_start_date", startDate)
    .eq("user_profiles.organization_slug", state.organization_slug);
  if (countError) throw countError;
  if ((count ?? 0) === 0) mismatches.push({
    weekId: state.week_id, organization: state.organization_slug, startDate,
  });
}
if (mismatches.length) {
  console.error("FAIL published organization states without UWS", mismatches);
  process.exit(1);
}
console.log(`PASS ${states?.length ?? 0} published organization states have UWS`);

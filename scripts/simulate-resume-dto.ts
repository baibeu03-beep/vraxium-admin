import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  // 한채은 (success/fail/personal_rest/official_rest 4종)
  const { data: p } = await sb
    .from("user_profiles")
    .select("user_id,status,growth_status")
    .ilike("display_name", "%한채은%")
    .maybeSingle();
  if (!p) { console.log("not found"); return; }
  const uid = p.user_id;
  console.log("=== 한채은 Resume DTO ===");
  console.log("user_id:", uid, "status:", p.status, "growth_status:", p.growth_status);

  const { data: ws } = await sb.from("user_week_statuses").select("status").eq("user_id", uid);
  const rows = (ws ?? []) as { status: string }[];
  let s = 0, f = 0, pr = 0, or2 = 0;
  for (const r of rows) {
    if (r.status === "success") s++;
    else if (r.status === "fail") f++;
    else if (r.status === "personal_rest") pr++;
    else if (r.status === "official_rest") or2++;
  }
  const phys = rows.length;
  const growable = phys - or2;
  const relRate = growable > 0 ? Math.round(((s + pr) / growable) * 100) : 0;

  const { count: actCt } = await sb.from("user_activity_details")
    .select("*", { count: "exact", head: true }).eq("user_id", uid);
  const avail = growable * 12;
  const completed = actCt ?? 0;
  const actRate = avail > 0 ? Math.round((completed / avail) * 1000) / 10 : 0;

  const dto = {
    resumeStatus: {
      status: p.status === "active" ? "running" : "next_challenge",
      label: p.status === "active" ? "Running" : "Next Challenge",
      isBadgeDimmed: p.status !== "graduated",
    },
    scheduleReliability: {
      physicalWeeks: phys,
      preRestWeeks: pr,
      unapprovedActiveWeeks: f,
      approvedActiveWeeks: s,
      officialRestWeeks: or2,
      rate: relRate,
    },
    activityCompletion: {
      availableActivities: avail,
      completedActivities: completed,
      rate: actRate,
    },
    practicalStats: {
      infoCount: 0,
      experienceCount: 0,
      abilityUnitCount: 0,
      careerProjectCount: 0,
    },
  };
  console.log(JSON.stringify(dto, null, 2));
}
main().catch(console.error);

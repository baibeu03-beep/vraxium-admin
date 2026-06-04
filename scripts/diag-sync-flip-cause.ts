import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { fetchExperienceRequiredSlotStatusByWeek } from "@/lib/lineAvailability";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const uid = process.argv[2] || null;
  // 020ec835 풀 UUID 찾기
  const { data: profs } = await sb.from("user_profiles").select("user_id, display_name, organization_slug");
  const hit = (profs ?? []).find((p: any) => String(p.user_id).startsWith(uid ?? "020ec835"));
  if (!hit) { console.log("user not found"); return; }
  console.log("user:", JSON.stringify(hit));
  const { data: mk } = await sb.from("test_user_markers").select("user_id").eq("user_id", (hit as any).user_id);
  console.log("test_user_markers 등재:", (mk ?? []).length > 0);

  // success 주차들
  const { data: ws } = await sb.from("user_week_statuses")
    .select("year, week_number, week_start_date, status").eq("user_id", (hit as any).user_id).eq("status", "success")
    .order("week_start_date");
  console.log("success 주차:", JSON.stringify(ws));

  // 그 주차들의 weekId + 본인 experience 타깃
  const starts = (ws ?? []).map((r: any) => r.week_start_date);
  const { data: weeks } = await sb.from("weeks").select("id, start_date").in("start_date", starts.length ? starts : ["1900-01-01"]);
  const widByStart = new Map((weeks ?? []).map((w: any) => [w.start_date, w.id]));
  const wids = [...widByStart.values()];
  const { data: targets } = await sb.from("cluster4_line_targets")
    .select("week_id, line_id, target_user_id, cluster4_lines!inner(part_type, line_code, experience_line_master_id, submission_closes_at, is_active)")
    .eq("target_mode", "user").eq("target_user_id", (hit as any).user_id)
    .in("week_id", wids.length ? wids : ["00000000-0000-0000-0000-000000000000"]);
  const expT = (targets ?? []).filter((t: any) => t.cluster4_lines?.part_type === "experience");
  const byWeek = new Map<string, any[]>();
  for (const t of expT as any[]) {
    const arr = byWeek.get(t.week_id) ?? []; arr.push(t); byWeek.set(t.week_id, arr);
  }
  // verdict
  const verdicts = await fetchExperienceRequiredSlotStatusByWeek((hit as any).user_id, wids, Date.now(), { alwaysOpenWeekIds: new Set(wids) });
  for (const r of (ws ?? []) as any[]) {
    const wid = widByStart.get(r.week_start_date)!;
    const v: any = verdicts.get(wid);
    const t = byWeek.get(wid) ?? [];
    console.log(`${r.week_start_date} (y${r.year} w${r.week_number}) | exp타깃 ${t.length}개 [${t.map((x: any) => x.cluster4_lines.line_code).join(",")}] | verdict=${v?.status} failSlots=${JSON.stringify(v?.failedSlotOrders)}`);
  }
}
main();

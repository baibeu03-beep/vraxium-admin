/** 분모A(fetchWeeksWithOpenLinesByPart) 타깃 조회 cap 근접도 측정 — 보고용(수정 금지 조건) */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const uid = "42864260-e4ea-4150-a87f-cff545b02af1"; // T임다인 (최다 주차)
  const { data: ws } = await sb.from("user_week_statuses").select("week_start_date").eq("user_id", uid);
  const starts = (ws ?? []).map((r: any) => r.week_start_date);
  const { data: weeks } = await sb.from("weeks").select("id, start_date").in("start_date", starts);
  const weekIds = (weeks ?? []).map((w: any) => w.id);
  const { data: lines } = await sb.from("cluster4_lines").select("id").in("part_type", ["info", "experience", "competency"]).eq("is_active", true);
  const lineIds = (lines ?? []).map((l: any) => l.id);
  const { count } = await sb.from("cluster4_line_targets").select("*", { count: "exact", head: true })
    .in("line_id", lineIds).in("week_id", weekIds);
  console.log(`분모A 타깃 조회 매칭(T임다인, 주차 ${weekIds.length}): ${count}행 ${count && count > 1000 ? "⚠ cap 초과" : "(cap 이내)"}`);
}
main();

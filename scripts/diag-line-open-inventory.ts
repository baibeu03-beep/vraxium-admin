import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const { count: lineCount } = await sb.from("cluster4_lines").select("*", { count: "exact", head: true });
  console.log("cluster4_lines total:", lineCount);
  for (const pt of ["info", "experience", "competency", "career"]) {
    const { count } = await sb.from("cluster4_lines").select("*", { count: "exact", head: true }).eq("part_type", pt);
    const { count: act } = await sb.from("cluster4_lines").select("*", { count: "exact", head: true }).eq("part_type", pt).eq("is_active", true);
    console.log(`  part_type=${pt}: total=${count} active=${act}`);
  }
  const { count: tCount } = await sb.from("cluster4_line_targets").select("*", { count: "exact", head: true });
  console.log("cluster4_line_targets total:", tCount);

  // 전체 타깃 덤프 (week_id → weeks.start_date 포함)
  const { data: targets } = await sb.from("cluster4_line_targets")
    .select("id, line_id, week_id, target_mode, target_user_id, created_at, created_by")
    .order("created_at", { ascending: true });
  const weekIds = [...new Set((targets ?? []).map((t: any) => t.week_id))];
  const { data: weeks } = await sb.from("weeks").select("id, start_date, week_number, season_key").in("id", weekIds.length ? weekIds : ["00000000-0000-0000-0000-000000000000"]);
  const wById = new Map((weeks ?? []).map((w: any) => [w.id, w]));
  const lineIds = [...new Set((targets ?? []).map((t: any) => t.line_id))];
  const { data: lines } = await sb.from("cluster4_lines").select("id, part_type, line_code, is_active, submission_closes_at, week_id").in("id", lineIds.length ? lineIds : ["00000000-0000-0000-0000-000000000000"]);
  const lById = new Map((lines ?? []).map((l: any) => [l.id, l]));
  console.log("\n전체 line_targets:");
  for (const t of (targets ?? []) as any[]) {
    const w: any = wById.get(t.week_id);
    const l: any = lById.get(t.line_id);
    console.log(`  ${w?.season_key} w${w?.week_number} ${w?.start_date} | ${l?.part_type} ${l?.line_code} active=${l?.is_active} closes=${String(l?.submission_closes_at).slice(0,10)} | mode=${t.target_mode} user=${String(t.target_user_id ?? "").slice(0,8)}`);
  }

  // cluster4_lines 의 week_id 사용 여부 (라인이 주차 인스턴스인지)
  const { data: lineSample } = await sb.from("cluster4_lines")
    .select("id, part_type, line_code, is_active, week_id, submission_opens_at, submission_closes_at, source_type, period_label, opened_at, created_at")
    .order("created_at", { ascending: false }).limit(15);
  console.log("\ncluster4_lines 최근 15:");
  for (const l of (lineSample ?? []) as any[]) console.log(" ", JSON.stringify(l));
}
main();

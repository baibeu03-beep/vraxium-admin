import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const uidPrefix = process.argv[2] || "42864260";
  const { data: profs } = await sb.from("user_profiles").select("user_id, display_name");
  const u: any = (profs ?? []).find((p: any) => String(p.user_id).startsWith(uidPrefix));
  console.log("user:", u.display_name, u.user_id);
  // 그 유저 success 주차 → weekIds
  const { data: ws } = await sb.from("user_week_statuses").select("week_start_date").eq("user_id", u.user_id).eq("status", "success");
  const starts = (ws ?? []).map((r: any) => r.week_start_date);
  const { data: weeks } = await sb.from("weeks").select("id, start_date").in("start_date", starts);
  const weekIds = (weeks ?? []).map((w: any) => w.id);
  console.log("success 주차 수:", weekIds.length);
  // verdict 와 동일 필터의 타깃 행 수 (slot1/2/3 라인)
  const { data: lines } = await sb.from("cluster4_lines").select("id, experience_line_master_id").eq("part_type", "experience").eq("is_active", true);
  const masterIds = [...new Set((lines ?? []).map((l: any) => l.experience_line_master_id).filter(Boolean))];
  const { data: masters } = await sb.from("cluster4_experience_line_masters").select("id, experience_slot_order").in("id", masterIds);
  const slotByMaster = new Map((masters ?? []).map((m: any) => [m.id, m.experience_slot_order]));
  const slotLineIds = (lines ?? []).filter((l: any) => {
    const s = l.experience_line_master_id ? slotByMaster.get(l.experience_line_master_id) : null;
    return s === 1 || s === 2 || s === 3;
  }).map((l: any) => l.id);
  console.log("slot1/2/3 라인 수:", slotLineIds.length);
  const { count } = await sb.from("cluster4_line_targets").select("*", { count: "exact", head: true })
    .in("line_id", slotLineIds).in("week_id", weekIds);
  console.log("verdict 타깃 조회 매칭 행 수:", count, count && count > 1000 ? " ⚠ 1000행 cap 초과 — 절단 발생!" : " (cap 이내)");
  // 실제 verdict 쿼리(limit 미지정)가 몇 행 받는지
  const { data: got } = await sb.from("cluster4_line_targets").select("week_id,line_id,target_mode,target_user_id")
    .in("line_id", slotLineIds).in("week_id", weekIds);
  console.log("실수신 행 수:", (got ?? []).length);
  // 본인 타깃이 절단으로 빠졌는지
  const own = (got ?? []).filter((t: any) => t.target_user_id === u.user_id);
  console.log("수신분 중 본인 타깃:", own.length, "(기대: success 주차 × 3 =", weekIds.length * 3, ")");
}
main();

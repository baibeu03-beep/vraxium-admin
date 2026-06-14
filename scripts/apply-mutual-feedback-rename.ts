/**
 * apply-mutual-feedback-rename.ts
 * "[생산성] 상호 피드백" → "[생산성] 상호 다면 피드백" 라인명 정정.
 *  ① line_registrations(1행) ② cluster4_experience_line_masters(1행)
 *  ③ EXOK-EN0004 개설 라인 대상 test 유저 snapshot stale (성장 테이블 write 0)
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const NEW = "[생산성] 상호 다면 피드백";
const MASTER_ID = "72618ed9-d186-4934-9164-99a78a966e9d";

async function main() {
  // ① line_registrations
  const { data: regUpd, error: regErr } = await sb
    .from("line_registrations")
    .update({ line_name: NEW })
    .eq("hub", "experience").eq("organization_slug", "oranke").eq("line_code", "EXOK-EN0004")
    .select("id,line_code,line_name,organization_slug");
  if (regErr) throw regErr;
  console.log(`① line_registrations 영향 row=${(regUpd ?? []).length}`);
  for (const r of (regUpd ?? []) as any[]) console.log(`   ${r.organization_slug}/${r.line_code} → "${r.line_name}"`);

  // ② cluster4_experience_line_masters
  const { data: mUpd, error: mErr } = await sb
    .from("cluster4_experience_line_masters")
    .update({ line_name: NEW })
    .eq("id", MASTER_ID)
    .select("id,line_code,line_name");
  if (mErr) throw mErr;
  console.log(`② cluster4_experience_line_masters 영향 row=${(mUpd ?? []).length}`);
  for (const m of (mUpd ?? []) as any[]) console.log(`   ${m.line_code} → "${m.line_name}"`);

  // ③ snapshot stale — EXOK-EN0004 개설 라인 타깃
  const { data: lines } = await sb.from("cluster4_lines").select("id").eq("part_type", "experience").eq("line_code", "EXOK-EN0004");
  const lineIds = (lines ?? []).map((l: any) => l.id);
  const { data: tgts } = await sb.from("cluster4_line_targets").select("target_user_id").in("line_id", lineIds.length ? lineIds : ["x"]);
  const userIds = Array.from(new Set(((tgts ?? []) as any[]).map((t) => t.target_user_id)));
  console.log(`③ snapshot stale 대상 user=${userIds.length}`);
  // 성장 테이블 baseline (write 0 확인)
  const growth: Record<string, number> = {};
  for (const tbl of ["user_growth_stats", "user_week_statuses", "user_weekly_points"]) {
    const { count } = await sb.from(tbl).select("*", { count: "exact", head: true }).in("user_id", userIds.length ? userIds : ["x"]);
    growth[tbl] = count ?? 0;
  }
  // snapshot is_stale 처리(직접 UPDATE — markWeeklyCardsSnapshotStaleMany 와 동일 동작)
  const { data: snapBefore } = await sb.from("cluster4_weekly_card_snapshots").select("user_id,is_stale").in("user_id", userIds.length ? userIds : ["x"]);
  const { error: stErr, count: stCount } = await sb.from("cluster4_weekly_card_snapshots")
    .update({ is_stale: true }, { count: "exact" }).in("user_id", userIds.length ? userIds : ["x"]);
  if (stErr) throw stErr;
  console.log(`   snapshot 행 존재=${(snapBefore ?? []).length}, is_stale=true 처리 row=${stCount ?? 0}`);
  // 성장 테이블 after (불변 확인)
  for (const tbl of ["user_growth_stats", "user_week_statuses", "user_weekly_points"]) {
    const { count } = await sb.from(tbl).select("*", { count: "exact", head: true }).in("user_id", userIds.length ? userIds : ["x"]);
    console.log(`   ${tbl}: ${growth[tbl]} → ${count ?? 0} ${growth[tbl] === (count ?? 0) ? "(불변✓)" : "(변경!)"}`);
  }
  console.log("\n완료.");
}
main().catch((e) => { console.error(e); process.exit(1); });

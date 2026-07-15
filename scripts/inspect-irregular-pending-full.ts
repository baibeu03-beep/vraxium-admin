import { supabaseAdmin } from "@/lib/supabaseAdmin";
async function main() {
  const { data } = await supabaseAdmin.from("process_irregular_acts").select("*").eq("id","3e955a86-91c8-43d2-a201-5aa14b1b9d1c").maybeSingle();
  console.log("변동 액트 전체 컬럼:\n", JSON.stringify(data, null, 2));
  // 포인트 원장 생성 여부 확인(이 변동에 대한 award).
  const r = data as any;
  if (r) {
    const { data: aw } = await supabaseAdmin.from("process_point_awards").select("id,source,ref_id,cancelled_at").eq("ref_id", r.id);
    console.log("\n연결 포인트 원장(ref_id=irr.id):", (aw ?? []).length, "건", JSON.stringify(aw));
  }
  // 이 주차 변동 액트 전체(status별).
  const { data: all } = await supabaseAdmin.from("process_irregular_acts").select("id,organization_slug,kind,status,act_name,completed_at,scheduled_check_at").eq("week_id","39aae7a0-216f-4262-8a67-6beef1bccf22");
  console.log("\n이 주차 전체 변동 액트:");
  for (const x of (all ?? []) as any[]) console.log(`  org=${x.organization_slug} kind=${x.kind} status=${x.status} completed_at=${x.completed_at ?? "-"} sched=${x.scheduled_check_at ?? "-"} "${x.act_name.slice(0,30)}"`);
}
main().catch(e=>{console.error(e);process.exit(1);});

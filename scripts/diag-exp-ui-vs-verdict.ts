import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  // A) UI 카탈로그: cluster4_experience_line_masters (is_active 무관 전체 + active)
  const { data: masters } = await sb.from("cluster4_experience_line_masters")
    .select("id, line_code, line_name, organization_slug, experience_slot_order, is_active");
  const mAll = (masters ?? []) as any[];
  const slotCount = (rows: any[], activeOnly: boolean) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      if (activeOnly && !r.is_active) continue;
      const k = `slot${r.experience_slot_order}`;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return Object.fromEntries([...m.entries()].sort());
  };
  console.log("A) masters(카탈로그) 전체:", mAll.length, JSON.stringify(slotCount(mAll, false)));
  console.log("   masters active:", JSON.stringify(slotCount(mAll, true)));

  // B) 개설 드래프트: cluster4_experience_drafts(테이블명 확인 겸)
  for (const t of ["cluster4_experience_drafts", "experience_drafts", "cluster4_experience_line_drafts"]) {
    const { data, error } = await sb.from(t).select("*").limit(3);
    if (!error) {
      console.log(`B) ${t}: 존재, 샘플 keys=`, data && data[0] ? Object.keys(data[0]).join(",") : "(0 rows)");
      const { count } = await sb.from(t).select("*", { count: "exact", head: true });
      console.log(`   rows=${count}`);
      break;
    }
  }

  // C) 실제 라인 인스턴스: cluster4_lines part_type=experience — is_active 무관 전체
  const { data: lines } = await sb.from("cluster4_lines")
    .select("id, line_code, is_active, experience_line_master_id, submission_closes_at, week_id, created_at")
    .eq("part_type", "experience");
  const lAll = (lines ?? []) as any[];
  const mById = new Map(mAll.map((m) => [m.id, m]));
  console.log("C) cluster4_lines(experience) 전체:", lAll.length);
  const bySlot = new Map<string, number>();
  for (const l of lAll) {
    const m = l.experience_line_master_id ? mById.get(l.experience_line_master_id) : null;
    const k = m ? `slot${(m as any).experience_slot_order}` : "master-NULL";
    bySlot.set(k, (bySlot.get(k) ?? 0) + 1);
  }
  console.log("   인스턴스 slot 분포(전체):", JSON.stringify(Object.fromEntries([...bySlot.entries()].sort())));
  for (const l of lAll) {
    const m: any = l.experience_line_master_id ? mById.get(l.experience_line_master_id) : null;
    console.log(`   ${l.id.slice(0,8)} code=${l.line_code} active=${l.is_active} closes=${String(l.submission_closes_at).slice(0,10)} week_id=${l.week_id ? "Y" : "-"} master_slot=${m?.experience_slot_order ?? "NULL"} master_org=${m?.organization_slug ?? "-"}`);
  }
}
main();

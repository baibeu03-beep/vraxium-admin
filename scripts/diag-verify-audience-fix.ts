/** READ-ONLY: 수정된 org-audience 산정이 CPBS-NN0013(competency, BS=common) 라인에 대해
 *  배정자 1명이 아니라 노출 대상 전원을 반환하는지 검증 (회귀 방지 핵심). */
import { createClient } from "@supabase/supabase-js";
import { parseLineCodeOrg, normalizeLineOrg, isLineVisibleForUserOrg, type LineOrgScope } from "@/lib/cluster4LineOrg";
import { isOrganizationSlug, type OrganizationSlug } from "@/lib/organizations";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const LINE = "adadd283-9394-464b-a7a3-8988dcb302e9"; // CPBS-NN0013

async function audience(lineId: string): Promise<string[]> {
  const { data: line } = await sb.from("cluster4_lines")
    .select("part_type,line_code,competency_line_master_id,experience_line_master_id")
    .eq("id", lineId).maybeSingle();
  const row:any = line; if(!row) return [];
  if (row.part_type === "career") return [];
  let lineOrg: LineOrgScope | null = parseLineCodeOrg(row.line_code);
  if (lineOrg == null) {
    if (row.part_type === "info") lineOrg = "common";
    else if (row.part_type === "experience" && row.experience_line_master_id) {
      const { data: m } = await sb.from("cluster4_experience_line_masters").select("organization_slug").eq("id", row.experience_line_master_id).maybeSingle();
      lineOrg = normalizeLineOrg((m as any)?.organization_slug);
    } else if (row.part_type === "competency" && row.competency_line_master_id) {
      const { data: m } = await sb.from("cluster4_competency_line_masters").select("organization_slug").eq("id", row.competency_line_master_id).maybeSingle();
      lineOrg = normalizeLineOrg((m as any)?.organization_slug);
    }
  }
  console.log(`라인 part=${row.part_type} line_code=${row.line_code} → 판정 lineOrg=${lineOrg}`);
  if (lineOrg == null) return [];
  const { data: snaps } = await sb.from("cluster4_weekly_card_snapshots").select("user_id");
  const userIds = (snaps??[]).map((r:any)=>r.user_id);
  const { data: profs } = await sb.from("user_profiles").select("user_id,organization_slug").in("user_id", userIds);
  const orgByUser = new Map<string, OrganizationSlug|null>();
  for (const p of (profs??[]) as any[]) orgByUser.set(p.user_id, isOrganizationSlug(p.organization_slug)?p.organization_slug:null);
  return userIds.filter((uid:string)=>isLineVisibleForUserOrg(lineOrg, orgByUser.get(uid)??null));
}
async function main() {
  const aud = await audience(LINE);
  const { data: snaps } = await sb.from("cluster4_weekly_card_snapshots").select("user_id");
  console.log(`\n수정 전(과거): 배정자 1명만 무효화 → 비배정 ${(snaps?.length??0)-1}명 stale`);
  console.log(`수정 후: org audience = ${aud.length}명 / 전체 스냅샷 ${snaps?.length}명`);
  console.log(`→ common 라인이므로 전원 무효화 대상이어야 함: ${aud.length === (snaps?.length??0) ? "OK ✓" : "불일치 ✗"}`);
}
main().catch(e=>{console.error(e);process.exit(1);});

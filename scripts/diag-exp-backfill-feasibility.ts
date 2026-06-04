import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  // 1) active experience 라인 + master slot/org
  const { data: lines } = await sb.from("cluster4_lines")
    .select("id, line_code, main_title, is_active, submission_closes_at, experience_line_master_id")
    .eq("part_type", "experience").eq("is_active", true);
  const masterIds = [...new Set((lines ?? []).map((l: any) => l.experience_line_master_id).filter(Boolean))];
  const { data: masters } = await sb.from("cluster4_experience_line_masters")
    .select("id, line_code, organization_slug, experience_slot_order, experience_category")
    .in("id", masterIds.length ? masterIds : ["00000000-0000-0000-0000-000000000000"]);
  const mById = new Map((masters ?? []).map((m: any) => [m.id, m]));
  console.log("── active experience lines:", (lines ?? []).length);
  for (const l of (lines ?? []) as any[]) {
    const m: any = l.experience_line_master_id ? mById.get(l.experience_line_master_id) : null;
    console.log(`  ${l.id.slice(0,8)} code=${l.line_code} closes=${String(l.submission_closes_at).slice(0,10)} master=${m ? `${m.line_code} slot=${m.experience_slot_order} org=${m.organization_slug}` : "NULL"}`);
  }
  // master 카탈로그 (slot 1~3, org별)
  const { data: allMasters } = await sb.from("cluster4_experience_line_masters")
    .select("id, line_code, organization_slug, experience_slot_order, is_active")
    .eq("is_active", true).in("experience_slot_order", [1, 2, 3]);
  const byOrgSlot = new Map<string, number>();
  for (const m of (allMasters ?? []) as any[]) {
    const k = `${m.organization_slug}:s${m.experience_slot_order}`;
    byOrgSlot.set(k, (byOrgSlot.get(k) ?? 0) + 1);
  }
  console.log("── master 카탈로그 (org:slot → 수):", JSON.stringify(Object.fromEntries([...byOrgSlot.entries()].sort())));

  // 2) 후보 주차: 종료 + 공표 + 비공식휴식 + (실유저 보호) start < 2026-05-04
  const { data: weeks } = await sb.from("weeks")
    .select("id, start_date, end_date, week_number, season_key, is_official_rest, result_published_at")
    .lt("end_date", "2026-06-04")
    .order("start_date");
  const pub = (weeks ?? []).filter((w: any) => w.result_published_at != null && !w.is_official_rest);
  console.log("── 종료+공표+비휴식 주차:", pub.length);
  for (const w of pub as any[]) {
    const guard = w.start_date < "2026-05-04" ? "" : "  ⚠ 실유저 카드 범위(>=05-04) — 제외 필요";
    console.log(`  ${w.start_date} ${w.season_key} w${w.week_number} published=${String(w.result_published_at).slice(0,10)}${guard}`);
  }

  // 3) 테스터 uws fail 분포 (<05-04, 공표 주차 한정) — 테스터별 가능 주차 수
  const { data: mk } = await sb.from("test_user_markers").select("user_id");
  const testers = (mk ?? []).map((m: any) => m.user_id);
  const pubStartsSafe = new Set(pub.filter((w: any) => w.start_date < "2026-05-04").map((w: any) => w.start_date));
  let counts: number[] = [];
  for (let i = 0; i < testers.length; i += 30) {
    const { data: ws } = await sb.from("user_week_statuses")
      .select("user_id, week_start_date, status").in("user_id", testers.slice(i, i + 30)).eq("status", "fail");
    const byUser = new Map<string, number>();
    for (const r of (ws ?? []) as any[]) {
      if (pubStartsSafe.has(r.week_start_date)) byUser.set(r.user_id, (byUser.get(r.user_id) ?? 0) + 1);
    }
    for (const id of testers.slice(i, i + 30)) counts.push(byUser.get(id) ?? 0);
  }
  counts.sort((a, b) => a - b);
  const hist = new Map<number, number>();
  for (const c of counts) hist.set(c, (hist.get(c) ?? 0) + 1);
  console.log("── 테스터별 가능 fail 주차 수 분포 (가능주차수→명):", JSON.stringify(Object.fromEntries([...hist.entries()].sort((a, b) => a[0] - b[0]))));
  console.log("   min/median/max:", counts[0], counts[Math.floor(counts.length / 2)], counts[counts.length - 1]);
}
main();

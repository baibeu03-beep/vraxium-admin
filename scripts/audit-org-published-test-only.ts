// 감사: cluster4_week_org_result_states.status='published' 중 실제 근거 uws 가 test-marker 유저뿐인
//   (= 실 검수 없음) org-week 를 찾는다. 백필이 T계정 uws 로 인해 잘못 published 로 잡은 케이스.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";

async function main() {
  const testIds = await fetchTestUserMarkerIds();
  const { data: states, error } = await supabaseAdmin
    .from("cluster4_week_org_result_states")
    .select("week_id,organization_slug,weeks!inner(start_date,week_number,season_key)")
    .eq("status", "published");
  if (error) throw error;

  const testOnly: Array<Record<string, unknown>> = [];
  const realBacked: Array<Record<string, unknown>> = [];
  for (const s of (states ?? []) as Array<{
    week_id: string; organization_slug: string;
    weeks: { start_date: string; week_number: number | null; season_key: string | null };
  }>) {
    const { data: uws } = await supabaseAdmin
      .from("user_week_statuses")
      .select("user_id,user_profiles!inner(organization_slug)")
      .eq("week_start_date", s.weeks.start_date)
      .eq("user_profiles.organization_slug", s.organization_slug);
    const users = (uws ?? []) as Array<{ user_id: string }>;
    const realUsers = users.filter((u) => !testIds.has(u.user_id));
    const rec = {
      org: s.organization_slug,
      season: s.weeks.season_key,
      week: s.weeks.week_number,
      start: s.weeks.start_date,
      totalUws: users.length,
      realUws: realUsers.length,
      testUws: users.length - realUsers.length,
    };
    if (users.length > 0 && realUsers.length === 0) testOnly.push(rec);
    else realBacked.push(rec);
  }

  console.log(`\n[published 상태] 총 ${(states ?? []).length}건`);
  console.log(`\n== 실 근거 없음(테스트 계정 uws 뿐) → published 오탐 후보 ${testOnly.length}건 ==`);
  for (const r of testOnly) console.log("  ", r);
  console.log(`\n== 실 유저 uws 존재(정상 published) ${realBacked.length}건 ==`);
  for (const r of realBacked) console.log("  ", r);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

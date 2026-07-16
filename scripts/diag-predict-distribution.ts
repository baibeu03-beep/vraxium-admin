/** READ-ONLY: 테스트 유저 공표주차 uws 행의 predict 결과 분포 (scenario 2 데이터 가용성 확인). */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { predictWeekStatusForUser } from "@/lib/crewWeekGrowthRejudge";
import { CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM } from "@/lib/lineAvailability";
import { isOrganizationSlug, type OrganizationSlug } from "@/lib/organizations";

async function main() {
  const { data: mk } = await supabaseAdmin.from("test_user_markers").select("user_id");
  const test = new Set(((mk ?? []) as Array<{ user_id: string }>).map((r) => r.user_id));
  const { data: wk } = await supabaseAdmin.from("weeks").select("id,start_date,is_official_rest,result_published_at").not("result_published_at", "is", null);
  const weeks = ((wk ?? []) as Array<{ id: string; start_date: string | null; is_official_rest: boolean | null }>)
    .filter((w) => w.start_date && w.start_date >= CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM && w.is_official_rest !== true);
  const orgOf = async (u: string): Promise<OrganizationSlug | null> => {
    const { data } = await supabaseAdmin.from("user_profiles").select("organization_slug").eq("user_id", u).maybeSingle();
    const s = (data as { organization_slug: string | null } | null)?.organization_slug ?? null;
    return s && isOrganizationSlug(s) ? s : null;
  };
  const dist: Record<string, number> = {};
  for (const w of weeks) {
    const { data: rows } = await supabaseAdmin.from("user_week_statuses").select("user_id,status").eq("week_start_date", w.start_date as string).in("status", ["success", "fail"]);
    for (const r of ((rows ?? []) as Array<{ user_id: string; status: string }>).filter((x) => test.has(x.user_id))) {
      const pred = await predictWeekStatusForUser({ userId: r.user_id, weekId: w.id, organizationSlug: await orgOf(r.user_id) });
      const key = pred.skipped ? `skip:${pred.skipReason}` : `predict:${pred.targetStatus}`;
      const combo = `stored=${r.status} → ${key}`;
      dist[combo] = (dist[combo] ?? 0) + 1;
    }
  }
  console.log("테스트 유저 공표주차 uws(success/fail) predict 분포:");
  for (const [k, v] of Object.entries(dist).sort()) console.log(`  ${v.toString().padStart(3)}  ${k}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

/**
 * 테스터 재분포 결과 검증 — 조직별 누적 성공 주차 분포 + 졸업 상태.
 *   npx tsx --env-file=.env.local scripts/verify-legacy-distribution.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { isTransitionWeekStart } from "@/lib/seasonCalendar";
import { GRADUATION_THRESHOLDS } from "@/lib/pointLabels";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const testerIds = (markers ?? []).map((m: any) => m.user_id);

  const profiles: any[] = [];
  for (let i = 0; i < testerIds.length; i += 150) {
    const { data } = await sb
      .from("user_profiles")
      .select("user_id,display_name,organization_slug,growth_status")
      .in("user_id", testerIds.slice(i, i + 150));
    profiles.push(...(data ?? []));
  }
  const uws: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("user_week_statuses")
      .select("user_id,week_start_date,status")
      .in("user_id", testerIds)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    uws.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }

  const successByUser = new Map<string, number>();
  for (const r of uws) {
    if (r.status !== "success") continue;
    if (isTransitionWeekStart(r.week_start_date)) continue;
    successByUser.set(r.user_id, (successByUser.get(r.user_id) ?? 0) + 1);
  }

  const byOrg = new Map<string, any[]>();
  for (const p of profiles) {
    const org = p.organization_slug ?? "unknown";
    if (!byOrg.has(org)) byOrg.set(org, []);
    byOrg.get(org)!.push(p);
  }
  for (const [org, ps] of byOrg) {
    const thr = (GRADUATION_THRESHOLDS as Record<string, number>)[org] ?? null;
    const rows = ps
      .map((p) => ({
        name: p.display_name,
        s: successByUser.get(p.user_id) ?? 0,
        g: p.growth_status,
      }))
      .sort((a, b) => b.s - a.s);
    const dist = rows.map((r) => r.s);
    const graduated = rows.filter((r) => r.g === "graduated");
    console.log(`\n[${org}] n=${rows.length} 임계=${thr}`);
    console.log(`  성공 주차 분포: ${dist.join(", ")}`);
    console.log(
      `  graduated(${graduated.length}): ${graduated.map((r) => `${r.name}=${r.s}`).join(", ")}`,
    );
    console.log(
      `  임계 충족(eligible): ${rows.filter((r) => thr != null && r.s >= thr).map((r) => `${r.name}=${r.s}`).join(", ") || "(없음)"}`,
    );
    // 다양성 간이 체크: 고유값 수
    console.log(`  고유 성공값 수: ${new Set(dist).size}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

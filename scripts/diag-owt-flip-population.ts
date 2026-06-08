/** flip 53건 모집단 진단 (read-only) — enforced 사용자 org 분포·테스터 여부·graduated 영향. */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  const ids = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data } = await sb
      .from("user_weekly_points")
      .select("user_id")
      .eq("checks_migrated", true)
      .order("id", { ascending: true })
      .range(from, from + 999);
    for (const r of (data ?? []) as { user_id: string }[]) ids.add(r.user_id);
    if ((data ?? []).length < 1000) break;
  }
  const arr = [...ids];
  type P = { user_id: string; organization_slug: string | null; display_name: string | null; growth_status: string | null };
  const profiles = new Map<string, P>();
  for (let i = 0; i < arr.length; i += 100) {
    const { data } = await sb
      .from("user_profiles")
      .select("user_id,organization_slug,display_name,growth_status")
      .in("user_id", arr.slice(i, i + 100));
    for (const r of (data ?? []) as P[]) profiles.set(r.user_id, r);
  }
  const dist = new Map<string, number>();
  for (const u of arr) {
    const k = String(profiles.get(u)?.organization_slug ?? "null");
    dist.set(k, (dist.get(k) ?? 0) + 1);
  }
  console.log("enforced 사용자 수:", arr.length);
  console.log("org 분포:", JSON.stringify([...dist]));
  const nonTester = arr.filter((u) => !/t/i.test(profiles.get(u)?.display_name ?? ""));
  console.log("비테스터(실사용자) enforced:", nonTester.length);
  const grad = arr.filter((u) => profiles.get(u)?.growth_status === "graduated");
  console.log("graduated enforced:", grad.length);
  for (const g of grad)
    console.log("  ", profiles.get(g)?.display_name, "|", profiles.get(g)?.organization_slug);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

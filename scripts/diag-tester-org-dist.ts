import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data: profs } = await sb.from("user_profiles").select("user_id, display_name, organization_slug");
  const all = (profs ?? []) as any[];
  const isT = (n: string | null) => !!n && /^T/.test(n ?? ""); // T-prefix
  const isTLoose = (n: string | null) => !!n && /t/i.test(n ?? "");
  const dist = (rows: any[]) => {
    const m = new Map<string, number>();
    rows.forEach((r) => m.set(r.organization_slug ?? "(null)", (m.get(r.organization_slug ?? "(null)") ?? 0) + 1));
    return Object.fromEntries(m);
  };
  const testers = all.filter((p) => isT(p.display_name));
  const loose = all.filter((p) => isTLoose(p.display_name) && !isT(p.display_name));
  const real = all.filter((p) => !isTLoose(p.display_name));
  console.log("total profiles:", all.length);
  console.log("T-prefix testers:", testers.length, dist(testers));
  console.log("t포함(비prefix):", loose.length, JSON.stringify(loose.map((p) => p.display_name)));
  console.log("real users:", real.length, dist(real));
  // test_user_markers 전체
  const { count } = await sb.from("test_user_markers").select("*", { count: "exact", head: true });
  console.log("test_user_markers count:", count);
  const { data: mk } = await sb.from("test_user_markers").select("user_id");
  const mkSet = new Set((mk ?? []).map((m: any) => m.user_id));
  console.log("markers ⊆ T-prefix?", testers.filter((t) => mkSet.has(t.user_id)).length, "/", mkSet.size);
}
main();

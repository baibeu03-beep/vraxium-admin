// 방패(net vs raw) 정의차 사례 dump — penalty>0 실유저의 표면별 표시값 비교.
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const testers = new Set((markers ?? []).map((m: any) => m.user_id));
  // PostgREST 1000행 cap — 전수 페이지네이션 필수.
  const uwp: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("user_weekly_points")
      .select("user_id, points, advantages, penalty")
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    uwp.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  const by = new Map<string, { star: number; adv: number; pen: number }>();
  for (const r of uwp ?? []) {
    const s = by.get(r.user_id) ?? { star: 0, adv: 0, pen: 0 };
    s.star += r.points ?? 0;
    s.adv += r.advantages ?? 0;
    s.pen += r.penalty ?? 0;
    by.set(r.user_id, s);
  }
  const { data: cum } = await sb
    .from("user_cumulative_points")
    .select("user_id, total_checks, total_advantages, total_raw_advantages, total_penalties, updated_at")
    .order("user_id", { ascending: true })
    .range(0, 1999);
  const cumBy = new Map((cum ?? []).map((c: any) => [c.user_id, c]));
  const { data: profs } = await sb
    .from("user_profiles")
    .select("user_id, display_name")
    .order("user_id", { ascending: true })
    .range(0, 1999);
  const nameBy = new Map((profs ?? []).map((p: any) => [p.user_id, p.display_name]));

  const cases = [...by.entries()].filter(([id, s]) => !testers.has(id) && s.pen > 0);
  console.log(`penalty>0 실유저 ${cases.length}명:`);
  for (const [id, s] of cases) {
    const c = cumBy.get(id) as any;
    console.log(
      `- ${nameBy.get(id) ?? "?"} (${id.slice(0, 8)}) live: star=${s.star} advRaw=${s.adv} pen=${s.pen} → net=${s.adv - Math.abs(s.pen)} | ` +
        `cache: checks=${c?.total_checks} adv=${c?.total_advantages} rawAdv=${c?.total_raw_advantages} pen=${c?.total_penalties} (upd ${String(c?.updated_at).slice(0, 10)})`,
    );
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

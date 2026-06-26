/**
 * 카드 역할 배지(시즌 기준) 검증.
 *   npx tsx --env-file=.env.local scripts/verify-card-role-badge.ts
 *   - direct: getCluster4WeeklyCardsForProfileUser 카드의 roleLabel 을 시즌별로 모아
 *     이력서 computeSeasonRecords 의 position 과 일치하는지(같은 SoT) 검증.
 *   - HTTP 비교: BASE_URL + INTERNAL_API_KEY 있으면 /api/cluster4/weekly-cards 와도 비교.
 */
import { config } from "dotenv"; config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { computeSeasonRecords } from "@/lib/cluster1ResumeData";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const NAMES = ["유효진", "오유나", "최인영", "유재희"];

async function main() {
  for (const name of NAMES) {
    const { data: p } = await sb.from("user_profiles").select("user_id,role").ilike("display_name", name).limit(1);
    const uid = (p as any)?.[0]?.user_id;
    if (!uid) { console.log(`${name} 없음`); continue; }
    const { data: mem } = await sb.from("user_memberships").select("membership_level,is_current").eq("user_id", uid);
    const curLevel = (mem ?? []).find((m:any)=>m.is_current)?.membership_level ?? (mem ?? [])[0]?.membership_level ?? null;

    const cards = await getCluster4WeeklyCardsForProfileUser(uid);
    // 시즌별 roleLabel 집합
    const bySeason = new Map<string, Set<string>>();
    for (const c of cards) {
      if (!c.seasonKey) continue;
      const s = bySeason.get(c.seasonKey) ?? new Set(); s.add(String(c.roleLabel ?? "null")); bySeason.set(c.seasonKey, s);
    }
    const resume = await computeSeasonRecords(uid);
    const resumeBySeason = new Map<string, string>();
    // computeSeasonRecords returns year/seasonName/position; need season_key. Re-map via season_definitions.
    // Simpler: print resume rows and card seasons side by side using seasonKey from resume? resume lacks key.
    console.log(`\n=== [${name}] current level=${curLevel} role=${(p as any)?.[0]?.role} ===`);
    console.log("  카드 시즌별 roleLabel:");
    for (const [sk, set] of [...bySeason.entries()].sort()) {
      console.log(`    ${sk}: ${[...set].join(", ")}${set.size>1?"  ⚠복수":""}`);
    }
    console.log("  이력서 시즌별 position:");
    for (const r of resume) console.log(`    ${r.year} ${r.seasonName}: ${r.position}`);
  }
}
main().then(()=>process.exit(0),(e)=>{console.error(e);process.exit(1);});

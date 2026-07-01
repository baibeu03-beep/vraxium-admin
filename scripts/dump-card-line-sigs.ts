/**
 * dump-card-line-sigs.ts — 표본 사용자의 weekly-cards 라인 신원(sig)을 JSON 으로 덤프.
 *   git stash 전/후 두 번 실행해 "스코프 패치의 순수 효과"를 baked snapshot drift 와 분리한다.
 * 사용: npx tsx --env-file=.env.local scripts/dump-card-line-sigs.ts <outPath>
 */
import { config } from "dotenv"; config({ path: ".env.local" });
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { WEEKLY_CARDS_DTO_VERSION } from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);
const ORG = "encre";
const outPath = process.argv[2] || "scratch-sigs.json";

type Card = { weekId?: string | null; lines?: Array<{ lineId?: string | null; partType?: string | null; enhancementStatus?: string | null; status?: string | null }> };
const sigs = (cards: Card[]): string[] => {
  const out: string[] = [];
  for (const c of cards) for (const l of c.lines ?? [])
    out.push(`${c.weekId}|${l.partType}|${l.lineId ?? "∅"}|${l.status ?? "∅"}|${l.enhancementStatus ?? "∅"}`);
  return out.sort();
};

async function main() {
  const { data: m } = await sb.from("test_user_markers").select("user_id");
  const markers = new Set(((m ?? []) as { user_id: string }[]).map((r) => r.user_id));
  const { data: profs } = await sb.from("user_profiles").select("user_id")
    .eq("organization_slug", ORG).order("user_id").limit(800);
  const ids = ((profs ?? []) as { user_id: string }[]).map((r) => r.user_id);
  const real: string[] = []; const test: string[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const { data: snaps } = await sb.from("cluster4_weekly_card_snapshots")
      .select("user_id,is_stale,dto_version").in("user_id", ids.slice(i, i + 50))
      .eq("dto_version", WEEKLY_CARDS_DTO_VERSION);
    for (const s of (snaps ?? []) as { user_id: string; is_stale: boolean }[]) {
      if (s.is_stale) continue;
      if (markers.has(s.user_id)) { if (test.length < 6) test.push(s.user_id); }
      else if (real.length < 6) real.push(s.user_id);
    }
    if (real.length >= 6 && test.length >= 6) break;
  }
  const result: Record<string, { role: "real" | "test"; sigs: string[] }> = {};
  for (const uid of real) result[uid] = { role: "real", sigs: sigs((await getCluster4WeeklyCardsForProfileUser(uid)) as Card[]) };
  for (const uid of test) result[uid] = { role: "test", sigs: sigs((await getCluster4WeeklyCardsForProfileUser(uid)) as Card[]) };
  writeFileSync(outPath, JSON.stringify(result, null, 0));
  console.log(`dumped ${Object.keys(result).length} users → ${outPath}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

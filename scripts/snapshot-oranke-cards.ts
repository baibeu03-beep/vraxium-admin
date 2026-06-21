/**
 * snapshot-oranke-cards.ts (READ-ONLY)
 * 샘플 오랑캐 실사용자들의 고객 weekly-cards(getCluster4WeeklyCardsForProfileUser)를 계산해
 * 캘린더 활동유형 카드 + 전체 카드 해시를 OUT 파일에 기록. 백필 전/후 비교용.
 * 실행: OUT=claudedocs/oranke-cards-before.json npx tsx --env-file=.env.local scripts/snapshot-oranke-cards.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const OUT = process.env.OUT ?? "claudedocs/oranke-cards-snapshot.json";

// W11 38 타깃 + 추가 오랑캐 실사용자 샘플.
async function sampleUserIds(): Promise<string[]> {
  // W11 캘린더 라인 타깃(실사용자) 전원.
  const { data: tg } = await sb
    .from("cluster4_line_targets")
    .select("target_user_id")
    .eq("line_id", "862c2d40-4ed0-4776-8cfc-b6db98d1c4d4")
    .eq("target_mode", "user");
  const w11 = ((tg ?? []) as Array<{ target_user_id: string | null }>)
    .map((t) => t.target_user_id)
    .filter((x): x is string => Boolean(x));
  // 추가 오랑캐 실사용자 20명(가입 프로필 기준).
  const { data: more } = await sb
    .from("user_profiles")
    .select("user_id")
    .eq("organization_slug", "oranke")
    .limit(60);
  const extra = ((more ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
  return Array.from(new Set([...w11, ...extra]));
}

function calendarCards(cards: unknown): unknown[] {
  if (!Array.isArray(cards)) return [];
  const out: unknown[] = [];
  for (const c of cards as Array<Record<string, unknown>>) {
    const lines = Array.isArray(c.lines) ? (c.lines as Array<Record<string, unknown>>) : [];
    for (const l of lines) {
      if (l.activityTypeId === "calendar" || l.partType === "information") {
        out.push({ weekId: c.weekId, line: l });
      }
    }
  }
  return out;
}

async function main() {
  const ids = await sampleUserIds();
  console.log(`샘플 ${ids.length}명 카드 계산 중…`);
  const result: Record<string, { hash: string; cardCount: number; calendar: unknown[] }> = {};
  let i = 0;
  for (const uid of ids) {
    try {
      const cards = await getCluster4WeeklyCardsForProfileUser(uid);
      const json = JSON.stringify(cards);
      result[uid] = {
        hash: createHash("sha256").update(json).digest("hex"),
        cardCount: Array.isArray(cards) ? cards.length : 0,
        calendar: calendarCards(cards),
      };
    } catch (e) {
      result[uid] = { hash: `ERROR:${e instanceof Error ? e.message : e}`, cardCount: -1, calendar: [] };
    }
    if (++i % 10 === 0) console.log(`  ${i}/${ids.length}`);
  }
  writeFileSync(OUT, JSON.stringify(result, null, 2));
  const calCount = Object.values(result).filter((r) => r.calendar.length > 0).length;
  console.log(`\n→ ${OUT} 기록 (${ids.length}명, 캘린더 카드 보유 ${calCount}명)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/** 백필 주차(uws=success)인데 snapshot 카드가 fail 로 보이는 테스터/주차 감사 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const log = JSON.parse(readFileSync("claudedocs/tester-experience-success-backfill-v13-20260604-inserted.json", "utf8"));
  const pairs: { userId: string; weekStart: string }[] = log.runs.flatMap((r: any) => r.uwsFlipped ?? []);
  const byUser = new Map<string, Set<string>>();
  for (const p of pairs) {
    if (!byUser.has(p.userId)) byUser.set(p.userId, new Set());
    byUser.get(p.userId)!.add(p.weekStart);
  }
  let badUsers = 0, badWeeks = 0, okUsers = 0;
  for (const [uid, weeksSel] of byUser) {
    const snap: any = await readWeeklyCardsSnapshot(uid);
    const cards: any[] = snap?.cards ?? [];
    const bad = cards.filter((c) => weeksSel.has(String(c.startDate).slice(0, 10)) && c.userWeekStatus !== "success");
    if (bad.length > 0) {
      badUsers++; badWeeks += bad.length;
      if (badUsers <= 8) console.log(`✗ ${uid.slice(0,8)}: ${bad.map((c: any) => `${c.startDate}=${c.userWeekStatus}`).join(", ")}`);
    } else okUsers++;
  }
  console.log(`\n감사 결과: 정상 ${okUsers}명 / 오염 ${badUsers}명 (${badWeeks}주차가 success 아님)`);
}
main();

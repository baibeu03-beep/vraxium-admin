// is_stale 일괄 드레인: 현재 is_stale=true 인 snapshot 을 수정된 코드로 재계산해 is_stale=0 으로
// 수렴시키고, 수렴 여부를 확인한다(운영자 동시 편집이 재마킹하면 잔여가 남을 수 있음 — 그 경우 보고).
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { recomputeWeeklyCardsSnapshotsForUsers, WEEKLY_CARDS_DTO_VERSION } from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const T = "cluster4_weekly_card_snapshots";

async function staleIds(): Promise<string[]> {
  const ids: string[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from(T).select("user_id").eq("is_stale", true).order("user_id").range(f, f + 999);
    if (error) throw new Error(error.message);
    const b = (data ?? []) as { user_id: string }[];
    ids.push(...b.map((r) => r.user_id));
    if (b.length < 1000) break;
  }
  return ids;
}
async function counts() {
  let stale = 0, v24 = 0, tot = 0;
  for (let f = 0; ; f += 1000) {
    const { data } = await sb.from(T).select("is_stale,dto_version").range(f, f + 999);
    const b = (data ?? []) as { is_stale: boolean; dto_version: number }[];
    tot += b.length; stale += b.filter((r) => r.is_stale).length; v24 += b.filter((r) => r.dto_version === WEEKLY_CARDS_DTO_VERSION).length;
    if (b.length < 1000) break;
  }
  return { stale, v24, tot };
}

async function main() {
  console.log(`드레인 시작 (LATEST=v${WEEKLY_CARDS_DTO_VERSION})`);
  for (let round = 1; round <= 6; round++) {
    const ids = await staleIds();
    const c0 = await counts();
    console.log(`[round ${round}] 시작 is_stale=${ids.length} (tot=${c0.tot} v24=${c0.v24})`);
    if (ids.length === 0) { console.log(`\n✅ is_stale = 0 — 드레인 완료(전수 v24=${c0.v24}/${c0.tot}).`); return; }
    const r = await recomputeWeeklyCardsSnapshotsForUsers(ids, { concurrency: 4 });
    const c1 = await counts();
    console.log(`           recomputed=${r.recomputed} failed=${r.failed} → 잔여 is_stale=${c1.stale}`);
    if (c1.stale === 0) { console.log(`\n✅ is_stale = 0 도달 (전수 v24=${c1.v24}/${c1.tot}).`); return; }
    if (c1.stale >= ids.length) {
      console.log(`\n⚠ 잔여(${c1.stale}) ≥ 직전(${ids.length}) — 동시 운영자 편집이 재마킹 중. 드레인은 동작하나 라이브 편집으로 0 미수렴.`);
    }
  }
  const cf = await counts();
  console.log(`\n종료. 최종 is_stale=${cf.stale} (전수 v24=${cf.v24}/${cf.tot}). 잔여가 있으면 라이브 편집 재마킹분 — 편집 종료 후 동일 드레인으로 0 수렴.`);
}
main().catch((e) => { console.error(e); process.exit(1); });

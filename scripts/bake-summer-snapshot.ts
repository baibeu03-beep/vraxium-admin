/**
 * 테스트 계정 snapshot 을 2026-06-29 시뮬레이션 시계로 굽거나(bake) 실시계로 원복(restore).
 *   브라우저 검증용 — admin /api/cluster4/weekly-cards 가 이 snapshot 을 서빙한다.
 *   ⚠ test_user_markers 만 허용. user_week_statuses 미접촉(snapshot 캐시만).
 *
 *   npx tsx --env-file=.env.local scripts/bake-summer-snapshot.ts bake <testUserId>
 *   npx tsx --env-file=.env.local scripts/bake-summer-snapshot.ts restore <testUserId>
 */
const FIXED = Date.UTC(2026, 5, 29, 0, 0, 1);
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...a: any[]) { if (a.length === 0) { super(FIXED); } else { super(...(a as [])); } }
  static now() { return FIXED; }
}
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { recomputeAndStoreWeeklyCardsSnapshot, readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

async function main() {
  const mode = (process.argv[2] || "").trim();
  const userId = (process.argv[3] || "a80ea67a-8836-4c13-8568-66dff79d7a66").trim();
  const { data: marker } = await supabaseAdmin.from("test_user_markers").select("user_id").eq("user_id", userId).maybeSingle();
  if (!marker) { console.error("거부: test_user_markers 아님", userId); process.exit(2); }

  if (mode === "bake") {
    // @ts-expect-error sim
    globalThis.Date = FakeDate;
    await recomputeAndStoreWeeklyCardsSnapshot(userId);
    globalThis.Date = RealDate;
    const s = await readWeeklyCardsSnapshot(userId);
    const cards = s.status === "hit" || s.status === "stale" ? s.cards : [];
    const w1 = cards.find((c) => c.seasonKey === "2026-summer" && c.weekNumber === 1);
    console.log("[bake] done. summer W1:", w1 ? `${w1.userWeekStatus}/${w1.statusLabel}` : "MISSING");
  } else if (mode === "restore") {
    await recomputeAndStoreWeeklyCardsSnapshot(userId);
    console.log("[restore] done (실시계 recompute).");
  } else {
    console.error("usage: bake|restore <userId>"); process.exit(1);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

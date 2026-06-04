// READ-ONLY: snapshot 신선도/stale 분포 — 재계산 트리거 실체 추정용
import { createClient } from "@supabase/supabase-js";
import { WEEKLY_CARDS_DTO_VERSION } from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  const { data, error } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id, dto_version, is_stale, computed_at, card_count");
  if (error) throw error;
  const rows = data ?? [];
  console.log(`총 snapshot: ${rows.length}건 | 기대 dto_version=${WEEKLY_CARDS_DTO_VERSION}`);
  const stale = rows.filter((r: any) => r.is_stale);
  const verMismatch = rows.filter((r: any) => String(r.dto_version) !== String(WEEKLY_CARDS_DTO_VERSION));
  console.log(`is_stale=true: ${stale.length}건 | dto_version 불일치: ${verMismatch.length}건`);
  if (verMismatch.length) {
    const dist: Record<string, number> = {};
    for (const r of verMismatch) dist[r.dto_version] = (dist[r.dto_version] ?? 0) + 1;
    console.log("  버전 분포:", JSON.stringify(dist));
  }

  // computed_at 시간대 분포 (최근 갱신 패턴)
  const hours: Record<string, number> = {};
  for (const r of rows) {
    const h = String(r.computed_at ?? "").slice(0, 13); // YYYY-MM-DDTHH
    hours[h] = (hours[h] ?? 0) + 1;
  }
  console.log("\ncomputed_at 시간대(UTC) 분포:");
  for (const k of Object.keys(hours).sort()) console.log(`  ${k}: ${hours[k]}건`);

  const sorted = rows.map((r: any) => r.computed_at).sort();
  console.log(`\n가장 오래된 computed_at: ${sorted[0]}`);
  console.log(`가장 최근   computed_at: ${sorted[sorted.length - 1]}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

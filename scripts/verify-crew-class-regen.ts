// 스냅샷 재생성 前後 crewClassPositionCode 대조 (전성은·유재희 한정 실기록).
// 사용: npx tsx --env-file=.env.local scripts/verify-crew-class-regen.ts
import { createClient } from "@supabase/supabase-js";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";
import { positionCodeToClassLabel } from "@/shared/crewClassPosition";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const IDS = [
  { id: "e318c666-b5f4-4508-916b-a228995baf15", name: "전성은" },
  { id: "16000b1f-30ad-4187-9754-11199a577a09", name: "유재희" },
];

async function snap(id: string) {
  const { data } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("dto_version,cards")
    .eq("user_id", id)
    .maybeSingle();
  const cards = (data?.cards ?? []) as Array<{ seasonKey?: string; crewClassPositionCode?: string | null; roleLabel?: string | null }>;
  const seasons = new Map<string, string>();
  for (const c of cards) {
    const k = c.seasonKey ?? "?";
    if (!seasons.has(k)) seasons.set(k, `code=${c.crewClassPositionCode ?? "(absent)"} class=${positionCodeToClassLabel((c.crewClassPositionCode ?? null) as never) ?? "-"} roleLabel=${c.roleLabel}`);
  }
  return { version: data?.dto_version, seasons };
}

async function main() {
  for (const u of IDS) {
    const before = await snap(u.id);
    console.log(`\n### ${u.name} — BEFORE (dto_version=${before.version})`);
    for (const [s, v] of before.seasons) console.log(`   ${s}: ${v}`);
  }
  console.log("\n>>> recompute...");
  await recomputeWeeklyCardsSnapshotsForUsers(IDS.map((u) => u.id));
  for (const u of IDS) {
    const after = await snap(u.id);
    console.log(`\n### ${u.name} — AFTER (dto_version=${after.version})`);
    for (const [s, v] of after.seasons) console.log(`   ${s}: ${v}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });

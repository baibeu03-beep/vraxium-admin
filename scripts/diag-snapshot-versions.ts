// snapshot dto_version / is_stale 분포 진단(READ-ONLY).
//   npx tsx --env-file=.env.local scripts/diag-snapshot-versions.ts
import { createClient } from "@supabase/supabase-js";
import { WEEKLY_CARDS_DTO_VERSION } from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  const { data, error } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("dto_version,is_stale");
  if (error) {
    console.log("ERR", error.message);
    return;
  }
  const rows = (data ?? []) as { dto_version: number; is_stale: boolean }[];
  const byVer: Record<string, number> = {};
  let stale = 0;
  for (const r of rows) {
    byVer[r.dto_version] = (byVer[r.dto_version] ?? 0) + 1;
    if (r.is_stale) stale++;
  }
  console.log("total rows        :", rows.length);
  console.log("dto_version 분포   :", JSON.stringify(byVer));
  console.log("is_stale=true     :", stale);
  console.log("CODE 기대 버전     :", WEEKLY_CARDS_DTO_VERSION);
  const mismatched = rows.filter((r) => r.dto_version !== WEEKLY_CARDS_DTO_VERSION).length;
  console.log(
    `버전 불일치(=읽기 MISS 유발): ${mismatched}/${rows.length}`,
    mismatched > 0 ? "⚠ 전원 재계산 위험 → 재백필 필요" : "✅",
  );
}
main().catch((e) => { console.error(e); process.exit(1); });

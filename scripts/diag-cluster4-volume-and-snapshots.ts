/**
 * READ-ONLY: 1000행 cap 가설 정량화 + snapshot 버전/staleness 점검.
 *   npx tsx --env-file=.env.local scripts/diag-cluster4-volume-and-snapshots.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { WEEKLY_CARDS_DTO_VERSION } from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function count(table: string, mod?: (q: any) => any): Promise<number> {
  let q = sb.from(table).select("id", { count: "exact", head: true });
  if (mod) q = mod(q);
  const { count, error } = await q;
  if (error) return -1;
  return count ?? -1;
}

async function main() {
  console.log(`현재 DTO 버전 = ${WEEKLY_CARDS_DTO_VERSION}\n`);

  const totalTargets = await count("cluster4_line_targets");
  const expLines = await count("cluster4_lines", (q: any) => q.eq("part_type", "experience").eq("is_active", true));
  const allActiveLines = await count("cluster4_lines", (q: any) => q.eq("is_active", true));
  console.log(`cluster4_line_targets 전체 행수 = ${totalTargets}`);
  console.log(`active experience lines = ${expLines}`);
  console.log(`active lines 전체 = ${allActiveLines}`);
  console.log(`→ 1000행 cap 가설: 한 사용자 카드 weeks 의 누적 target 행이 1000 근처여야 두 경로 truncation 비대칭 발생.`);
  console.log(`   현재 전체 target 행수(${totalTargets})가 1000 미만이면 이 데이터셋에선 재현 불가(=latent).\n`);

  // 주차별 target 행수 상위 — 특정 주차가 cap 에 근접하는지
  const { data: tRows } = await sb.from("cluster4_line_targets").select("week_id").limit(20000);
  const byWeek = new Map<string, number>();
  for (const r of (tRows ?? []) as { week_id: string }[]) byWeek.set(r.week_id, (byWeek.get(r.week_id) ?? 0) + 1);
  const top = [...byWeek.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log("주차별 target 행수 상위 8:");
  for (const [w, n] of top) console.log(`  week=${String(w).slice(0, 8)}  rows=${n}`);

  // snapshot 버전 분포
  const { data: snaps } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,dto_version,is_stale,computed_at");
  const rows = (snaps ?? []) as { user_id: string; dto_version: number; is_stale: boolean; computed_at: string }[];
  const verDist = new Map<number, number>();
  let staleCount = 0;
  let mismatchVer = 0;
  for (const r of rows) {
    verDist.set(r.dto_version, (verDist.get(r.dto_version) ?? 0) + 1);
    if (r.is_stale) staleCount++;
    if (r.dto_version !== WEEKLY_CARDS_DTO_VERSION) mismatchVer++;
  }
  console.log(`\nsnapshot 총 ${rows.length}행`);
  console.log(`  dto_version 분포: ${JSON.stringify([...verDist.entries()])}`);
  console.log(`  is_stale=true: ${staleCount}행`);
  console.log(`  현재버전(${WEEKLY_CARDS_DTO_VERSION}) 불일치(=stale 서빙 대상): ${mismatchVer}행`);
  console.log(`  → 불일치/stale 행이 있으면 고객앱은 구 정책 카드(구 experience 분모/뱃지)를 그대로 노출 중일 수 있음.`);

  console.log("\n══ 종료(읽기 전용) ══");
}
main().catch((e) => { console.error(e); process.exit(1); });

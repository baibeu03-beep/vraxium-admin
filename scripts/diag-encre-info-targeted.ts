/**
 * diag-encre-info-targeted.ts (READ-ONLY)
 * 특정 EC info 라인이 (a) 어드민 info-line-results 에 보이고 (b) 그 라인의 target 고객 카드
 * (live + snapshot) 에 실제로 information 라인으로 렌더되는지 직접 대조.
 *   npx tsx --env-file=.env.local scripts/diag-encre-info-targeted.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

async function dumpCardInfo(label: string, cards: any[], weekId: string) {
  const card = cards.find((c) => c.weekId === weekId);
  if (!card) return console.log(`    [${label}] 해당 주차 카드 없음`);
  const infos = (card.lines ?? []).filter((l: any) => l.partType === "information");
  console.log(`    [${label}] 주차상태=${card.userWeekStatus} info라인=${infos.length}건`);
  for (const l of infos) {
    console.log(`        lineId=${l.lineId?.slice(0, 8)} status=${l.status} display=${l.displayLineCode} "${(l.mainTitle ?? "").slice(0, 28)}"`);
  }
}

async function main() {
  // target 수 많은 EC info 라인 상위 몇 개
  const { data: ecLines } = await sb
    .from("cluster4_lines")
    .select("id,line_code,main_title,week_id,activity_type_id")
    .eq("part_type", "info").eq("is_active", true)
    .like("line_code", "%EC%");
  const lines = (ecLines ?? []) as Array<{ id: string; line_code: string; main_title: string | null; week_id: string; activity_type_id: string | null }>;

  // 각 라인 target user 수
  const withTargets: Array<{ line: typeof lines[0]; targets: string[] }> = [];
  for (const l of lines) {
    const { data: tg } = await sb
      .from("cluster4_line_targets")
      .select("target_user_id")
      .eq("line_id", l.id).eq("target_mode", "user");
    const targets = ((tg ?? []) as Array<{ target_user_id: string | null }>).map((r) => r.target_user_id).filter(Boolean) as string[];
    if (targets.length > 0) withTargets.push({ line: l, targets });
  }
  withTargets.sort((a, b) => b.targets.length - a.targets.length);
  console.log(`EC info 라인 중 target>0 = ${withTargets.length}건. 상위 4개 검사:\n`);

  for (const { line, targets } of withTargets.slice(0, 4)) {
    console.log(`■ ${line.line_code} wk=${line.week_id.slice(0, 8)} targets=${targets.length} "${(line.main_title ?? "").slice(0, 30)}"`);

    // (a) target user 들이 encre org 인지 + 그 user 의 카드에 이 라인이 보이는지
    const u = targets[0];
    const { data: prof } = await sb.from("user_profiles").select("organization_slug,display_name").eq("user_id", u).maybeSingle();
    console.log(`  target[0]=${u.slice(0, 8)} org=${(prof as any)?.organization_slug} name=${(prof as any)?.display_name}`);

    let live: any[] = [];
    try { live = await getCluster4WeeklyCardsForProfileUser(u); } catch (e) { console.log("  live 실패", e instanceof Error ? e.message : e); }
    const snap = await readWeeklyCardsSnapshot(u);
    const snapCards = snap.status === "hit" || snap.status === "stale" ? (snap.cards as any[]) : [];

    await dumpCardInfo("LIVE", live, line.week_id);
    await dumpCardInfo(`SNAP(${snap.status})`, snapCards, line.week_id);

    // 이 라인 id 가 카드에 있는지 명시 체크
    const inLive = live.some((c) => c.weekId === line.week_id && (c.lines ?? []).some((l: any) => l.lineId === line.id));
    const inSnap = snapCards.some((c) => c.weekId === line.week_id && (c.lines ?? []).some((l: any) => l.lineId === line.id));
    console.log(`  ▶ 이 라인(${line.id.slice(0, 8)}) 노출: LIVE=${inLive} SNAP=${inSnap}\n`);
  }
}

main().catch((e) => { console.error("ERR", e instanceof Error ? e.stack : e); process.exit(1); });

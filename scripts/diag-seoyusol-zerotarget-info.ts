/**
 * diag-seoyusol-zerotarget-info.ts (READ-ONLY)
 * 서유솔(encre) 25가을 13주차 위즈덤/캘린더/아카데미 info 라인이 target 0명이라 고객 카드에서
 * 누락되는지 전수 진단. cluster4_line_targets 를 채우지 않는다(읽기 전용).
 *   npx tsx --env-file=.env.local scripts/diag-seoyusol-zerotarget-info.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { resolveLineScopeFromValues, isLineScopeVisibleForOrg } from "@/lib/lineScope";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

async function main() {
  // 1) 서유솔 encre
  const { data: users } = await sb.from("user_profiles").select("user_id,display_name,organization_slug").eq("display_name", "서유솔");
  const cands = (users ?? []) as Array<{ user_id: string; display_name: string; organization_slug: string }>;
  console.log("[서유솔 후보]", cands.map((u) => `${u.user_id.slice(0, 8)}/${u.organization_slug}`).join(", "));
  const user = cands.find((u) => u.organization_slug === "encre") ?? cands[0];
  if (!user) return console.log("서유솔 not found");
  console.log(`→ user=${user.user_id} org=${user.organization_slug}\n`);

  // 1) 25가을 13주차 week_id
  const { data: weeks } = await sb
    .from("weeks")
    .select("id,season_key,week_number,start_date,is_official_rest")
    .eq("season_key", "2025-autumn").eq("week_number", 13);
  const wk = (weeks ?? [])[0] as { id: string; season_key: string; week_number: number; start_date: string } | undefined;
  if (!wk) return console.log("2025-autumn W13 주차 없음");
  console.log(`[1] 25가을 13주차 week_id=${wk.id} start=${wk.start_date}\n`);

  // 2) 그 주차 info 라인 전수(active 무관) — line_code/is_active/title
  const { data: lines } = await sb
    .from("cluster4_lines")
    .select("id,line_code,main_title,is_active,part_type,activity_type_id")
    .eq("part_type", "info").eq("week_id", wk.id);
  const infoLines = (lines ?? []) as Array<{ id: string; line_code: string | null; main_title: string | null; is_active: boolean; activity_type_id: string | null }>;
  console.log(`[2] 25가을W13 info 라인 ${infoLines.length}건:`);
  for (const l of infoLines) {
    // 3) target count (user-mode 실제 + sentinel 분리)
    const { data: tg } = await sb.from("cluster4_line_targets").select("id,target_mode,target_rule").eq("line_id", l.id);
    const rows = (tg ?? []) as Array<{ target_mode: string; target_rule: any }>;
    const userTargets = rows.filter((r) => !(r.target_mode === "rule" && r.target_rule?.zeroTargetOpen === true));
    const sentinels = rows.filter((r) => r.target_mode === "rule" && r.target_rule?.zeroTargetOpen === true);
    // 4) org visibility
    const scope = resolveLineScopeFromValues({ partType: "info", lineCode: l.line_code });
    const visibleToEncre = isLineScopeVisibleForOrg(scope, "encre", { allowUnknown: false });
    console.log(
      `   ${l.line_code ?? "(null)"}  active=${l.is_active}  userTgt=${userTargets.length} sentinel=${sentinels.length}  ` +
      `org=${scope.org}/${scope.source} encre가시=${visibleToEncre}  "${(l.main_title ?? "").slice(0, 26)}"`,
    );
  }

  // 5) 서유솔 카드(live + snapshot)에 이 주차 info 라인이 몇 개 보이는지
  console.log(`\n[5/6] 서유솔 카드의 25가을W13 info 라인:`);
  const live = await getCluster4WeeklyCardsForProfileUser(user.user_id);
  const snap = await readWeeklyCardsSnapshot(user.user_id);
  const snapCards = snap.status === "hit" || snap.status === "stale" ? (snap.cards as any[]) : [];
  const dump = (label: string, cards: any[]) => {
    const c = cards.find((x) => x.weekId === wk.id);
    if (!c) return console.log(`   [${label}] 주차 카드 없음`);
    const infos = (c.lines ?? []).filter((l: any) => l.partType === "information");
    console.log(`   [${label}] status=${c.userWeekStatus} info라인=${infos.length}건: ` + infos.map((l: any) => `${l.displayLineCode}/${l.status}/"${(l.mainTitle ?? "").slice(0, 16)}"`).join(" | "));
  };
  dump("LIVE", live);
  dump(`SNAP(${snap.status})`, snapCards);

  console.log(`\n⇒ 어드민 개설 라인 ${infoLines.filter((l) => l.is_active).length}건 vs 고객 카드 노출 ${(live.find((c: any) => c.weekId === wk.id)?.lines ?? []).filter((l: any) => l.partType === "information").length}건`);
}

main().catch((e) => { console.error("ERR", e instanceof Error ? e.stack : e); process.exit(1); });

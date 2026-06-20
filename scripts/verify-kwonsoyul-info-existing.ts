/**
 * verify-kwonsoyul-info-existing.ts (READ-ONLY)
 * T권소율 W1~W11 info 라인: admin 저장원본 == direct(live) == snapshot(고객 SoT) 비교.
 * 실행: npx tsx --env-file=.env.local scripts/verify-kwonsoyul-info-existing.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const ORG = "oranke";

function infoOf(cards: any[], wnumById: Map<string, number>) {
  const out: Record<number, any[]> = {};
  for (const c of cards) {
    const wn = wnumById.get(c.weekId);
    if (wn == null) continue;
    const infos = (c.lines ?? []).filter((l: any) => l.partType === "information" && l.lineId);
    if (infos.length) out[wn] = infos.map((l: any) => ({ lineId: l.lineId, lineCode: l.lineCode, mainTitle: l.mainTitle, status: l.status }));
  }
  return out;
}

async function main() {
  const { data: profs } = await sb.from("user_profiles").select("user_id,display_name,organization_slug")
    .or("display_name.ilike.%권소율%,display_name.ilike.%T권소율%");
  const me = (profs ?? []).find((p: any) => p.organization_slug === ORG) as any;
  const u = me.user_id;
  const { data: weeks } = await sb.from("weeks").select("id,week_number").eq("season_key", "2026-spring").gte("week_number", 1).lte("week_number", 11);
  const wnumById = new Map((weeks ?? []).map((w: any) => [w.id, w.week_number]));

  // (A) snapshot (고객 HTTP SoT)
  const snap = await readWeeklyCardsSnapshot(u);
  console.log(`[7] snapshot status=${snap.status} stale=${(snap as any).reason ?? (snap.status === "hit" ? "false" : "?")} computed_at=${(snap as any).computedAt ?? "-"}`);
  const snapInfo = snap.status === "hit" || snap.status === "stale" ? infoOf((snap as any).cards, wnumById) : {};

  // (B) direct (live compute)
  const live = await getCluster4WeeklyCardsForProfileUser(u);
  const liveInfo = infoOf(live, wnumById);

  // (C) admin 저장원본
  const allLineIds = [...new Set(Object.values(snapInfo).flat().map((x: any) => x.lineId))];
  const { data: srcRows } = await sb.from("cluster4_lines").select("id,line_code,main_title").in("id", allLineIds);
  const srcById = new Map((srcRows ?? []).map((r: any) => [r.id, r]));

  let totalSnap = 0, codeMatch = 0, titleMatch = 0, directEqSnap = 0, totalCompare = 0;
  console.log(`\n[주차별 — admin원본 / direct(live) / snapshot]`);
  for (const wn of [...Array(11)].map((_, i) => i + 1)) {
    const s = snapInfo[wn] ?? [];
    const d = liveInfo[wn] ?? [];
    totalSnap += s.length;
    for (const item of s) {
      const src = srcById.get(item.lineId);
      const dItem = d.find((x: any) => x.lineId === item.lineId);
      const cOk = src && src.line_code === item.lineCode;
      const tOk = src && src.main_title === item.mainTitle;
      const dOk = dItem && dItem.lineCode === item.lineCode && dItem.mainTitle === item.mainTitle;
      if (cOk) codeMatch++; if (tOk) titleMatch++; if (dOk) directEqSnap++; totalCompare++;
      console.log(`  W${String(wn).padStart(2)} ${String(item.lineCode).padEnd(24)} code:${cOk ? "✅" : "❌"} title:${tOk ? "✅" : "❌"} direct==snap:${dOk ? "✅" : "❌"} | "${String(item.mainTitle).slice(0, 24)}"`);
    }
  }
  console.log(`\n[1] admin line_code == 고객 DTO line_code : ${codeMatch}/${totalCompare}`);
  console.log(`[2] admin mainTitle == 고객 DTO mainTitle : ${titleMatch}/${totalCompare}`);
  console.log(`[5] direct == snapshot(HTTP) : ${directEqSnap}/${totalCompare}`);
  console.log(`[info 라인 총수] snapshot=${totalSnap}`);
}

main().catch((e) => { console.error("ERR", e); process.exit(1); });

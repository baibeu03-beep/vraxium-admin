/**
 * verify-kwonsoyul-info-displaycode.ts
 * info 라인 displayLineCode(IFBS-NN000X) 도입 검증 + T권소율 snapshot 재계산.
 *   admin(line_registrations) 코드 == direct DTO displayLineCode == snapshot displayLineCode
 *   내부 lineCode(info-OK-...)는 displayLineCode 로 노출 안 됨.
 * 실행: npx tsx --env-file=.env.local scripts/verify-kwonsoyul-info-displaycode.ts [--recompute]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import {
  readWeeklyCardsSnapshot,
  recomputeAndStoreWeeklyCardsSnapshot,
  WEEKLY_CARDS_DTO_VERSION,
} from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const ORG = "oranke";
const RECOMPUTE = process.argv.includes("--recompute");
const INTERNAL_RE = /info-OK-|info-EC-|info-PX-|-OPEN\d{6,}/; // 내부코드 패턴

function infoLines(cards: any[], wnumById: Map<string, number>) {
  const out: any[] = [];
  for (const c of cards) {
    const wn = wnumById.get(c.weekId); if (wn == null) continue;
    for (const l of (c.lines ?? [])) {
      if (l.partType === "information" && l.lineId)
        out.push({ wn, activityTypeId: l.activityTypeId, activityTypeName: l.activityTypeName, lineCode: l.lineCode, displayLineCode: l.displayLineCode });
    }
  }
  return out.sort((a, b) => a.wn - b.wn || String(a.activityTypeId).localeCompare(b.activityTypeId));
}

async function main() {
  console.log(`# WEEKLY_CARDS_DTO_VERSION=${WEEKLY_CARDS_DTO_VERSION}`);
  const { data: profs } = await sb.from("user_profiles").select("user_id,display_name,organization_slug")
    .or("display_name.ilike.%권소율%,display_name.ilike.%T권소율%");
  const me = (profs ?? []).find((p: any) => p.organization_slug === ORG) as any;
  const u = me.user_id;
  const { data: weeks } = await sb.from("weeks").select("id,week_number").eq("season_key", "2026-spring").gte("week_number", 1).lte("week_number", 11);
  const wnumById = new Map((weeks ?? []).map((w: any) => [w.id, w.week_number]));

  // admin registration code by activity type name
  const { data: regs } = await sb.from("line_registrations").select("line_name,line_code").eq("hub", "info").eq("is_active", true);
  const regByName = new Map((regs ?? []).map((r: any) => [r.line_name, r.line_code]));
  const { data: ats } = await sb.from("activity_types").select("id,name").eq("cluster_id", "practical_info");
  const nameById = new Map((ats ?? []).map((a: any) => [a.id, a.name]));
  const adminCodeForAct = (actId: string) => regByName.get(nameById.get(actId) ?? "") ?? null;

  if (RECOMPUTE) {
    console.log(`\n[recompute] T권소율 snapshot v${WEEKLY_CARDS_DTO_VERSION} ...`);
    await recomputeAndStoreWeeklyCardsSnapshot(u);
  }

  const live = infoLines(await getCluster4WeeklyCardsForProfileUser(u), wnumById);
  const snap = await readWeeklyCardsSnapshot(u);
  const snapLines = (snap.status === "hit" || snap.status === "stale") ? infoLines((snap as any).cards, wnumById) : [];
  console.log(`[snapshot] status=${snap.status} reason=${(snap as any).reason ?? "-"} computed_at=${(snap as any).computedAt ?? "-"}\n`);

  let adminEqDisplay = 0, directEqSnap = 0, leak = 0, total = 0;
  console.log(`[W | act | admin reg코드 | DTO displayLineCode | 내부 lineCode]`);
  for (const item of snapLines) {
    const admin = adminCodeForAct(item.activityTypeId);
    const d = live.find((x) => x.wn === item.wn && x.activityTypeId === item.activityTypeId);
    const adminOk = admin && item.displayLineCode === admin;
    const dsOk = d && d.displayLineCode === item.displayLineCode && d.lineCode === item.lineCode;
    const isLeak = typeof item.displayLineCode === "string" && INTERNAL_RE.test(item.displayLineCode);
    if (adminOk) adminEqDisplay++; if (dsOk) directEqSnap++; if (isLeak) leak++; total++;
    console.log(`  W${String(item.wn).padStart(2)} ${String(item.activityTypeId).padEnd(10)} admin=${String(admin).padEnd(12)} display=${String(item.displayLineCode).padEnd(12)} internal=${item.lineCode}  ${adminOk ? "✅" : "❌"}${dsOk ? "" : " direct≠snap"}${isLeak ? " ⚠LEAK" : ""}`);
  }
  console.log(`\n[1] admin 코드 == DTO displayLineCode : ${adminEqDisplay}/${total}`);
  console.log(`[5] direct == snapshot               : ${directEqSnap}/${total}`);
  console.log(`[누출] 내부코드가 displayLineCode 로 노출: ${leak}/${total} ${leak === 0 ? "✅" : "❌"}`);
}

main().then(() => process.exit(0), (e) => { console.error("ERR", e); process.exit(1); });

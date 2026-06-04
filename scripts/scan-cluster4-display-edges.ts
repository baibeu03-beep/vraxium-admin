/**
 * READ-ONLY: 표시 카드 수 != 분모 A 가 될 수 있는 edge 케이스 스캔 (v12 snapshot 기준).
 *  1) competency A >= 2 — 프론트는 단일 카드만 렌더 → 카운트 2 vs 카드 1 위험.
 *  2) experience 비-na 라인이 같은 slotOrder 에 2개 이상 — 슬롯 대표 1개만 렌더.
 *  3) information 비-na 라인의 activityTypeKey 가 프론트 고정 9종 밖 — 카드 미렌더.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

const INFO_TYPES = new Set(["wisdom", "essay", "infodesk", "calendar", "forum", "session", "practical_lecture", "community", "etc_a"]);

async function main() {
  const { data, error } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,cards");
  if (error) throw new Error(error.message);
  let compMulti = 0, expSlotDup = 0, infoUnknownType = 0, checked = 0;
  const samples: string[] = [];

  for (const row of (data ?? []) as { user_id: string; cards: Cluster4WeeklyCardDto[] }[]) {
    for (const card of row.cards ?? []) {
      if (card.isRestWeek || card.isTransition) continue;
      checked++;
      const tag = `user=${row.user_id} ${card.seasonKey} W${card.weekNumber}`;
      const comp = card.lines.filter((l) => l.partType === "competency" && l.enhancementStatus !== "not_applicable");
      if (comp.length >= 2) {
        compMulti++;
        if (compMulti <= 5) samples.push(`[comp>=2] ${tag} → ${comp.length}개 (${comp.map((l) => l.lineCode).join(",")})`);
      }
      const exp = card.lines.filter((l) => l.partType === "experience" && l.enhancementStatus !== "not_applicable");
      const slotCount = new Map<number | null, number>();
      for (const l of exp) slotCount.set(l.experienceSlotOrder ?? null, (slotCount.get(l.experienceSlotOrder ?? null) ?? 0) + 1);
      if ([...slotCount.entries()].some(([s, n]) => s != null && n >= 2) || (slotCount.get(null) ?? 0) > 0) {
        expSlotDup++;
        if (expSlotDup <= 5) samples.push(`[exp slot dup/null] ${tag} → ${JSON.stringify([...slotCount.entries()])}`);
      }
      const info = card.lines.filter((l) => l.partType === "information" && l.enhancementStatus !== "not_applicable");
      const unknown = info.filter((l) => !l.activityTypeKey || !INFO_TYPES.has(String(l.activityTypeKey)));
      if (unknown.length > 0) {
        infoUnknownType++;
        if (infoUnknownType <= 5) samples.push(`[info 비표준 type] ${tag} → ${unknown.map((l) => `${l.activityTypeKey}/${l.lineCode}`).join(",")}`);
      }
    }
  }
  console.log(`카드 ${checked}개 검사 — comp>=2: ${compMulti} | exp 슬롯중복/슬롯미상: ${expSlotDup} | info 비표준 activityType: ${infoUnknownType}`);
  for (const s of samples) console.log(s);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

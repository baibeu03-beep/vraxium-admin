/**
 * READ-ONLY: v14 역량 단일 정규화 전수 검증 (snapshot 전체).
 *  비휴식·비전환 카드: comp 칸 정확히 1 · na 금지 · A==1 · B<=1 · growthDen==ΣA.
 *  휴식/전환 카드: comp na placeholder 허용(분모 제외).
 *  + 라인 수 분포(0/1/2+) 별 케이스 샘플 출력 — 0/1/2개 주차 검증 케이스 확보용.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

async function main() {
  const { data, error } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,cards,dto_version,is_stale");
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as { user_id: string; cards: Cluster4WeeklyCardDto[]; dto_version: number; is_stale: boolean }[];
  const nonV14 = rows.filter((r) => r.dto_version !== 14 || r.is_stale).length;
  console.log(`snapshot rows=${rows.length} (비v14/stale=${nonV14})`);

  let checked = 0;
  const issues: string[] = [];
  const samples: Record<string, string[]> = { pending0: [], single1: [], folded2: [], success: [] };

  for (const row of rows) {
    for (const card of row.cards ?? []) {
      if (card.isRestWeek || card.isTransition) continue;
      checked++;
      const tag = `user=${row.user_id} ${card.seasonKey} W${card.weekNumber} (${card.userWeekStatus})`;
      const comp = card.lines.filter((l) => l.partType === "competency");
      if (comp.length !== 1) issues.push(`${tag} comp 칸 ${comp.length}≠1`);
      for (const l of comp) {
        if (l.enhancementStatus === "not_applicable") issues.push(`${tag} comp na 금지 위반`);
        if (l.denominator !== 1) issues.push(`${tag} comp denominator ${l.denominator}≠1`);
        if ((l.numerator ?? 0) > 1) issues.push(`${tag} comp numerator ${l.numerator}>1`);
        if (l.enhancementStatus === "fail" && l.status !== "void") issues.push(`${tag} comp fail≠void`);
      }
      // 합산 정합
      const sumA = (["information", "competency", "experience", "career"] as const).reduce((s, p) => {
        const ls = card.lines.filter((l) => l.partType === p);
        return s + ls.filter((l) => l.enhancementStatus !== "not_applicable").length;
      }, 0);
      if (card.growthDenominator !== sumA) issues.push(`${tag} growthDen ${card.growthDenominator}≠ΣA ${sumA}`);
      // 케이스 샘플 분류 (placeholder reason 으로 0라인, lineId 보유 수로 1/2+ 추정)
      const c0 = comp[0];
      if (c0?.enhancementReason === "competency_optional_pending" && samples.pending0.length < 3) samples.pending0.push(tag);
      else if (c0?.enhancementStatus === "success" && samples.success.length < 3) samples.success.push(tag);
    }
  }
  console.log(`비휴식·비전환 카드 ${checked}개 검사 → 위반 ${issues.length}건`);
  for (const i of issues.slice(0, 20)) console.log("  ✗", i);
  console.log("\n샘플 — 라인0(강화 대기 placeholder):", samples.pending0.join(" | ") || "(없음)");
  console.log("샘플 — comp success:", samples.success.join(" | ") || "(없음)");
  process.exit(issues.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

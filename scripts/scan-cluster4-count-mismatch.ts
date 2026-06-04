/**
 * READ-ONLY 스캔: snapshot(v12) 카드에서 "허브 표시 카운트 불일치" 재현 케이스 수집.
 *
 *   npx tsx --env-file=.env.local scripts/scan-cluster4-count-mismatch.ts
 *
 * 각 카드(비휴식)에 대해 part 별로:
 *   backendA   = line.denominator (백엔드 분모 SoT, 모든 라인 동일값)
 *   cellCount  = enhancementStatus != not_applicable 라인 수 (칸 기준)
 *   frontOld   = 구 프론트 fallback 재현 — info/comp: lines.length(na 포함),
 *                exp: na 제외 카드 수, career: line.denominator
 *   sumCheck   = growthDenominator == Σ backendA
 * 불일치(구 프론트 표시 != backendA, 또는 backendA != cellCount, 또는 합산 불일치) 카드 출력.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { Cluster4WeeklyCardDto, Cluster4LineDetailDto } from "@/shared/cluster4.contracts";

const PARTS = ["information", "competency", "experience", "career"] as const;

function backendA(lines: Cluster4LineDetailDto[]): number {
  const d = lines.map((l) => l.denominator).find((x) => typeof x === "number");
  return typeof d === "number" ? d : 0;
}
function cellCount(lines: Cluster4LineDetailDto[]): number {
  return lines.filter((l) => l.enhancementStatus !== "not_applicable").length;
}
function frontOld(part: string, lines: Cluster4LineDetailDto[]): number {
  if (part === "information" || part === "competency") return lines.length; // 구 버그: na 포함
  if (part === "experience") return cellCount(lines); // workExpCards na 제외와 동일
  return backendA(lines); // career: 기존에도 denominator
}

async function main() {
  const { data, error } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,cards,dto_version,is_stale");
  if (error) throw new Error(error.message);
  let cardsChecked = 0;
  const cases: string[] = [];
  const staleRows = (data ?? []).filter((r: { is_stale: boolean; dto_version: number }) => r.is_stale || r.dto_version !== 12).length;
  console.log(`snapshot rows=${data?.length} (stale/비v12=${staleRows})`);

  for (const row of (data ?? []) as { user_id: string; cards: Cluster4WeeklyCardDto[] }[]) {
    for (const card of row.cards ?? []) {
      if (card.isRestWeek || card.isTransition) continue;
      cardsChecked++;
      const perPart = PARTS.map((p) => {
        const ls = card.lines.filter((l) => l.partType === p);
        return { p, A: backendA(ls), cell: cellCount(ls), old: frontOld(p, ls) };
      });
      const sumA = perPart.reduce((s, x) => s + x.A, 0);
      const sumMismatch = card.growthDenominator !== sumA;
      const partIssues = perPart.filter((x) => x.old !== x.A || x.A !== x.cell);
      if (sumMismatch || partIssues.length > 0) {
        cases.push(
          `user=${row.user_id} ${card.seasonKey ?? "?"} W${card.weekNumber} (${card.userWeekStatus}) weekId=${card.weekId}` +
            ` | growthDen=${card.growthDenominator} ΣA=${sumA}${sumMismatch ? " ←합산불일치" : ""}` +
            ` | ` +
            perPart
              .map((x) => `${x.p.slice(0, 4)}: A=${x.A} cell=${x.cell} oldFront=${x.old}${x.old !== x.A ? "✗" : ""}`)
              .join("  "),
        );
      }
    }
  }
  console.log(`카드 ${cardsChecked}개 검사 → 불일치 카드 ${cases.length}개\n`);
  // 대표 유형별로 최대 25건 출력
  for (const c of cases.slice(0, 25)) console.log(c);
  if (cases.length > 25) console.log(`… 외 ${cases.length - 25}건`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

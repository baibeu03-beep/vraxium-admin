/**
 * READ-ONLY: 고객앱이 실제로 받는 "저장 snapshot 카드"를 전수 스캔해
 * experience available(헤더 total) vs 보이는 칸 수 불일치를 찾는다.
 *   npx tsx --env-file=.env.local scripts/diag-cluster4-snapshot-scan.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import type { Cluster4WeeklyCardDto, Cluster4LineDetailDto } from "@/shared/cluster4.contracts";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const isOpenCell = (l: Cluster4LineDetailDto) =>
  !(l.status === "void" && l.enhancementStatus === "not_applicable");

async function main() {
  const { data } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,cards,dto_version,is_stale");
  const rows = (data ?? []) as { user_id: string; cards: Cluster4WeeklyCardDto[]; dto_version: number; is_stale: boolean }[];
  console.log(`snapshot ${rows.length}행 스캔\n`);

  let cardsScanned = 0;
  let expMismatch = 0;
  const examples: string[] = [];
  // 부분별 mismatch 도 함께
  const partMismatch: Record<string, number> = { information: 0, experience: 0, competency: 0, career: 0 };

  for (const r of rows) {
    if (!Array.isArray(r.cards)) continue;
    for (const c of r.cards) {
      cardsScanned++;
      for (const part of ["information", "experience", "competency", "career"] as const) {
        const lines = c.lines.filter((l) => l.partType === part);
        if (lines.length === 0) continue;
        const available = lines.map((l) => l.denominator).find((d) => d != null) ?? null;
        const openCells = lines.filter(isOpenCell).length;
        if (available != null && available !== openCells) {
          partMismatch[part]++;
          if (part === "experience") expMismatch++;
          if (examples.length < 12) {
            examples.push(
              `user=${r.user_id.slice(0, 8)} week=${String(c.weekId).slice(0, 8)} part=${part} available=${available} openCells=${openCells} statuses=[${lines.map((l) => `${l.status}/${l.enhancementStatus}`).join(", ")}]`,
            );
          }
        }
      }
    }
  }

  console.log(`카드 ${cardsScanned}개 스캔`);
  console.log(`part별 available!=openCells: ${JSON.stringify(partMismatch)}`);
  console.log(`experience 불일치: ${expMismatch}건`);
  if (examples.length) {
    console.log("\n불일치 예시:");
    for (const e of examples) console.log("  " + e);
  } else {
    console.log("\n불일치 예시 없음 — 저장 snapshot 상 experience available 은 보이는 칸 수와 일치.");
  }

  // not_applicable 라인이 statusLabel/뱃지 필드 없이 내려가는 케이스가 있는지(저장본 기준)
  let naTotal = 0, naMissingLabel = 0, naMissingEnh = 0;
  for (const r of rows) {
    if (!Array.isArray(r.cards)) continue;
    for (const c of r.cards) {
      for (const l of c.lines) {
        if (l.enhancementStatus === "not_applicable") {
          naTotal++;
          if (!l.statusLabel) naMissingLabel++;
          if (l.enhancementStatus == null) naMissingEnh++;
        }
      }
    }
  }
  console.log(`\nnot_applicable 라인(저장본): ${naTotal}개 / statusLabel 누락 ${naMissingLabel} / enhancementStatus 누락 ${naMissingEnh}`);

  // line 레벨에 statusIconKey/statusTone/statusIconUrl 이 존재하는지(저장본 첫 라인 키 목록)
  const sample = rows.find((r) => Array.isArray(r.cards) && r.cards.some((c) => c.lines.length))?.cards.find((c) => c.lines.length);
  if (sample) {
    console.log("\nline DTO 키 목록(저장본 샘플):");
    console.log("  " + Object.keys(sample.lines[0]).join(", "));
    console.log("card DTO 뱃지 키(존재 확인): statusIconKey/statusIconUrl/statusTone =",
      "statusIconKey" in sample, "statusIconUrl" in sample, "statusTone" in sample);
  }

  console.log("\n══ 종료(읽기 전용) ══");
}
main().catch((e) => { console.error(e); process.exit(1); });

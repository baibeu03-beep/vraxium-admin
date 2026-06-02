/**
 * READ-ONLY 진단: experience "라인 칸 개수" vs "experienceRate.total(=breakdown.available)" 불일치 추적.
 *
 *   npx tsx --env-file=.env.local scripts/diag-cluster4-line-count-mismatch.ts
 *
 * 가설: 헤더 total(=line.denominator=breakdown.experience.available)은
 *   fetchWeeksWithOpenLinesByPart(growth 경로)로 계산되고,
 *   실제 라인 칸(lines[])은 fetchLineDetailsByWeek(cards 경로)의 별도 쿼리로 만들어진다.
 *   두 쿼리가 어긋나면 total > 보이는 칸 수. (DB write 없음.)
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import type { Cluster4WeeklyCardDto, Cluster4LineDetailDto } from "@/shared/cluster4.contracts";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// "개설된 칸"으로 보이는 experience 라인 = not_applicable placeholder(void+na) 가 아닌 것.
function isOpenCell(l: Cluster4LineDetailDto): boolean {
  return !(l.status === "void" && l.enhancementStatus === "not_applicable");
}

// growth 경로의 분모 A 계산 재현 (lib/lineAvailability.fetchWeeksWithOpenLinesByPart 의 experience 부분).
async function openedExperienceDistinct(weekId: string): Promise<{ distinct: number; lineIds: string[] }> {
  const { data: lines } = await sb
    .from("cluster4_lines")
    .select("id")
    .eq("part_type", "experience")
    .eq("is_active", true);
  const lineIds = (lines ?? []).map((l: { id: string }) => l.id);
  if (lineIds.length === 0) return { distinct: 0, lineIds: [] };
  const { data: targets } = await sb
    .from("cluster4_line_targets")
    .select("line_id")
    .in("line_id", lineIds)
    .eq("week_id", weekId);
  const set = new Set<string>();
  for (const t of (targets ?? []) as { line_id: string }[]) set.add(t.line_id);
  return { distinct: set.size, lineIds: [...set] };
}

// cards 경로(fetchLineDetailsByWeek)의 openedByWeek 재현 — 단, 이 경로는 weekIds 전체를
// 한 번에 inner-join + order(created_at desc) 로 받으므로 truncation 위험이 다르다.
// 여기서는 단일 weekId 기준으로 같은 모양의 쿼리를 재현해 distinct 를 센다.
async function cardsPathExperienceDistinct(weekId: string): Promise<number> {
  const { data } = await sb
    .from("cluster4_line_targets")
    .select("line_id,cluster4_lines!inner(id,part_type,is_active)")
    .eq("week_id", weekId)
    .eq("cluster4_lines.is_active", true)
    .order("created_at", { ascending: false });
  const set = new Set<string>();
  for (const r of (data ?? []) as unknown as { line_id: string; cluster4_lines: { part_type: string } | null }[]) {
    if (r.cluster4_lines?.part_type === "experience") set.add(r.line_id);
  }
  return set.size;
}

async function totalTargetsForWeek(weekId: string): Promise<number> {
  const { count } = await sb
    .from("cluster4_line_targets")
    .select("id", { count: "exact", head: true })
    .eq("week_id", weekId);
  return count ?? -1;
}

async function sampleUserIds(limit: number): Promise<string[]> {
  const { data } = await sb
    .from("cluster4_line_targets")
    .select("target_user_id")
    .eq("target_mode", "user")
    .not("target_user_id", "is", null)
    .limit(5000);
  return [...new Set(((data ?? []) as { target_user_id: string }[]).map((r) => r.target_user_id))].slice(0, limit);
}

async function main() {
  const users = await sampleUserIds(120);
  console.log(`스캔 사용자 ${users.length}명\n`);

  let mismatchFound = 0;
  let naMissingEnhancement = 0;
  let naLineCount = 0;
  const firstMismatch: { uid: string; card: Cluster4WeeklyCardDto } | null = null as any;
  let dumped = false;

  for (const uid of users) {
    let cards: Cluster4WeeklyCardDto[];
    try {
      cards = await getCluster4WeeklyCardsForProfileUser(uid);
    } catch {
      continue;
    }
    for (const c of cards) {
      const exp = c.lines.filter((l) => l.partType === "experience");
      if (exp.length === 0) continue;
      // breakdown.available 은 모든 experience 라인의 denominator 에 동일하게 실린다.
      const available = exp.map((l) => l.denominator).find((d) => d != null) ?? null;
      const openCells = exp.filter(isOpenCell).length;

      // not_applicable 필드 점검
      for (const l of exp) {
        if (l.status === "void" && l.enhancementStatus === "not_applicable") {
          naLineCount++;
          if (l.enhancementStatus !== "not_applicable") naMissingEnhancement++;
        }
      }

      if (available != null && available !== openCells) {
        mismatchFound++;
        if (!dumped) {
          dumped = true;
          console.log("══════════ 불일치 발견 ══════════");
          console.log(`user=${uid}`);
          console.log(`weekId=${c.weekId}  weekLabel=${c.weekLabel}  resultStatus=${c.userWeekStatus}`);
          console.log(`experience available(헤더 total) = ${available}`);
          console.log(`experience 보이는 칸(open cells) = ${openCells}`);
          console.log(`experience lines[] 전체 ${exp.length}개:`);
          console.log(
            JSON.stringify(
              exp.map((l) => ({
                status: l.status,
                enhancementStatus: l.enhancementStatus,
                enhancementReason: l.enhancementReason,
                lineId: l.lineId,
                lineTargetId: l.lineTargetId,
                experienceLineMasterId: l.experienceLineMasterId,
                experienceSlotOrder: l.experienceSlotOrder,
                numerator: l.numerator,
                denominator: l.denominator,
                rate: l.rate,
              })),
              null,
              2,
            ),
          );
          if (c.weekId) {
            const openedA = await openedExperienceDistinct(c.weekId);
            const cardsB = await cardsPathExperienceDistinct(c.weekId);
            const tot = await totalTargetsForWeek(c.weekId);
            console.log(`\n── 동일 weekId 두 경로 distinct experience line 수 ──`);
            console.log(`growth 경로(fetchWeeksWithOpenLinesByPart 재현) distinct = ${openedA.distinct}`);
            console.log(`cards 경로(fetchLineDetailsByWeek 재현)        distinct = ${cardsB}`);
            console.log(`그 주차 cluster4_line_targets 전체 행 수 = ${tot} (PostgREST 기본 1000행 cap 대비)`);
            console.log(`opened experience lineIds = ${JSON.stringify(openedA.lineIds)}`);
          }
          console.log("════════════════════════════════\n");
        }
      }
    }
    if (mismatchFound > 0 && dumped) {
      // 충분히 한 건 확인했으면 추가 스캔은 통계만.
    }
  }

  console.log(`\n총 불일치 카드 수: ${mismatchFound}`);
  console.log(`not_applicable experience 라인 표본: ${naLineCount} (enhancementStatus 누락: ${naMissingEnhancement})`);

  // 샘플 1명 snapshot 상태/저장값 점검
  const u0 = users[0];
  if (u0) {
    const snap = await readWeeklyCardsSnapshot(u0);
    console.log(`\n── snapshot 점검 user=${u0} status=${snap.status}${"reason" in snap ? `(${(snap as any).reason})` : ""} ──`);
    if (snap.status === "hit" || snap.status === "stale") {
      const c0 = snap.cards.find((c) => c.lines.some((l) => l.partType === "experience"));
      const naLine = c0?.lines.find((l) => l.enhancementStatus === "not_applicable");
      if (naLine) {
        console.log("저장 snapshot 의 not_applicable 라인 일부:", JSON.stringify({
          partType: naLine.partType,
          status: naLine.status,
          statusLabel: naLine.statusLabel,
          enhancementStatus: naLine.enhancementStatus,
          enhancementReason: naLine.enhancementReason,
          submissionStatus: naLine.submissionStatus,
        }, null, 2));
      } else {
        console.log("저장 snapshot 에 not_applicable 라인 표본 없음");
      }
    }
  }

  console.log("\n══ 진단 종료(읽기 전용) ══");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

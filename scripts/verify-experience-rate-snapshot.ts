/**
 * experienceRate DTO 검증 (read + 1명 재계산 only).
 *   npx tsx --env-file=.env.local scripts/verify-experience-rate-snapshot.ts <userId?>
 *
 * 1) direct: getCluster4WeeklyCardsForProfileUser → 각 카드 experienceRate
 * 2) snapshot: 해당 1명 recomputeAndStoreWeeklyCardsSnapshot 후 readWeeklyCardsSnapshot
 * 3) direct == snapshot(저장본) experienceRate 일치
 * 4) 레거시(통합 임시 라인) 주차의 experienceRate.total 포함 확인
 * 출력 JSON 을 claudedocs/verify-experience-rate-<userId>.json 로 저장.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import {
  recomputeAndStoreWeeklyCardsSnapshot,
  readWeeklyCardsSnapshot,
  WEEKLY_CARDS_DTO_VERSION,
} from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function pickSpringUser(): Promise<string> {
  const { data: weeks } = await sb
    .from("weeks")
    .select("id,start_date")
    .lt("start_date", "2026-06-29");
  const weekIds = (weeks ?? []).map((w: { id: string }) => w.id).slice(0, 200);
  const { data } = await sb
    .from("cluster4_line_targets")
    .select("target_user_id")
    .eq("target_mode", "user")
    .not("target_user_id", "is", null)
    .in("week_id", weekIds)
    .limit(1000);
  return ((data ?? []) as { target_user_id: string }[])[0].target_user_id;
}

type Rate = { rate: number; count: number; total: number };
function summarize(cards: any[]) {
  return cards
    .filter((c) => c.startDate < "2026-06-29")
    .map((c) => ({
      week: c.weekLabel,
      startDate: c.startDate,
      status: c.userWeekStatus,
      isRest: c.isRestWeek,
      experienceRate: c.experienceRate as Rate,
      // 실제 카드에 실린 experience 칸(통합 임시 라인 포함 여부 확인)
      expLineNames: c.lines
        .filter((l: any) => l.partType === "experience" && l.enhancementStatus !== "not_applicable")
        .map((l: any) => l.lineName ?? l.experienceLineMasterId ?? "?"),
    }));
}

async function main() {
  const userId = process.argv[2] || (await pickSpringUser());
  console.log(`검증 대상 user=${userId}  (DTO_VERSION=${WEEKLY_CARDS_DTO_VERSION})\n`);

  // 1) direct
  const direct = await getCluster4WeeklyCardsForProfileUser(userId);
  const directSpring = summarize(direct);

  // 2) recompute + snapshot read
  await recomputeAndStoreWeeklyCardsSnapshot(userId);
  const snap = await readWeeklyCardsSnapshot(userId);
  if (snap.status !== "hit") {
    console.error(`snapshot status=${snap.status} (expected hit after recompute)`);
    process.exit(1);
  }
  const snapSpring = summarize(snap.cards);

  // 3) direct == snapshot
  const norm = (r: Rate) => `${r.rate}/${r.count}/${r.total}`; // 키 순서 무관 비교
  const directMap = new Map(directSpring.map((c) => [c.week, norm(c.experienceRate)]));
  let mismatches = 0;
  for (const s of snapSpring) {
    const d = directMap.get(s.week);
    if (d !== norm(s.experienceRate)) {
      mismatches++;
      console.log(`MISMATCH ${s.week}: direct=${d} snap=${norm(s.experienceRate)}`);
    }
  }

  // 4) 레거시 통합 라인 포함 확인: 통합 라인이 실린 주차는 total>=1
  const legacyWithUnified = snapSpring.filter(
    (c) => !c.isRest && c.expLineNames.some((n: string) => String(n).includes("[통합]")),
  );
  const allUnifiedCounted = legacyWithUnified.every((c) => c.experienceRate.total >= 1);

  console.log("── 봄 시즌 카드 experienceRate (snapshot 저장본) ──");
  for (const c of snapSpring) {
    console.log(
      `${c.week} | status=${c.status} rest=${c.isRest} | experienceRate=${JSON.stringify(c.experienceRate)} | expLines=${JSON.stringify(c.expLineNames)}`,
    );
  }

  console.log("\n── 검증 결과 ──");
  console.log(`direct 카드 수(봄)=${directSpring.length}, snapshot 카드 수(봄)=${snapSpring.length}`);
  console.log(`direct == snapshot experienceRate: ${mismatches === 0 ? "OK" : `FAIL(${mismatches})`}`);
  console.log(`통합 임시 라인 실린 주차 ${legacyWithUnified.length}개 전부 total>=1: ${allUnifiedCounted ? "OK" : "FAIL"}`);
  console.log(`모든 카드 experienceRate 필드 존재: ${snap.cards.every((c: any) => c.experienceRate && typeof c.experienceRate.total === "number") ? "OK" : "FAIL"}`);

  const out = { userId, dtoVersion: WEEKLY_CARDS_DTO_VERSION, mismatches, allUnifiedCounted, snapSpring };
  const path = `claudedocs/verify-experience-rate-${userId.slice(0, 8)}.json`;
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(`\n저장: ${path}`);
  if (mismatches > 0 || !allUnifiedCounted) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

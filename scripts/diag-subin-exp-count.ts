/**
 * READ-ONLY 진단: T최수빈 봄 시즌 12주차 "실무 경험 총 N개" 불일치 추적.
 *
 *   npx tsx --env-file=.env.local scripts/diag-subin-exp-count.ts
 *
 * 1) direct(getCluster4WeeklyCardsForProfileUser) 카드의 experience 라인 전수 덤프
 * 2) snapshot(readWeeklyCardsSnapshot) 동일 카드 비교 (stale 여부 포함)
 * 3) 원장(cluster4_line_targets/cluster4_lines) 실제 개설/배정 라인 대조
 * 4) 프론트 표시 시뮬레이션(카드 seed dedup: lineTargetId||activityTypeId) 으로 "보이는 카드 수" 산출
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import type { Cluster4LineDetailDto } from "@/shared/cluster4.contracts";

const USER_ID = "36138fb1-6fea-4b22-b6d2-9c46cba47314"; // T최수빈

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

function dumpExpLines(label: string, lines: Cluster4LineDetailDto[]) {
  const exp = lines.filter((l) => l.partType === "experience");
  const counted = exp.filter((l) => l.enhancementStatus !== "not_applicable");
  console.log(`\n— ${label}: experience 라인 ${exp.length}개 / 분모(≠not_applicable) ${counted.length}개 / denominator=${exp.map((l) => l.denominator).find((d) => d != null) ?? "null"}`);
  console.log(
    JSON.stringify(
      exp.map((l) => ({
        status: l.status,
        enhancementStatus: l.enhancementStatus,
        enhancementReason: l.enhancementReason,
        lineId: l.lineId,
        lineTargetId: l.lineTargetId,
        activityTypeId: l.activityTypeId,
        experienceLineMasterId: l.experienceLineMasterId,
        slotOrder: l.experienceSlotOrder,
        category: l.experienceCategory,
        lineCode: l.lineCode,
        lineName: l.lineName,
        mainTitle: l.mainTitle,
        num: l.numerator, den: l.denominator, rate: l.rate,
      })),
      null,
      2,
    ),
  );
  // 프론트 expCardSeeds dedup 시뮬레이션 (Cluster4CardContent.tsx)
  const seen = new Set<string>();
  let visible = 0;
  for (const l of exp) {
    const key = (l.lineTargetId as string | null) || (l.activityTypeId as string | null) || "";
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    if (l.activityTypeId) seen.add(l.activityTypeId);
    visible++;
  }
  // 표시 카드 중 not_applicable 제외 = 프론트 experienceStatsDisplay.total 재현
  const seen2 = new Set<string>();
  let frontTotal = 0;
  for (const l of exp) {
    const key = (l.lineTargetId as string | null) || (l.activityTypeId as string | null) || "";
    if (key && seen2.has(key)) continue;
    if (key) seen2.add(key);
    if (l.activityTypeId) seen2.add(l.activityTypeId);
    if (l.enhancementStatus !== "not_applicable") frontTotal++;
  }
  console.log(`  → 프론트 시뮬: 카드 seed ${visible}개, experienceStatsDisplay.total(표시 "총 N개" fallback) = ${frontTotal}`);
  return { expCount: exp.length, counted: counted.length };
}

async function main() {
  // 0) 사용자/주차 식별
  const { data: prof } = await sb.from("user_profiles").select("user_id,name,is_test_user").eq("user_id", USER_ID).maybeSingle();
  console.log("프로필:", JSON.stringify(prof));

  // 1) direct
  const cards = await getCluster4WeeklyCardsForProfileUser(USER_ID);
  const target = cards.find((c) => /봄/.test(`${c.weekLabel} ${c.displayTitle ?? ""}`) && /12주차/.test(`${c.weekLabel} ${c.displayTitle ?? ""}`));
  if (!target) {
    console.log("⚠️ '봄 12주차' 카드 미발견. 카드 목록:");
    for (const c of cards) console.log(`  ${c.weekLabel} | weekId=${c.weekId} | status=${c.userWeekStatus}`);
    return;
  }
  console.log(`\n=== direct 카드: ${target.weekLabel} weekId=${target.weekId} resultStatus=${target.userWeekStatus} isTransition=${(target as any).isTransition ?? "?"} ===`);
  dumpExpLines("direct", target.lines);

  // 2) snapshot
  const snap = await readWeeklyCardsSnapshot(USER_ID);
  console.log(`\n=== snapshot status=${snap.status}${"reason" in snap ? ` reason=${(snap as any).reason}` : ""} ===`);
  if (snap.status === "hit" || snap.status === "stale") {
    const sc = snap.cards.find((c) => c.weekId === target.weekId);
    if (sc) dumpExpLines("snapshot", sc.lines);
    else console.log("⚠️ snapshot 에 해당 weekId 카드 없음");
  }

  // 3) 원장 대조 — 해당 주차 experience 라인/타깃
  const weekId = target.weekId!;
  const { data: targets } = await sb
    .from("cluster4_line_targets")
    .select("id,line_id,target_mode,target_user_id,week_id,cluster4_lines!inner(id,part_type,is_active,line_code,main_title,experience_line_master_id)")
    .eq("week_id", weekId);
  const expTargets = ((targets ?? []) as any[]).filter((t) => t.cluster4_lines?.part_type === "experience" && t.cluster4_lines?.is_active);
  const myTargets = expTargets.filter((t) => t.target_mode !== "user" || t.target_user_id === USER_ID);
  console.log(`\n=== 원장: week ${weekId} experience 타깃 ${expTargets.length}건 (본인 해당 ${myTargets.length}건) ===`);
  console.log(JSON.stringify(expTargets.map((t) => ({
    targetId: t.id, lineId: t.line_id, mode: t.target_mode, targetUser: t.target_user_id,
    lineCode: t.cluster4_lines?.line_code, mainTitle: t.cluster4_lines?.main_title,
    masterId: t.cluster4_lines?.experience_line_master_id,
  })), null, 2));

  // distinct 개설 라인 수 (라인행 기준 = 개설 신호)
  console.log(`distinct 개설 experience line = ${new Set(expTargets.map((t) => t.line_id)).size}`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

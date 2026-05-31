/**
 * 진단: 실무 역량(competency) 라인이 프론트 카드/모달에 안 보이는 원인 추적.
 *
 *   npx tsx --env-file=.env.local scripts/diag-competency-line-dto.ts
 *
 * 확인:
 *   1) cluster4_lines 에 part_type='competency' / is_active row 존재 여부
 *   2) 각 라인의 cluster4_line_targets (target_mode / target_user_id / week_id)
 *   3) 대상 user 의 weekly-cards DTO 에 그 competency 라인이 "실제 라인"으로 노출되는지
 *      (lineTargetId != null) 아니면 "미개설 placeholder" 로 떨어지는지 (void)
 *   4) week_id 가 그 user 의 weeklyGrowth 주차 목록에 들어있는지 (주차 매칭)
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { getWeeklyGrowth } from "@/lib/cluster4WeeklyGrowthData";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  console.log("════════ 1. active competency 라인 ════════");
  const { data: lines, error: lineErr } = await sb
    .from("cluster4_lines")
    .select(
      "id,part_type,main_title,line_code,competency_line_master_id,is_active,submission_opens_at,submission_closes_at",
    )
    .eq("part_type", "competency");
  if (lineErr) throw lineErr;

  if (!lines || lines.length === 0) {
    console.log("  ❌ part_type='competency' 라인이 0건. 라인 자체가 생성 안 됨 → 백엔드/개설 단계 문제.");
    return;
  }
  console.log(`  competency 라인 ${lines.length}건:`);
  for (const l of lines as any[]) {
    console.log(
      `   - id=${l.id.slice(0, 8)} active=${l.is_active} title=${JSON.stringify(l.main_title)} code=${JSON.stringify(l.line_code)} masterId=${l.competency_line_master_id ? l.competency_line_master_id.slice(0, 8) : null}`,
    );
    console.log(`        opensAt=${l.submission_opens_at} closesAt=${l.submission_closes_at}`);
  }

  const activeIds = (lines as any[]).filter((l) => l.is_active).map((l) => l.id);
  console.log(`\n  active=true 인 라인: ${activeIds.length}건`);
  if (activeIds.length === 0) {
    console.log("  ❌ is_active=true 인 competency 라인이 없음 → weekly-cards inner join 에서 제외됨.");
    return;
  }

  console.log("\n════════ 2. competency 라인 타깃 (cluster4_line_targets) ════════");
  const { data: targets, error: tErr } = await sb
    .from("cluster4_line_targets")
    .select("id,line_id,week_id,target_mode,target_user_id")
    .in("line_id", activeIds);
  if (tErr) throw tErr;

  if (!targets || targets.length === 0) {
    console.log("  ❌ competency 라인에 연결된 line_targets 가 0건 → user/week 타깃 미생성. 카드엔 '미개설'로만 보임.");
    return;
  }
  console.log(`  타깃 ${targets.length}건:`);
  for (const t of targets as any[]) {
    console.log(
      `   - target_id=${t.id.slice(0, 8)} mode=${t.target_mode} user=${t.target_user_id ? t.target_user_id.slice(0, 8) : null} week=${t.week_id ? t.week_id.slice(0, 8) : null}`,
    );
  }

  const userTargets = (targets as any[]).filter(
    (t) => t.target_mode === "user" && t.target_user_id,
  );
  const nonUserTargets = (targets as any[]).filter(
    (t) => t.target_mode !== "user" || !t.target_user_id,
  );
  if (nonUserTargets.length > 0) {
    console.log(
      `\n  ⚠️ target_mode!='user' 또는 target_user_id=null 인 타깃 ${nonUserTargets.length}건 — weekly-cards 는 이런 타깃을 필터링하므로 카드에 안 보임 (relevantTargets 조건: mode='user' && target_user_id=profileUserId).`,
    );
  }
  if (userTargets.length === 0) {
    console.log("  ❌ user 모드 타깃이 0건 → weekly-cards relevantTargets 에서 전부 제외 → 카드엔 '미개설'.");
    return;
  }

  console.log("\n════════ 3. 대상 user 별 weekly-cards DTO 노출 검증 ════════");
  const byUser = new Map<string, any[]>();
  for (const t of userTargets) {
    if (!byUser.has(t.target_user_id)) byUser.set(t.target_user_id, []);
    byUser.get(t.target_user_id)!.push(t);
  }

  for (const [userId, uTargets] of byUser) {
    console.log(`\n  ── user ${userId.slice(0, 8)} ──`);

    // weeklyGrowth 주차 목록 (DTO 가 카드로 만드는 주차들)
    const growth = await getWeeklyGrowth(userId);
    const growthWeekIds = new Set(
      (growth?.weeklyCards ?? [])
        .map((c) => c.weekId)
        .filter((w): w is string => Boolean(w)),
    );
    console.log(`     weeklyGrowth 주차 ${growthWeekIds.size}개`);

    // 타깃 week_id 가 weeklyGrowth 주차에 들어있는지
    for (const t of uTargets) {
      const inGrowth = growthWeekIds.has(t.week_id);
      console.log(
        `     타깃 week=${t.week_id ? t.week_id.slice(0, 8) : null} → weeklyGrowth 주차에 포함? ${inGrowth ? "✅" : "❌ (이 주차 카드 자체가 없음 → 라인 매핑 불가)"}`,
      );
    }

    // 실제 DTO 추출
    const cards = await getCluster4WeeklyCardsForProfileUser(userId);
    for (const t of uTargets) {
      const card = cards.find((c) => c.weekId === t.week_id);
      if (!card) {
        console.log(
          `     ❌ week=${t.week_id?.slice(0, 8)} 카드가 DTO 에 없음 (weeklyGrowth 미포함 주차).`,
        );
        continue;
      }
      const realLine = card.lines.find((l) => l.lineTargetId === t.id);
      const compLines = card.lines.filter((l) => l.partType === "competency");
      console.log(`\n     [week ${t.week_id.slice(0, 8)}] competency 라인 ${compLines.length}건:`);
      for (const cl of compLines) {
        console.log(
          `       partType=${cl.partType} lineTargetId=${cl.lineTargetId ? cl.lineTargetId.slice(0, 8) : null} status=${cl.status}/${cl.statusLabel} enh=${cl.enhancementStatus}`,
        );
      }
      if (realLine) {
        console.log("     ✅ 이 타깃이 '실제 라인'으로 DTO 에 노출됨. 부분 JSON:");
        console.log(
          JSON.stringify(
            {
              partType: realLine.partType,
              lineTargetId: realLine.lineTargetId,
              mainTitle: realLine.mainTitle,
              lineCode: realLine.lineCode,
              outputLinks: realLine.outputLinks,
              outputImages: realLine.outputImages,
              enhancementStatus: realLine.enhancementStatus,
              canEdit: realLine.canEdit,
              editReason: realLine.editReason,
              submission: realLine.submission,
            },
            null,
            2,
          )
            .split("\n")
            .map((s) => "       " + s)
            .join("\n"),
        );
        console.log(
          "     → 백엔드 DTO 는 정상. 값이 안 보이면 프론트 매핑(카드/모달) 문제.",
        );
      } else {
        console.log(
          `     ❌ 이 타깃(${t.id.slice(0, 8)})이 DTO 에서 '실제 라인'으로 안 보임 (placeholder void 로 떨어짐) → 백엔드 매핑 문제. (is_active / week 필터 / target 조건 확인)`,
        );
      }
    }
  }

  console.log("\n════════ 진단 완료 ════════");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

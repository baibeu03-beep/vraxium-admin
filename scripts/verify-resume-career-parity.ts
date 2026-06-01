/**
 * 이력서(cluster1ResumeData) career 계산이 허브(fetchWeeklyCardLineAggregates)와 동일 기준인지 검증.
 *   npx tsx --env-file=.env.local scripts/verify-resume-career-parity.ts
 *
 * 이력서는 fetchCareerLineCountsByWeek(A) / fetchCareerLineSuccessCountsByWeek(B) 를 사용한다.
 * 허브는 fetchWeeklyCardLineAggregates 가 careerLineMap(A)/careerSuccessMap(B) 를 만든다.
 * 동일 user/week 에서 두 경로가 같은 값을 내는지(= 기준 일치) 비교한다.
 * [TEST] 임시 career 라인/타깃/제출/평가를 만들고 끝나면 전부 삭제(비파괴).
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import {
  fetchCareerLineCountsByWeek,
  fetchCareerLineSuccessCountsByWeek,
  fetchInfoLineCountsByWeek,
  fetchExperienceLineCountsByWeek,
  fetchCompetencyLineCountsByWeek,
  fetchWeeklyCardLineAggregates,
} from "@/lib/lineAvailability";
import { upsertCareerEvaluation } from "@/lib/adminCareerEvaluationsData";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

let fail = 0;
function ok(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${extra ? " — " + extra : ""}`);
  if (!cond) fail++;
}

const PAST_OPEN = "2020-01-01T00:00:00.000Z";
const PAST_CLOSE = "2020-01-08T13:00:00.000Z";

async function pickUserAndWeek(): Promise<{ userId: string; weekId: string } | null> {
  const { data: uws } = await sb.from("user_week_statuses").select("user_id").limit(300);
  const userIds = Array.from(new Set((uws ?? []).map((r: { user_id: string }) => r.user_id)));
  for (const userId of userIds.slice(0, 15)) {
    const { data: weeks } = await sb.from("weeks").select("id").limit(1);
    const weekId = (weeks ?? [])[0] as { id: string } | undefined;
    if (!weekId) return null;
    const { data: existing } = await sb
      .from("cluster4_line_targets")
      .select("id,cluster4_lines!inner(part_type)")
      .eq("week_id", weekId.id)
      .eq("target_user_id", userId);
    const hasCareer = (existing ?? []).some(
      (t) => (t as unknown as { cluster4_lines: { part_type: string } }).cluster4_lines?.part_type === "career",
    );
    if (!hasCareer) return { userId, weekId: weekId.id };
  }
  return null;
}

// 이력서 경로(A,B)와 허브 aggregate(A,B)를 한 주차에 대해 비교.
async function compareParity(userId: string, weekId: string, label: string, wantA: number, wantB: number) {
  const resumeA = (await fetchCareerLineCountsByWeek(userId, [weekId])).get(weekId) ?? 0;
  const resumeB = (await fetchCareerLineSuccessCountsByWeek(userId, [weekId])).get(weekId) ?? 0;
  const agg = await fetchWeeklyCardLineAggregates(userId, [weekId]);
  const hubA = agg.careerLineMap.get(weekId) ?? 0;
  const hubB = agg.careerSuccessMap.get(weekId) ?? 0;
  console.log(`  [${label}] 이력서 A/B=${resumeA}/${resumeB}  허브 A/B=${hubA}/${hubB}  (기대 A/B=${wantA}/${wantB})`);
  ok(`${label}: 이력서 A == 허브 A`, resumeA === hubA, `${resumeA} vs ${hubA}`);
  ok(`${label}: 이력서 B == 허브 B`, resumeB === hubB, `${resumeB} vs ${hubB}`);
  ok(`${label}: A == 기대(${wantA})`, resumeA === wantA, String(resumeA));
  ok(`${label}: B == 기대(${wantB})`, resumeB === wantB, String(resumeB));
}

async function main() {
  const adminId = (await sb.from("admin_users").select("id").limit(1)).data?.[0] as { id: string } | undefined;
  const picked = await pickUserAndWeek();
  if (!picked) { console.log("❌ fixture 후보 없음"); process.exit(1); }
  const { userId, weekId } = picked;
  console.log(`fixture: user=${userId} week=${weekId}`);

  let lineId: string | null = null;
  let targetId: string | null = null;

  try {
    const { data: line } = await sb.from("cluster4_lines").insert({
      part_type: "career", main_title: "[TEST-RESUME-PARITY]", line_code: "TEST-CAREER",
      submission_opens_at: PAST_OPEN, submission_closes_at: PAST_CLOSE, is_active: true,
      created_by: adminId?.id ?? null, updated_by: adminId?.id ?? null,
    }).select("id").single();
    lineId = (line as { id: string }).id;
    const { data: target } = await sb.from("cluster4_line_targets").insert({
      line_id: lineId, week_id: weekId, target_mode: "user", target_user_id: userId, target_rule: {},
      created_by: adminId?.id ?? null, updated_by: adminId?.id ?? null,
    }).select("id").single();
    targetId = (target as { id: string }).id;

    console.log("\n════ (1)(4) 미제출+미평가 → A=1, B=0 ════");
    await compareParity(userId, weekId, "미제출/미평가", 1, 0);

    console.log("\n════ (5) 제출+미평가 → A=1, B=0 ════");
    await sb.from("cluster4_line_submissions").insert({ line_target_id: targetId, user_id: userId, subtitle: "[TEST]" });
    await compareParity(userId, weekId, "제출/미평가", 1, 0);

    console.log("\n════ (3) D → A=1, B=0 (success 제외) ════");
    await upsertCareerEvaluation({ lineTargetId: targetId, userId, grade: "D" }, adminId?.id ?? userId, new Date().toISOString());
    await compareParity(userId, weekId, "grade D", 1, 0);

    console.log("\n════ (2) A → A=1, B=1 (S/A/B/C success 포함) ════");
    await upsertCareerEvaluation({ lineTargetId: targetId, userId, grade: "A" }, adminId?.id ?? userId, new Date().toISOString());
    await compareParity(userId, weekId, "grade A", 1, 1);

    console.log("\n════ (2) C → A=1, B=1 (경계값 4점) ════");
    await upsertCareerEvaluation({ lineTargetId: targetId, userId, grade: "C" }, adminId?.id ?? userId, new Date().toISOString());
    await compareParity(userId, weekId, "grade C", 1, 1);

    console.log("\n════ (7) info/experience/competency 회귀 — 이력서 helper == 허브 aggregate ════");
    {
      const agg = await fetchWeeklyCardLineAggregates(userId, [weekId]);
      const infoR = (await fetchInfoLineCountsByWeek(userId, [weekId])).get(weekId) ?? 0;
      const expR = (await fetchExperienceLineCountsByWeek(userId, [weekId])).get(weekId) ?? 0;
      const compR = (await fetchCompetencyLineCountsByWeek(userId, [weekId])).get(weekId) ?? 0;
      ok("info A 일치", infoR === (agg.infoLineMap.get(weekId) ?? 0), `${infoR}`);
      ok("experience A 일치", expR === (agg.experienceLineMap.get(weekId) ?? 0), `${expR}`);
      ok("competency A 일치", compR === (agg.competencyLineMap.get(weekId) ?? 0), `${compR}`);
    }
  } finally {
    console.log("\n════ cleanup ════");
    if (targetId) {
      await sb.from("cluster4_career_line_evaluations").delete().eq("line_target_id", targetId);
      await sb.from("cluster4_line_submissions").delete().eq("line_target_id", targetId);
      await sb.from("cluster4_line_targets").delete().eq("id", targetId);
    }
    if (lineId) await sb.from("cluster4_lines").delete().eq("id", lineId);
    if (lineId) {
      const { count } = await sb.from("cluster4_lines").select("id", { count: "exact", head: true }).eq("id", lineId);
      console.log(`  임시 라인 삭제: ${count === 0 ? "✅" : "❌ 잔존 " + count}`);
    }
  }

  console.log(fail ? `\n❌ 실패 ${fail}건` : "\n════ 이력서-허브 career 기준 일치 검증 완료 (전부 통과) ════");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

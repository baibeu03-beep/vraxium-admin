/**
 * career 평가 P0+P1 — 운영 DB 종단(DB→데이터레이어→DTO) 검증.
 *   npx tsx --env-file=.env.local scripts/verify-career-evaluations-e2e.ts
 *
 * [TEST-CAREER-EVAL] 임시 라인+타깃(+제출)을 실제 사용자/주차에 만들어 검증하고 끝나면 전부 삭제.
 * (운영 데이터 비파괴 — 임시 row 만 생성/삭제.)
 *
 * P1 규칙: 선발(target)+마감 후 기준
 *   - 미제출            → fail (career_not_submitted)
 *   - 제출+미평가       → pending (career_unevaluated_after_deadline)
 *   - 제출/평가 D       → fail (career_grade_fail)
 *   - C/B/A/S           → success (career_grade_success)
 * 허브: A=사용자 배정 career 라인 수, B=success(=grade C이상) 수.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { computeCluster4Enhancement } from "@/lib/cluster4Enhancement";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { getCluster4LineDetailForProfileUser } from "@/lib/cluster4LinesData";
import {
  upsertCareerEvaluation,
  listCareerEvaluationTargetsForLine,
} from "@/lib/adminCareerEvaluationsData";

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
const PAST_CLOSE = "2020-01-08T13:00:00.000Z"; // 마감 후(과거)

async function pickUserAndWeek(): Promise<{ userId: string; weekId: string } | null> {
  const { data: uws } = await sb.from("user_week_statuses").select("user_id").limit(300);
  const userIds = Array.from(new Set((uws ?? []).map((r: { user_id: string }) => r.user_id)));
  for (const userId of userIds.slice(0, 12)) {
    let cards;
    try {
      cards = await getCluster4WeeklyCardsForProfileUser(userId);
    } catch {
      continue;
    }
    for (const c of cards) {
      if (!c.weekId || c.isRestWeek) continue;
      const { data: existing } = await sb
        .from("cluster4_line_targets")
        .select("id,cluster4_lines!inner(part_type)")
        .eq("week_id", c.weekId)
        .eq("target_user_id", userId);
      const hasCareer = (existing ?? []).some(
        (t) => (t as unknown as { cluster4_lines: { part_type: string } }).cluster4_lines?.part_type === "career",
      );
      if (!hasCareer) return { userId, weekId: c.weekId };
    }
  }
  return null;
}

async function detailFields(userId: string, weekId: string) {
  const d = await getCluster4LineDetailForProfileUser(userId, weekId, "career");
  return { grade: d.careerGrade, points: d.careerGradePoints, ratingStatus: d.careerRatingStatus, status: d.status };
}

// weekly-cards 의 해당 career 라인 1행.
async function weeklyCareerLine(userId: string, weekId: string, lineTargetId: string) {
  const cards = await getCluster4WeeklyCardsForProfileUser(userId);
  for (const c of cards) {
    if (c.weekId !== weekId) continue;
    for (const ln of c.lines) if (ln.lineTargetId === lineTargetId) return ln;
  }
  return null;
}

async function main() {
  const adminRow = (await sb.from("admin_users").select("id").limit(1)).data?.[0] as { id: string } | undefined;
  const adminId = adminRow?.id ?? null;
  const projRow = (await sb.from("career_projects").select("id,line_code").limit(1)).data?.[0] as
    | { id: string; line_code: string | null }
    | undefined;

  const picked = await pickUserAndWeek();
  if (!picked) {
    console.log("❌ 검증용 (user, week) 후보를 찾지 못했습니다.");
    process.exit(1);
  }
  const { userId, weekId } = picked;
  console.log(`fixture: user=${userId} week=${weekId} admin=${adminId} project=${projRow?.id ?? "null"}`);

  let lineId: string | null = null;
  let targetId: string | null = null;
  let tmpProjectId: string | null = null;

  try {
    const { data: line, error: lineErr } = await sb
      .from("cluster4_lines")
      .insert({
        part_type: "career",
        main_title: "[TEST-CAREER-EVAL] verification (auto-cleanup)",
        line_code: projRow?.line_code ?? "TEST-CAREER",
        career_project_id: projRow?.id ?? null,
        submission_opens_at: PAST_OPEN,
        submission_closes_at: PAST_CLOSE,
        is_active: true,
        created_by: adminId,
        updated_by: adminId,
      })
      .select("id").single();
    if (lineErr || !line) throw new Error("temp line insert 실패: " + lineErr?.message);
    lineId = (line as { id: string }).id;

    const { data: target, error: tErr } = await sb
      .from("cluster4_line_targets")
      .insert({ line_id: lineId, week_id: weekId, target_mode: "user", target_user_id: userId, target_rule: {}, created_by: adminId, updated_by: adminId })
      .select("id").single();
    if (tErr || !target) throw new Error("temp target insert 실패: " + tErr?.message);
    targetId = (target as { id: string }).id;

    console.log("\n════════ (P1) 마감 후 + 미제출 + 미평가 → fail (career_not_submitted) ════════");
    {
      const f = await detailFields(userId, weekId);
      ok("detail careerGrade=null", f.grade === null);
      ok("detail careerRatingStatus=unevaluated", f.ratingStatus === "unevaluated", String(f.ratingStatus));
      const wl = await weeklyCareerLine(userId, weekId, targetId);
      ok("weekly enhancementStatus=fail", wl?.enhancementStatus === "fail", String(wl?.enhancementStatus));
      ok("weekly enhancementReason=career_not_submitted", wl?.enhancementReason === "career_not_submitted", String(wl?.enhancementReason));
      // (4) 허브: A=1(배정), B=0(success 아님) → rate 0
      ok("(4) 허브 denominator=1", wl?.denominator === 1, String(wl?.denominator));
      ok("(4) 허브 numerator=0", wl?.numerator === 0, String(wl?.numerator));
      ok("(4) 허브 rate=0", wl?.rate === 0, String(wl?.rate));
    }

    console.log("\n════════ (P1) 제출 + 미평가 → pending (career_unevaluated_after_deadline) ════════");
    {
      const { error: subErr } = await sb
        .from("cluster4_line_submissions")
        .insert({ line_target_id: targetId, user_id: userId, subtitle: "[TEST] sub" });
      ok("제출 row 생성", !subErr, subErr?.message ?? "");
      const wl = await weeklyCareerLine(userId, weekId, targetId);
      ok("weekly enhancementStatus=pending", wl?.enhancementStatus === "pending", String(wl?.enhancementStatus));
      ok("weekly enhancementReason=career_unevaluated_after_deadline", wl?.enhancementReason === "career_unevaluated_after_deadline", String(wl?.enhancementReason));
      ok("(4) 허브 numerator=0 (미평가)", wl?.numerator === 0, String(wl?.numerator));
    }

    console.log("\n════════ (3,4,5) CHECK 제약 — 잘못된 값 거부 ════════");
    {
      const badGrade = await sb.from("cluster4_career_line_evaluations").insert({ line_target_id: targetId, user_id: userId, grade: "X", grade_points: 10 });
      ok("(3) grade='X' 거부", Boolean(badGrade.error), badGrade.error?.code ?? "no-error");
      const badPair = await sb.from("cluster4_career_line_evaluations").insert({ line_target_id: targetId, user_id: userId, grade: "S", grade_points: 8 });
      ok("(5) (S,8) 짝 불일치 거부", Boolean(badPair.error), badPair.error?.code ?? "no-error");
      const badPoints = await sb.from("cluster4_career_line_evaluations").insert({ line_target_id: targetId, user_id: userId, grade: "D", grade_points: 3 });
      ok("(4) (D,3) grade_points 거부", Boolean(badPoints.error), badPoints.error?.code ?? "no-error");
    }

    console.log("\n════════ 평가 D → fail (career_grade_fail) ════════");
    {
      const saved = await upsertCareerEvaluation({ lineTargetId: targetId, userId, grade: "D" }, adminId ?? userId, new Date().toISOString());
      ok("upsert grade=D", saved.grade === "D" && saved.gradePoints === 2, `${saved.grade}/${saved.gradePoints}`);
      const f = await detailFields(userId, weekId);
      ok("detail careerGrade=D / points=2 / ratingStatus=fail", f.grade === "D" && f.points === 2 && f.ratingStatus === "fail");
      const wl = await weeklyCareerLine(userId, weekId, targetId);
      ok("weekly enhancementStatus=fail", wl?.enhancementStatus === "fail", String(wl?.enhancementStatus));
      ok("weekly enhancementReason=career_grade_fail", wl?.enhancementReason === "career_grade_fail", String(wl?.enhancementReason));
      ok("(4) 허브 numerator=0 (D는 success 아님)", wl?.numerator === 0, String(wl?.numerator));
    }

    console.log("\n════════ (7) GET 조회 ════════");
    {
      const list = await listCareerEvaluationTargetsForLine(lineId);
      const row = list.find((r) => r.lineTargetId === targetId);
      ok("(7) GET grade=D, status=fail", row?.grade === "D" && row?.ratingStatus === "fail", `${row?.grade}/${row?.ratingStatus}`);
    }

    console.log("\n════════ 평가 A → success (career_grade_success) + 허브 ════════");
    {
      const saved = await upsertCareerEvaluation({ lineTargetId: targetId, userId, grade: "A" }, adminId ?? userId, new Date().toISOString());
      ok("upsert grade=A / points=8", saved.grade === "A" && saved.gradePoints === 8, `${saved.grade}/${saved.gradePoints}`);
      const f = await detailFields(userId, weekId);
      ok("detail careerRatingStatus=success", f.ratingStatus === "success", String(f.ratingStatus));
      const wl = await weeklyCareerLine(userId, weekId, targetId);
      ok("weekly enhancementStatus=success", wl?.enhancementStatus === "success", String(wl?.enhancementStatus));
      ok("weekly enhancementReason=career_grade_success", wl?.enhancementReason === "career_grade_success", String(wl?.enhancementReason));
      ok("weekly careerGradePoints=8", wl?.careerGradePoints === 8, String(wl?.careerGradePoints));
      // (4) 허브: A=1, B=1 → rate 100
      ok("(4) 허브 denominator=1", wl?.denominator === 1, String(wl?.denominator));
      ok("(4) 허브 numerator=1", wl?.numerator === 1, String(wl?.numerator));
      ok("(4) 허브 rate=100", wl?.rate === 100, String(wl?.rate));
    }

    console.log("\n════════ (2) UNIQUE(line_target_id, user_id) ════════");
    {
      const dup = await sb.from("cluster4_career_line_evaluations").insert({ line_target_id: targetId, user_id: userId, grade: "B", grade_points: 6 });
      ok("(2) 중복 insert 거부(23505)", dup.error?.code === "23505", dup.error?.code ?? "no-error");
    }

    console.log("\n════════ (1) 선발 검증 — default_target_user_ids 라운드트립 + 멤버십 로직 ════════");
    {
      const { data: proj, error: pErr } = await sb
        .from("career_projects")
        .insert({
          line_code: "TEST-SEL-" + targetId.slice(0, 8),
          line_name: "[TEST] selection",
          organization_slug: "oranke",
          default_target_user_ids: [userId],
        })
        .select("id,default_target_user_ids").single();
      ok("career_project 생성", !pErr && Boolean(proj), pErr?.message ?? "");
      if (proj) {
        tmpProjectId = (proj as { id: string }).id;
        const arr = (proj as { default_target_user_ids: unknown }).default_target_user_ids;
        const set = new Set(Array.isArray(arr) ? arr.filter((v): v is string => typeof v === "string") : []);
        ok("default_target_user_ids 배열 라운드트립", set.has(userId), `size=${set.size}`);
        // 라우트와 동일한 멤버십 로직: 선발자 통과, 비선발자 차단.
        const RANDOM = "00000000-0000-0000-0000-000000000000";
        ok("선발자(userId) 통과", set.has(userId));
        ok("비선발자(random) 차단", !set.has(RANDOM));
      }
    }

    console.log("\n════════ (13) 비career 회귀 — career 필드 null ════════");
    {
      for (const part of ["info", "experience", "competency"] as const) {
        const d = await getCluster4LineDetailForProfileUser(userId, weekId, part);
        ok(`${part} careerGrade=null & ratingStatus=null`, d.careerGrade === null && d.careerRatingStatus === null);
      }
      ok(
        "비career 마감 후 success(로직)",
        computeCluster4Enhancement({ hasTarget: true, deadlinePassed: true, hasSubmission: false, isCareer: false }).enhancementStatus === "success",
      );
    }
  } finally {
    console.log("\n════════ cleanup ════════");
    if (targetId) {
      await sb.from("cluster4_career_line_evaluations").delete().eq("line_target_id", targetId);
      await sb.from("cluster4_line_submissions").delete().eq("line_target_id", targetId);
      await sb.from("cluster4_line_targets").delete().eq("id", targetId);
    }
    if (lineId) await sb.from("cluster4_lines").delete().eq("id", lineId);
    if (tmpProjectId) await sb.from("career_projects").delete().eq("id", tmpProjectId);
    if (lineId) {
      const { count } = await sb.from("cluster4_lines").select("id", { count: "exact", head: true }).eq("id", lineId);
      console.log(`  임시 라인 삭제 확인: ${count === 0 ? "✅ 삭제됨" : "❌ 잔존 " + count}`);
    }
  }

  console.log(fail ? `\n❌ 검증 실패 (${fail}건)` : "\n════════ E2E 검증 완료 (전부 통과) ════════");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

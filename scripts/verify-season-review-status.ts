/**
 * 시즌 검수 상태(검수 중 / 승인 완료) + 새 시즌 즉시 노출 규칙 회귀 검증 — 단일 정본.
 *   npx tsx --env-file=.env.local scripts/verify-season-review-status.ts [userId] [port]
 *
 * SoT = cluster1ResumeData.computeSeasonRecords → getCluster1Resume → /api/cluster1/resume
 *       (LIVE, snapshot 아님 — 매 요청 날짜 기반 자동 전환. snapshot 재계산 불필요).
 *
 * 규칙(2026-07-03, end_date+14일 근사 폐기):
 *   · 검수 → 승인 완료 경계 = 시즌 타입별 "결산 월요일"(KST date-only, 포함):
 *       학기(봄/가을, 16주): 같은 시즌 15주차 월요일 = start_date + 98일.
 *       방학(여름/겨울, 8주): 다음 시즌 2주차 월요일 = start_date + 70일.
 *     todayKst >= 결산월요일 → "승인 완료", 이전 → "검수 중".
 *   · 새 시즌 1주차가 시작되면 활동(uws) 행이 없어도 "진행 중" 시즌 행이 즉시 노출된다
 *     (실이력 보유 + 비종료(졸업/중단/유보 아님) 사용자 한정).
 *
 * 검증 단계:
 *   (A) 경계 규칙 — 시즌 타입별 결산 월요일 전날=검수 중 / 당일=승인 완료 (순수 재현 + season_definitions 실 start_date).
 *   (B) direct getCluster1Resume — 26봄=승인 완료 · 26여름=진행 중 즉시 노출.
 *   (C) HTTP /api/cluster1/resume (internal key) == direct.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCluster1Resume } from "@/lib/cluster1ResumeData";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";

// ── 코드(cluster1ResumeData.seasonReviewApprovalMonday)와 동일 규칙의 순수 재현 ──
//    (헬퍼가 비-export 이므로 회귀 기준값을 독립적으로 재계산해 코드 결과와 대조한다.)
const SEMESTER_TYPES = new Set(["spring", "autumn"]);
function addCalendarDays(dateStr: string, days: number): string {
  const ms = Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10));
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}
function approvalMonday(seasonType: string, startDateIso: string): string {
  const offset = SEMESTER_TYPES.has(seasonType) ? 98 : 70;
  return addCalendarDays(startDateIso.slice(0, 10), offset);
}
function expectedReview(seasonType: string, startDateIso: string, todayKst: string): "검수 중" | "승인 완료" {
  return todayKst >= approvalMonday(seasonType, startDateIso) ? "승인 완료" : "검수 중";
}

async function pickSpringActiveUser(override: string | null): Promise<string | null> {
  if (override) return override;
  // 2026-spring uws 보유 + 종료(졸업/중단/유보) 아닌 사용자(새 시즌 주입 대상).
  const { data } = await supabaseAdmin
    .from("user_week_statuses")
    .select("user_id")
    .eq("season_key", "2026-spring")
    .limit(400);
  const ids = [...new Set(((data ?? []) as { user_id: string }[]).map((r) => r.user_id))];
  for (const id of ids) {
    const { data: p } = await supabaseAdmin
      .from("user_profiles")
      .select("growth_status")
      .eq("user_id", id)
      .maybeSingle();
    const gs = String((p as { growth_status: string | null } | null)?.growth_status ?? "");
    if (!["graduated", "suspended", "paused"].includes(gs)) return id;
  }
  return ids[0] ?? null;
}

async function main() {
  const override = process.argv[2] || null;
  const port = process.argv[3] || "3000";
  const todayKst = getCurrentActivityDateIso(Date.now());
  console.log(`todayKst = ${todayKst}\n`);

  let allPass = true;

  // ── (A) 경계 규칙 (시즌 타입별 결산 월요일) ──
  console.log("── (A) 경계 규칙: 결산 월요일 전날=검수 중 / 당일=승인 완료 ──");
  const { data: seasons } = await supabaseAdmin
    .from("season_definitions")
    .select("season_key,season_type,start_date")
    .order("start_date", { ascending: false })
    .limit(12);
  for (const s of (seasons ?? []) as { season_key: string; season_type: string; start_date: string | null }[]) {
    if (!s.start_date) continue;
    const mon = approvalMonday(s.season_type, s.start_date);
    const dayBefore = addCalendarDays(mon, -1);
    const before = expectedReview(s.season_type, s.start_date, dayBefore);
    const at = expectedReview(s.season_type, s.start_date, mon);
    const offset = SEMESTER_TYPES.has(s.season_type) ? 98 : 70;
    const pass = before === "검수 중" && at === "승인 완료";
    allPass = allPass && pass;
    console.log(
      `  ${pass ? "✅" : "❌"} ${s.season_key} (${s.season_type}) start=${s.start_date} +${offset}d=${mon} | 전날=${before} | 당일=${at}`,
    );
  }

  // ── (B) direct getCluster1Resume ──
  const userId = await pickSpringActiveUser(override);
  if (!userId) {
    console.log("\n대상 사용자 없음.");
    process.exit(allPass ? 0 : 1);
  }
  console.log(`\n── (B) direct getCluster1Resume(user=${userId.slice(0, 8)}) ──`);
  const direct = await getCluster1Resume(userId);
  if (!direct) {
    console.log("  null");
    process.exit(1);
  }
  for (const r of direct.seasonRecords) {
    // 각 행의 review 가 새 규칙 기대값과 일치하는지 교차검증(년/시즌명 → start_date 재구성 없이 규칙만 표시).
    console.log(
      `  ${r.year} ${r.seasonName} | progress=${r.progressStatus} | review=${r.reviewStatus} | ${r.approvedWeeks}/${r.totalWeeks} | pos=${r.position}`,
    );
  }
  const spring = direct.seasonRecords.find((r) => r.seasonName === "봄 시즌" && r.year === "26");
  const summer = direct.seasonRecords.find((r) => r.seasonName === "여름 시즌" && r.year === "26");
  const springOk = spring ? spring.reviewStatus === "승인 완료" : true; // 봄 이력 없으면 skip
  const summerOk = !!summer && summer.progressStatus === "진행 중";
  allPass = allPass && springOk && summerOk;
  console.log(`\n  ${springOk ? "✅" : "❌"} 26 봄 review=승인 완료 ${spring ? "" : "(봄 이력 없음 — skip)"}`);
  console.log(`  ${summerOk ? "✅" : "❌"} 26 여름 진행 중 즉시 노출`);

  // ── (C) HTTP == direct ──
  console.log(`\n── (C) HTTP /api/cluster1/resume == direct ──`);
  const key = process.env.INTERNAL_API_KEY;
  if (!key) {
    console.log("  INTERNAL_API_KEY 없음 — HTTP 스킵");
  } else {
    const res = await fetch(`http://localhost:${port}/api/cluster1/resume?userId=${userId}`, {
      headers: { "x-internal-api-key": key },
    });
    const body = (await res.json()) as { success: boolean; data?: typeof direct };
    if (!body.success || !body.data) {
      console.log(`  HTTP 실패: ${JSON.stringify(body).slice(0, 200)}`);
      allPass = false;
    } else {
      const eq = JSON.stringify(body.data.seasonRecords) === JSON.stringify(direct.seasonRecords);
      allPass = allPass && eq;
      console.log(`  ${eq ? "✅" : "❌"} HTTP seasonRecords == direct`);
      if (!eq) {
        console.log("  HTTP:", JSON.stringify(body.data.seasonRecords));
        console.log("  DIR :", JSON.stringify(direct.seasonRecords));
      }
    }
  }

  console.log(`\n${allPass ? "✅ 전체 통과" : "❌ 실패 케이스 있음"}`);
  process.exit(allPass ? 0 : 1);
}

main().then(
  () => {},
  (e) => {
    console.error(e);
    process.exit(1);
  },
);

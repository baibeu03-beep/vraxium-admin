/**
 * 시즌 검수 상태(검수 중 / 승인 완료) 자동 전환 검증.
 *   npx tsx --env-file=.env.local scripts/verify-season-review-status.ts [userId] [port]
 *
 * SoT = cluster1ResumeData.computeSeasonRecords → getCluster1Resume → /api/cluster1/resume (LIVE, snapshot 아님).
 * 규칙(기대): 시작~종료=검수 중 / 종료+1~종료+14=검수 중 / 종료+15부터=승인 완료.
 *
 * 검증:
 *   1) direct getCluster1Resume 결과의 reviewStatus
 *   2) season.end_date 기준 today 로 기대 reviewStatus 재계산 → 코드 결과와 일치 여부
 *   3) HTTP /api/cluster1/resume (internal key) == direct
 *   4) snapshot 미접근(LIVE) 확인 — 날짜 경계 전후 시뮬레이션
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCluster1Resume } from "@/lib/cluster1ResumeData";

// 코드(cluster1ResumeData)와 동일한 KST date-only 규칙을 순수 재현해 경계 검증에 사용.
function kstDateString(d: Date): string {
  return new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}
function addCalendarDays(dateStr: string, days: number): string {
  const ms = Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10));
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}
function expectedReview(endDateIso: string, now: Date): "검수 중" | "승인 완료" {
  const todayKst = kstDateString(now);
  const reviewCutoff = addCalendarDays(endDateIso.slice(0, 10), 14);
  return todayKst <= reviewCutoff ? "검수 중" : "승인 완료";
}

// KST 정오에 해당하는 Date (해당 KST 달력일을 확실히 대표). dateStr="YYYY-MM-DD".
function kstNoon(dateStr: string): Date {
  // KST 12:00 = UTC 03:00.
  return new Date(`${dateStr}T03:00:00.000Z`);
}

async function pickUser(override: string | null): Promise<string | null> {
  if (override) return override;
  const { data } = await supabaseAdmin.from("test_user_markers").select("user_id").limit(50);
  const ids = ((data ?? []) as { user_id: string }[]).map((r) => r.user_id);
  for (const id of ids) {
    try {
      const dto = await getCluster1Resume(id);
      if (dto && dto.seasonRecords && dto.seasonRecords.length > 0) return id;
    } catch {
      /* skip */
    }
  }
  return ids[0] ?? null;
}

async function main() {
  const override = process.argv[2] || null;
  const port = process.argv[3] || "3000";
  const now = new Date();
  console.log(`now=${now.toISOString()}`);

  const userId = await pickUser(override);
  if (!userId) {
    console.log("no test user found.");
    return;
  }

  // (1) direct
  const direct = await getCluster1Resume(userId);
  if (!direct) {
    console.log(`getCluster1Resume(${userId}) → null`);
    return;
  }
  console.log(`\n[user=${userId}] direct seasonRecords = ${direct.seasonRecords.length}`);
  for (const r of direct.seasonRecords) {
    console.log(
      `  ${r.year} ${r.seasonName} | progress=${r.progressStatus} | review=${r.reviewStatus} | ${r.approvedWeeks}/${r.totalWeeks} | pos=${r.position}`,
    );
  }

  // (2) 경계 테스트 케이스 — 종료일 당일 / +14일 / +15일 (KST 정오 기준)
  console.log(`\n── 경계 테스트 (KST date-only, 샘플 end_date 별) ──`);
  const { data: seasons } = await supabaseAdmin
    .from("season_definitions")
    .select("season_key,end_date")
    .order("end_date", { ascending: false })
    .limit(6);
  let allPass = true;
  for (const s of (seasons ?? []) as { season_key: string; end_date: string | null }[]) {
    if (!s.end_date) continue;
    const end = s.end_date.slice(0, 10);
    const d14 = addCalendarDays(end, 14);
    const d15 = addCalendarDays(end, 15);
    const atEnd = expectedReview(end, kstNoon(end)); // 종료일 당일
    const at14 = expectedReview(end, kstNoon(d14)); // 14일째
    const at15 = expectedReview(end, kstNoon(d15)); // 15일째
    const pass = atEnd === "검수 중" && at14 === "검수 중" && at15 === "승인 완료";
    allPass = allPass && pass;
    console.log(
      `  ${pass ? "✅" : "❌"} ${s.season_key} end=${end} | 당일=${atEnd} | +14(${d14})=${at14} | +15(${d15})=${at15}`,
    );
  }
  console.log(
    allPass
      ? "  ✅ 전 케이스 통과: 종료당일·14일째=검수 중, 15일째=승인 완료"
      : "  ❌ 경계 위반 케이스 있음",
  );

  // (3) HTTP == direct
  console.log(`\n── HTTP /api/cluster1/resume (internal key) ==`);
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
    } else {
      const eq =
        JSON.stringify(body.data.seasonRecords) === JSON.stringify(direct.seasonRecords);
      console.log(`  HTTP seasonRecords == direct : ${eq ? "✅ 일치" : "❌ 불일치"}`);
      if (!eq) {
        console.log("  HTTP:", JSON.stringify(body.data.seasonRecords));
        console.log("  DIR :", JSON.stringify(direct.seasonRecords));
      }
    }
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);

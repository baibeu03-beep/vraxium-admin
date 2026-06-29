/**
 * 검증(read-only): 이력서 카드 "통합 휴식" 분기 정정.
 *   - 일부 휴식 + 인정 success 주차 보유 → "정상 완료"
 *   - 전체 휴식(인정 success 0) → "통합 휴식" 보존
 *   direct(computeSeasonRecords) 결과를 scratchpad JSON 으로 써 HTTP 스크립트가 == 비교에 쓴다.
 *
 *   npx tsx --env-file=.env.local scripts/verify-resume-rest-fix.ts
 */
import { writeFileSync } from "node:fs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { computeSeasonRecords } from "@/lib/cluster1ResumeData";

const OUT = process.env.OUT_JSON ?? "scripts/.tmp-resume-rest-fix-direct.json";
const LEEHAYOON = "d5fd9168-0cfd-4e8b-8844-914299944806";
const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(72));
let fail = 0;
const ck = (l: string, ok: boolean, d = "") => {
  line(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};

async function main() {
  // 1) 이하윤 — 26봄 = 정상 완료 (success 9 / rest 1 / fail 0)
  hr();
  line("A. 이하윤(Encre) 26봄 — 정상 완료 기대");
  hr();
  const recs = await computeSeasonRecords(LEEHAYOON);
  const spring26 = recs.find((r) => r.year === "26" && r.seasonName.includes("봄"));
  line(`  26봄 record: ${JSON.stringify(spring26)}`);
  ck("26봄 progressStatus === 정상 완료", spring26?.progressStatus === "정상 완료", spring26?.progressStatus);
  ck("approvedWeeks 보존(9)", spring26?.approvedWeeks === 9, String(spring26?.approvedWeeks));

  // 2) 전수 표본: 과거 시즌(미진행)에서 hasRest && !hasFail 인 (user,season) 분류
  //    - approvedWeeks>0 → 정상 완료(정정 대상)
  //    - approvedWeeks==0 → 통합 휴식(보존)
  hr();
  line("B. 전수 스캔 — 과거시즌 hasRest && !hasFail 케이스 분류");
  hr();
  const { data: defs } = await supabaseAdmin
    .from("season_definitions")
    .select("season_key,end_date");
  const endBySeason = new Map<string, string>();
  for (const d of defs ?? []) endBySeason.set(d.season_key, d.end_date as string);

  // personal_rest 가 있는 (user,season) 후보를 페이지네이션으로 수집
  const restPairs = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from("user_week_statuses")
      .select("user_id,season_key")
      .eq("status", "personal_rest")
      .order("user_id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<{ user_id: string; season_key: string | null }>;
    for (const r of rows) if (r.season_key) restPairs.add(`${r.user_id}|${r.season_key}`);
    if (rows.length < 1000) break;
  }
  line(`  personal_rest 보유 (user,season) 쌍: ${restPairs.size}`);

  const sampleUsers = Array.from(new Set([...restPairs].map((p) => p.split("|")[0])));
  let flippedToComplete = 0; // 정정: 통합휴식→정상완료 후보(approved>0)
  let stayRest = 0; // 보존: approved==0
  const flippedExamples: string[] = [];
  const restExamples: string[] = [];
  const now = new Date();

  for (const userId of sampleUsers) {
    const records = await computeSeasonRecords(userId);
    for (const rec of records) {
      // record 에는 seasonKey 가 없으므로 year+seasonName 으로 직접 매핑하지 않고,
      // 정정 핵심 지표(progressStatus + approvedWeeks)로 분류한다.
      // 전체 휴식(approved==0, 통합 휴식) vs 일부 휴식+성공(approved>0, 정상 완료) 만 카운트.
      if (rec.progressStatus === "통합 휴식") {
        stayRest++;
        if (restExamples.length < 5)
          restExamples.push(`${userId} ${rec.year}${rec.seasonName} approved=${rec.approvedWeeks}`);
      }
    }
  }

  // 정정 효과 직접 측정: 각 rest 쌍에 대해 uws 를 직접 읽어 approved>0 & fail0 & 과거시즌 인지 판정
  for (const pair of restPairs) {
    const [userId, seasonKey] = pair.split("|");
    const end = endBySeason.get(seasonKey);
    if (!end || now <= new Date(end)) continue; // 진행 중 제외
    const { data: uws } = await supabaseAdmin
      .from("user_week_statuses")
      .select("status,week_start_date")
      .eq("user_id", userId)
      .eq("season_key", seasonKey);
    const rows = (uws ?? []) as Array<{ status: string }>;
    const hasFail = rows.some((w) => w.status === "fail");
    const successRaw = rows.filter((w) => w.status === "success").length;
    if (!hasFail && successRaw > 0) {
      flippedToComplete++;
      if (flippedExamples.length < 8)
        flippedExamples.push(`${userId} ${seasonKey} success(raw)=${successRaw}`);
    }
  }
  line(`  [정정] 과거시즌 일부휴식+성공보유(fail0) ≈ 통합휴식→정상완료 후보: ${flippedToComplete}`);
  for (const e of flippedExamples) line(`     · ${e}`);
  line(`  [보존] computeSeasonRecords 가 여전히 통합 휴식으로 라벨한 시즌행: ${stayRest}`);
  for (const e of restExamples) line(`     · ${e}`);
  ck("보존된 통합휴식 행은 모두 approved==0", restExamples.every((e) => e.endsWith("approved=0")), `샘플 ${restExamples.length}`);

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        leehayoonUserId: LEEHAYOON,
        spring26,
        flippedToComplete,
        stayRest,
      },
      null,
      0,
    ),
  );
  line(`\n  → direct 결과 기록: ${OUT}`);

  hr();
  line(fail === 0 ? "✅ DIRECT PASS" : `❌ ${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

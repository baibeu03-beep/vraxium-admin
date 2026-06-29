/**
 * 검증(read-only): success>0 · personal_rest>0 · fail=0 코호트가
 *   이력서/크루상세 시즌 배지에서 "통합 휴식"/"시즌 휴식"으로 잘못 표시되지 않는지.
 *   - computeSeasonRecords(progressStatus)
 *   - getCrewSeasonResults(seasonResultLabel) — 크루 상세 시즌 결과 배지(과거시즌 graft)
 *   - user_season_statuses(현재시즌 seasonal_rest 여부)
 *   npx tsx --env-file=.env.local scripts/verify-season-badge-cohort.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { computeSeasonRecords } from "@/lib/cluster1ResumeData";
import { getCrewSeasonResults } from "@/lib/adminCrewSeasonResults";

const LEEHAYOON = "d5fd9168-0cfd-4e8b-8844-914299944806";
const TODAY = new Date().toISOString().slice(0, 10);
const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(72));
let fail = 0;
const ck = (l: string, ok: boolean, d = "") => {
  line(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};

async function dumpUser(userId: string, label: string) {
  hr();
  line(`■ ${label} (${userId})`);
  hr();
  // uss 현재/전체
  const { data: uss } = await supabaseAdmin
    .from("user_season_statuses")
    .select("season_key,status")
    .eq("user_id", userId);
  line(`  user_season_statuses: ${JSON.stringify(uss ?? [])}`);

  const recs = await computeSeasonRecords(userId);
  const season = await getCrewSeasonResults(userId, TODAY);
  for (const r of recs) {
    const key = `${r.year}-${r.seasonName}`;
    line(`  resume   ${key}: progressStatus=${r.progressStatus} (approved=${r.approvedWeeks}/${r.totalWeeks})`);
  }
  for (const s of season) {
    line(`  crewDetail ${s.seasonNameShort} (${s.seasonKey}): seasonResultLabel=${s.seasonResultLabel}`);
  }
  return { recs, season };
}

async function main() {
  // A) 이하윤 본인
  const { recs, season } = await dumpUser(LEEHAYOON, "이하윤(Encre)");
  const spring26 = recs.find((r) => r.year === "26" && r.seasonName.includes("봄"));
  ck("이하윤 26봄 resume progressStatus === 정상 완료", spring26?.progressStatus === "정상 완료", spring26?.progressStatus);
  const spring26Badge = season.find((s) => s.seasonKey === "2026-spring");
  ck("이하윤 26봄 crewDetail seasonResultLabel === 시즌 성공", spring26Badge?.seasonResultLabel === "시즌 성공", `${spring26Badge?.seasonKey}=${spring26Badge?.seasonResultLabel}`);
  ck("이하윤 어디에도 통합 휴식 없음(resume)", !recs.some((r) => r.progressStatus === "통합 휴식"), "");
  ck("이하윤 어디에도 시즌 휴식 없음(crewDetail)", !season.some((s) => s.seasonResultLabel === "시즌 휴식"), "");

  // B) 코호트 스캔 — 과거시즌 personal_rest 보유 + 그 시즌 fail=0 + success>0 + 그 시즌 seasonal_rest(uss) 없음
  hr();
  line("B. 코호트 자동 추출 — success>0 · personal_rest>0 · fail=0 · seasonal_rest 없음(과거시즌)");
  hr();
  const { data: defs } = await supabaseAdmin.from("season_definitions").select("season_key,end_date");
  const endBySeason = new Map<string, string>();
  for (const d of defs ?? []) endBySeason.set(d.season_key, d.end_date as string);

  // personal_rest 보유 (user,season)
  const restPairs = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data } = await supabaseAdmin
      .from("user_week_statuses")
      .select("user_id,season_key")
      .eq("status", "personal_rest")
      .order("user_id", { ascending: true })
      .range(from, from + 999);
    const rows = (data ?? []) as Array<{ user_id: string; season_key: string | null }>;
    for (const r of rows) if (r.season_key) restPairs.add(`${r.user_id}|${r.season_key}`);
    if (rows.length < 1000) break;
  }

  // uss rest (user,season)
  const ussRest = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data } = await supabaseAdmin
      .from("user_season_statuses")
      .select("user_id,season_key,status")
      .eq("status", "rest")
      .order("user_id", { ascending: true })
      .range(from, from + 999);
    const rows = (data ?? []) as Array<{ user_id: string; season_key: string }>;
    for (const r of rows) ussRest.add(`${r.user_id}|${r.season_key}`);
    if (rows.length < 1000) break;
  }

  const now = new Date();
  const cohort: Array<{ userId: string; seasonKey: string; success: number }> = [];
  for (const pair of restPairs) {
    const [userId, seasonKey] = pair.split("|");
    const end = endBySeason.get(seasonKey);
    if (!end || now <= new Date(end)) continue; // 과거 시즌만
    if (ussRest.has(pair)) continue; // 시즌 스코프 휴식자는 제외(별개 정책)
    const { data: uws } = await supabaseAdmin
      .from("user_week_statuses")
      .select("status")
      .eq("user_id", userId)
      .eq("season_key", seasonKey);
    const rows = (uws ?? []) as Array<{ status: string }>;
    const hasFail = rows.some((w) => w.status === "fail");
    const success = rows.filter((w) => w.status === "success").length;
    if (!hasFail && success > 0) cohort.push({ userId, seasonKey, success });
  }
  line(`  코호트 규모: ${cohort.length} (user,season) 쌍`);

  let badResume = 0;
  let badBadge = 0;
  const examples: string[] = [];
  const checkUsers = Array.from(new Set(cohort.map((c) => c.userId)));
  for (const userId of checkUsers) {
    const recs2 = await computeSeasonRecords(userId);
    const season2 = await getCrewSeasonResults(userId, TODAY);
    // 이 user 의 코호트 시즌들만 검사
    const mySeasons = cohort.filter((c) => c.userId === userId).map((c) => c.seasonKey);
    for (const sk of mySeasons) {
      // resume: progressStatus 가 통합 휴식이면 결함
      const yy = sk.slice(2, 4);
      const typeKo = sk.endsWith("spring") ? "봄" : sk.endsWith("summer") ? "여름" : sk.endsWith("autumn") ? "가을" : "겨울";
      const rr = recs2.find((r) => r.year === yy && r.seasonName.includes(typeKo));
      if (rr?.progressStatus === "통합 휴식") {
        badResume++;
        if (examples.length < 8) examples.push(`RESUME ${userId} ${sk} 통합휴식(approved=${rr.approvedWeeks})`);
      }
      const bb = season2.find((s) => s.seasonKey === sk);
      if (bb?.seasonResultLabel === "시즌 휴식") {
        badBadge++;
        if (examples.length < 8) examples.push(`BADGE ${userId} ${sk} 시즌휴식`);
      }
    }
  }
  for (const e of examples) line(`     · ${e}`);
  ck(`코호트 전원 resume progressStatus != 통합 휴식`, badResume === 0, `위반 ${badResume}`);
  ck(`코호트 전원 crewDetail seasonResultLabel != 시즌 휴식`, badBadge === 0, `위반 ${badBadge}`);

  hr();
  line(fail === 0 ? "✅ DIRECT PASS" : `❌ ${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

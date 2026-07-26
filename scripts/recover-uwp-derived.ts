/**
 * §6 파생 데이터 재생성 — **STEP 01(복구 SQL) 커밋 이후에만** 실행.
 *
 *   npx tsx --env-file=.env.local scripts/recover-uwp-derived.ts            # preview (write 0)
 *   npx tsx --env-file=.env.local scripts/recover-uwp-derived.ts --apply
 *   npx tsx --env-file=.env.local scripts/recover-uwp-derived.ts --apply --concurrency 4
 *
 * 임의 UPDATE 를 하지 않는다. 각 계층의 **기존 공식 경로**만 호출한다:
 *   ① user_cumulative_points      ← lib/pmsPointlogsSync.ts 의 캐시 동기 블록과 동일한 upsert 산식
 *                                    (A=Σpoints · raw=Σadvantages · C=Σpenalty · net=raw−C)
 *   ② user_growth_stats           ← recalcUserGrowthStats(userId)        [공식 함수]
 *   ③ user_grade_stats            ← syncGradeStats(userId)               [공식 함수]
 *   ④ weekly-card snapshot        ← recomputeWeeklyCardsSnapshotsForUsers([...]) [공식 함수]
 *   ⑤ cluster4_roster_card_stats  ← ④ 안의 writeRosterCardStats 가 같은 computed_at 으로 동시 기록
 *                                    (= 관리자 회원 목록 slim 캐시. 별도 UPDATE 금지)
 *
 * 재생성 불필요(실시간 resolver 경유 — 캐시 없음):
 *   · Cluster3 stats-cards          → lib/cluster3GrowthData.ts resolveCumulativePointsBatch
 *   · 관리자 회원 상세 주차표         → lib/adminMembersData.ts resolvePointHistoryBatch
 *   · 관리자·크루 이력서 카드         → lib/adminResumeCardData.ts / crewWeekShowcase.ts
 *   ⇒ uwp 만 복구되면 즉시 정합. 위 4계층은 "캐시가 옛값을 보여주지 않게" 맞추는 작업이다.
 *
 * 대상 = 복구 스코프 사용자(629명). 순서 고정: ① → ②③ → ④(⑤ 포함).
 */
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { recalcUserGrowthStats } from "@/lib/userGrowthStatsData";
import { syncGradeStats } from "@/lib/cluster3ClubRankData";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";

const APPLY = process.argv.includes("--apply");
const ci = process.argv.indexOf("--concurrency");
const CONCURRENCY = ci >= 0 ? Number(process.argv[ci + 1]) : 3;
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = `claudedocs/recover-uwp-derived-${APPLY ? "apply" : "preview"}-${STAMP}.json`;

type Row = { user_id: string; wiped: boolean; checks_migrated: boolean; has_award: boolean; cur_a: number; cur_adv: number; cur_pen: number; exp_a: number; exp_adv: number; exp_pen: number };

async function pageAll<T>(b: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const o: T[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await b(f, f + 999);
    if (error) throw new Error(error.message);
    const r = (data ?? []) as T[];
    o.push(...r);
    if (r.length < 1000) break;
  }
  return o;
}

async function main() {
  const file = "claudedocs/" + readdirSync("claudedocs").filter((x) => x.startsWith("recover-uwp-dryrun-") && x.endsWith(".json")).sort().pop()!;
  const { rows } = JSON.parse(readFileSync(file, "utf8")) as { rows: Row[] };
  const scope = rows.filter((r) => r.wiped && r.checks_migrated && !r.has_award && r.cur_a === 0 && r.cur_adv === 0 && r.cur_pen === 0 && (r.exp_a !== 0 || r.exp_adv !== 0 || r.exp_pen !== 0));
  const userIds = [...new Set(scope.map((r) => r.user_id))];
  console.log(`[derived] 대상 ${userIds.length}명 (복구 스코프) · mode=${APPLY ? "APPLY" : "PREVIEW(write 0)"}`);

  // 선행 조건 검사: 복구가 실제로 반영됐는지 확인한다(미반영이면 캐시를 0 으로 굳히게 된다).
  const uwp = await pageAll<{ user_id: string; points: number | null; advantages: number | null; penalty: number | null }>(
    (f, t) => supabaseAdmin.from("user_weekly_points").select("user_id,points,advantages,penalty").order("id").range(f, t));
  const cum = new Map<string, { a: number; adv: number; pen: number }>();
  for (const r of uwp) {
    const e = cum.get(r.user_id) ?? { a: 0, adv: 0, pen: 0 };
    e.a += r.points ?? 0; e.adv += r.advantages ?? 0; e.pen += r.penalty ?? 0;
    cum.set(r.user_id, e);
  }
  const totalA = [...cum.values()].reduce((s, e) => s + e.a, 0);
  const expectedDeltaA = scope.reduce((s, r) => s + r.exp_a, 0);
  console.log(`[precheck] uwp 전체 ΣA=${totalA} (복구 전 24803 · 복구 후 기대 ${24803 + expectedDeltaA})`);
  if (totalA < 24803 + expectedDeltaA) {
    console.error(`✖ 복구가 아직 반영되지 않았다(ΣA ${totalA} < ${24803 + expectedDeltaA}). STEP 01 커밋 후 다시 실행할 것 — 중단(write 0).`);
    process.exit(1);
  }

  if (!APPLY) {
    const plan = {
      mode: "preview", targetUsers: userIds.length,
      steps: ["① user_cumulative_points upsert", "② recalcUserGrowthStats", "③ syncGradeStats", "④ weekly-card snapshot 재계산(⑤ roster slim 동시 기록)"],
      sampleCumulative: userIds.slice(0, 10).map((u) => ({ user_id: u, ...cum.get(u) })),
    };
    writeFileSync(OUT, JSON.stringify(plan, null, 1), "utf8");
    console.log("preview 완료 — write 0.  →", OUT);
    console.log("실제 실행: --apply");
    return;
  }

  const nowIso = new Date().toISOString();
  const report: any = { mode: "apply", startedAt: nowIso, targetUsers: userIds.length, cumulative: 0, growthStats: 0, gradeStats: 0, failures: [] as string[] };

  // ① user_cumulative_points (pmsPointlogsSync 와 동일 산식)
  for (const uid of userIds) {
    const e = cum.get(uid) ?? { a: 0, adv: 0, pen: 0 };
    const { error } = await supabaseAdmin.from("user_cumulative_points").upsert(
      {
        user_id: uid,
        total_checks: e.a,
        total_raw_advantages: e.adv,
        total_penalties: e.pen,
        total_advantages: e.adv - e.pen,
        updated_at: nowIso,
      },
      { onConflict: "user_id" },
    );
    if (error) { report.failures.push(`cumulative ${uid}: ${error.message}`); continue; }
    report.cumulative++;
  }
  console.log(`① user_cumulative_points upsert ${report.cumulative}/${userIds.length}`);

  // ②③ growth/grade stats (사용자별 격리)
  for (const uid of userIds) {
    try { await recalcUserGrowthStats(uid); report.growthStats++; } catch (e) { report.failures.push(`growthStats ${uid}: ${(e as Error).message}`); }
    try { await syncGradeStats(uid); report.gradeStats++; } catch (e) { report.failures.push(`gradeStats ${uid}: ${(e as Error).message}`); }
  }
  console.log(`② user_growth_stats ${report.growthStats} · ③ user_grade_stats ${report.gradeStats}`);

  // ④⑤ weekly-card snapshot (+ roster slim 동시 기록)
  const snap = await recomputeWeeklyCardsSnapshotsForUsers(userIds, { concurrency: CONCURRENCY });
  report.snapshot = snap;
  console.log(`④⑤ snapshot 재계산 requested=${snap.requested} recomputed=${snap.recomputed} failed=${snap.failed}`);
  if (snap.failed) console.log("   실패 사용자:", snap.failedUserIds.slice(0, 20).join(", "));

  report.finishedAt = new Date().toISOString();
  writeFileSync(OUT, JSON.stringify(report, null, 1), "utf8");
  console.log("→", OUT);
  if (report.failures.length) { console.error(`⚠ 실패 ${report.failures.length}건 — 로그 확인 후 해당 사용자만 재실행`); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });

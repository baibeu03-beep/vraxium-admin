/**
 * diag-club-rank-seasonal-rest-population — read-only.
 *
 * 질문: 승격된 seasonal_rest 사용자가 club rank 품계 백분위 "모집단"에 포함되는가?
 *   포함된다면 활성 사용자들의 품계 분포가 (R 포함 ↔ R 제외) 사이에서 달라지는가?
 *
 * SoT 산식(lib/cluster3ClubRankData.ts getClubRank / getClubRankGradeBatch)을 그대로 재현하되
 * 주차별 모집단을 두 시나리오로 계산한다:
 *   (A) 현재 동작: 모집단 = 전체 user_weekly_points 행 (R 포함)
 *   (B) 제외:      모집단 = R(seasonal_rest) 행을 뺀 user_weekly_points
 * 두 시나리오로 비-R 활성 사용자의 품계를 계산해 분포/개별 변화를 비교한다.
 *
 *   npx tsx --env-file=.env.local scripts/diag-club-rank-seasonal-rest-population.ts
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { resolveRankGrade, type RankGradeLabel } from "@/lib/cluster3GrowthTypes";

const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);

type Uwp = { user_id: string; year: number; week_number: number; points: number; advantages: number; penalty: number };
const score = (r: { points: number; advantages: number; penalty: number }) => r.points * 1 + r.advantages * 3 - r.penalty * 5;

async function fetchAll<T>(table: string, select: string, order: string[], filt?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q: any = sb.from(table).select(select);
    for (const o of order) q = q.order(o, { ascending: true });
    q = q.range(from, from + 999);
    if (filt) q = filt(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

// SoT 품계 계산. population 의 user_weekly_points 로 주차별 RANK/백분위를 만들고,
// roster 사용자별 평균 백분위(온보딩 첫 주차 제외)→품계 라벨을 반환.
function computeGrades(
  population: Uwp[],
  roster: Set<string>,
  firstWeek: Map<string, { year: number; week: number }>,
): Map<string, RankGradeLabel | null> {
  const byWeek = new Map<string, Uwp[]>();
  for (const r of population) {
    const k = `${r.year}-${r.week_number}`;
    (byWeek.get(k) ?? byWeek.set(k, []).get(k)!).push(r);
  }
  const pctByUser = new Map<string, Array<{ year: number; week: number; pct: number }>>();
  for (const [, rows] of byWeek) {
    const scored = rows.map((r) => ({ userId: r.user_id, s: score(r), year: r.year, week: r.week_number }));
    scored.sort((a, b) => b.s - a.s);
    const total = scored.length;
    let rank = 1;
    for (let i = 0; i < scored.length; i++) {
      if (i > 0 && scored[i].s < scored[i - 1].s) rank = i + 1;
      const u = scored[i];
      if (!roster.has(u.userId)) continue;
      const pct = total <= 1 ? 1 : Math.ceil(((rank - 1) / (total - 1)) * 99) + 1;
      (pctByUser.get(u.userId) ?? pctByUser.set(u.userId, []).get(u.userId)!).push({ year: u.year, week: u.week, pct });
    }
  }
  const out = new Map<string, RankGradeLabel | null>();
  for (const uid of roster) {
    const details = pctByUser.get(uid) ?? [];
    const fw = firstWeek.get(uid);
    const eligible = details.filter((d) => !(fw && d.year === fw.year && d.week === fw.week));
    if (eligible.length === 0) { out.set(uid, null); continue; }
    const avg = Math.ceil((eligible.reduce((s, d) => s + d.pct, 0) / eligible.length) * 100) / 100;
    out.set(uid, resolveRankGrade(avg));
  }
  return out;
}

async function main() {
  console.log("로딩: user_profiles, user_weekly_points, user_week_statuses...");
  const profiles = await fetchAll<{ user_id: string; growth_status: string | null; status: string | null; organization_slug: string | null }>(
    "user_profiles", "user_id,growth_status,status,organization_slug", ["user_id"]);
  const allUwp = await fetchAll<Uwp>("user_weekly_points", "user_id,year,week_number,points,advantages,penalty", ["year", "week_number", "user_id"]);
  const uws = await fetchAll<{ user_id: string; year: number; week_number: number }>("user_week_statuses", "user_id,year,week_number", ["user_id"]);

  const firstWeek = new Map<string, { year: number; week: number }>();
  for (const r of uws) {
    const cur = firstWeek.get(r.user_id);
    if (!cur || r.year < cur.year || (r.year === cur.year && r.week_number < cur.week)) firstWeek.set(r.user_id, { year: r.year, week: r.week_number });
  }

  const restIds = new Set(profiles.filter((p) => p.growth_status === "seasonal_rest").map((p) => p.user_id));
  const orgUsers = new Set(profiles.filter((p) => p.organization_slug != null).map((p) => p.user_id));

  // 1) seasonal_rest 사용자 uwp 발자국
  const restUwp = allUwp.filter((r) => restIds.has(r.user_id));
  const restRealUwp = restUwp.filter((r) => r.year !== 1900);
  const restSentinel = restUwp.filter((r) => r.year === 1900);
  const restWeekKeys = new Set(restRealUwp.map((r) => `${r.year}-${r.week_number}`));
  console.log("\n=== seasonal_rest 모집단 발자국 ===");
  console.log(`seasonal_rest 사용자          : ${restIds.size}명`);
  console.log(`그들의 uwp 행(전체)           : ${restUwp.length}`);
  console.log(`  ├─ 실주차(year!=1900)       : ${restRealUwp.length}  (점유 주차 ${restWeekKeys.size}종)`);
  console.log(`  └─ 1900 sentinel 행          : ${restSentinel.length}`);
  // 점유 주차 연도 분포
  const yearHist = new Map<number, number>();
  for (const k of restWeekKeys) { const y = Number(k.split("-")[0]); yearHist.set(y, (yearHist.get(y) ?? 0) + 1); }
  console.log(`  실주차 연도 분포            : ${[...yearHist.entries()].sort().map(([y, n]) => `${y}:${n}`).join(" ")}`);

  // 2) R 행이 비-R 사용자와 같은 주차를 공유하는지(=모집단 오염 여부)
  const nonRestActive = new Set(profiles.filter((p) => p.organization_slug != null && !restIds.has(p.user_id)).map((p) => p.user_id));
  const nonRestWeekKeys = new Set(allUwp.filter((r) => nonRestActive.has(r.user_id) && r.year !== 1900).map((r) => `${r.year}-${r.week_number}`));
  const sharedWeeks = [...restWeekKeys].filter((k) => nonRestWeekKeys.has(k));
  console.log(`\nseasonal_rest 점유 주차 중 비-R 활성과 공유: ${sharedWeeks.length}/${restWeekKeys.size}종`);
  console.log(`  → 공유 주차에서 R 사용자는 비-R 사용자의 백분위 모집단(분모/순위)에 포함됨`);
  // 1900 sentinel 주차의 모집단(전 이관자 공유)
  const sentinelPop = allUwp.filter((r) => r.year === 1900);
  console.log(`1900-sentinel 주차 모집단 전체 : ${sentinelPop.length}행 (R ${restSentinel.length} 포함) — 이 가짜 주차도 비-R 평균에 1주차로 산입`);

  // 3) 품계 분포: (A) R 포함 vs (B) R 제외 — 비-R 활성 사용자 대상
  const roster = nonRestActive;
  const popA = allUwp;                                   // 현재 동작
  const popB = allUwp.filter((r) => !restIds.has(r.user_id)); // R 모집단 제외
  console.log("\n품계 계산 중 (비-R 활성 roster %d명)...", roster.size);
  const gradesA = computeGrades(popA, roster, firstWeek);
  const gradesB = computeGrades(popB, roster, firstWeek);

  const order: RankGradeLabel[] = ["정승", "정1품", "정2품", "정3품", "정4품", "정5품", "정6품", "정7품", "정8품", "정9품"];
  const distA = new Map<string, number>(); const distB = new Map<string, number>();
  let changed = 0; const changes: string[] = [];
  for (const uid of roster) {
    const a = gradesA.get(uid) ?? "(null)"; const b = gradesB.get(uid) ?? "(null)";
    distA.set(a, (distA.get(a) ?? 0) + 1); distB.set(b, (distB.get(b) ?? 0) + 1);
    if (a !== b) { changed++; if (changes.length < 25) changes.push(`${uid.slice(0, 8)} ${b} → ${a}`); }
  }
  console.log("\n=== 비-R 활성 사용자 품계 분포 (R 제외 B → R 포함 A) ===");
  console.log("품계      | R제외(B) | R포함(A, 현재)");
  for (const g of [...order, "(null)" as any]) {
    const a = distA.get(g) ?? 0, b = distB.get(g) ?? 0;
    if (a === 0 && b === 0) continue;
    console.log(`${g.padEnd(8)} | ${String(b).padStart(7)} | ${String(a).padStart(7)}${a !== b ? `   (Δ${a - b > 0 ? "+" : ""}${a - b})` : ""}`);
  }
  console.log(`\n품계가 바뀌는 비-R 활성 사용자: ${changed}/${roster.size}명`);
  if (changes.length) console.log("  예시(최대 25):\n   " + changes.join("\n   "));
  console.log(changed === 0
    ? "\n✅ R 포함/제외가 비-R 활성 사용자 품계에 영향 0 (공유 주차에서 R 의 순위 영향이 백분위 라운딩을 못 넘김)"
    : "\n⚠ R 모집단 포함이 비-R 활성 사용자 품계를 변화시킴 — 의도 검토 필요");
}

main().catch((e) => { console.error(e); process.exit(1); });

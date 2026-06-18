/**
 * verify-club-rank-seasonal-rest-exclusion — read-only.
 *
 * seasonal_rest 모집단 제외 정책 검증.
 *   AFTER = 실제 SoT 함수 getClubRank / getClubRankGradeBatch (수정 후 = R 제외).
 *   BEFORE = 동일 산식 인라인 복제(R 포함) — 수정 전 동작 재현.
 * 1) 복제(R제외) == 실제 batch 일치 → 복제 신뢰 확보(=BEFORE 수치 신뢰).
 * 2) seasonal_rest 사용자: getClubRank → null(—), batch → null.
 * 3) active 사용자: getClubRank == batch.
 * 4) 분포 before/after + 영향 active 수.
 *
 *   npx tsx --env-file=.env.local scripts/verify-club-rank-seasonal-rest-exclusion.ts
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { getClubRank, getClubRankGradeBatch } from "@/lib/cluster3ClubRankData";
import { resolveRankGrade, GRADE_NUMBER_MAP, type RankGradeLabel } from "@/lib/cluster3GrowthTypes";

const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);

type Uwp = { user_id: string; year: number; week_number: number; points: number; advantages: number; penalty: number };
const score = (r: { points: number; advantages: number; penalty: number }) => r.points - r.penalty * 5 + r.advantages * 3;

async function fetchAll<T>(t: string, sel: string, order: string[], filt?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q: any = sb.from(t).select(sel);
    for (const o of order) q = q.order(o, { ascending: true });
    q = q.range(from, from + 999);
    if (filt) q = filt(q);
    const { data, error } = await q;
    if (error) throw new Error(`${t}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

// 인라인 복제(R 포함/제외 선택) — 프로즌(graduated/suspended) 무시한 순수 모집단 산식.
function gradesInline(pop: Uwp[], roster: Set<string>, firstWeek: Map<string, { y: number; w: number }>): Map<string, RankGradeLabel | null> {
  const byWeek = new Map<string, Uwp[]>();
  for (const r of pop) { const k = `${r.year}-${r.week_number}`; (byWeek.get(k) ?? byWeek.set(k, []).get(k)!).push(r); }
  const pct = new Map<string, Array<{ y: number; w: number; p: number }>>();
  for (const [, rows] of byWeek) {
    const s = rows.map((r) => ({ u: r.user_id, s: score(r), y: r.year, w: r.week_number })).sort((a, b) => b.s - a.s);
    const total = s.length; let rank = 1;
    for (let i = 0; i < s.length; i++) {
      if (i > 0 && s[i].s < s[i - 1].s) rank = i + 1;
      if (!roster.has(s[i].u)) continue;
      const p = total <= 1 ? 1 : Math.ceil(((rank - 1) / (total - 1)) * 99) + 1;
      (pct.get(s[i].u) ?? pct.set(s[i].u, []).get(s[i].u)!).push({ y: s[i].y, w: s[i].w, p });
    }
  }
  const out = new Map<string, RankGradeLabel | null>();
  for (const u of roster) {
    const fw = firstWeek.get(u);
    const elig = (pct.get(u) ?? []).filter((d) => !(fw && d.y === fw.y && d.w === fw.w));
    if (!elig.length) { out.set(u, null); continue; }
    out.set(u, resolveRankGrade(Math.ceil((elig.reduce((a, d) => a + d.p, 0) / elig.length) * 100) / 100));
  }
  return out;
}

async function main() {
  const profiles = await fetchAll<{ user_id: string; growth_status: string | null; organization_slug: string | null }>(
    "user_profiles", "user_id,growth_status,organization_slug", ["user_id"]);
  // 안정 정렬키(year,week_number,user_id) — 실제 SoT 와 동일. user_id 누락 시 >1000행
  // .range() 페이지네이션이 페이지 경계에서 행을 중복/누락해 모집단이 틀어진다.
  const allUwp = await fetchAll<Uwp>("user_weekly_points", "user_id,year,week_number,points,advantages,penalty", ["year", "week_number", "user_id"]);
  const uws = await fetchAll<{ user_id: string; year: number; week_number: number }>("user_week_statuses", "user_id,year,week_number", ["user_id"]);
  const frozen = new Set((await fetchAll<{ user_id: string }>("user_club_rank_frozen", "user_id", ["user_id"])).map((r) => r.user_id));

  const firstWeek = new Map<string, { y: number; w: number }>();
  for (const r of uws) { const c = firstWeek.get(r.user_id); if (!c || r.year < c.y || (r.year === c.y && r.week_number < c.w)) firstWeek.set(r.user_id, { y: r.year, w: r.week_number }); }

  const restIds = new Set(profiles.filter((p) => p.growth_status === "seasonal_rest").map((p) => p.user_id));
  // active roster = org 보유 · 非rest · 非frozen(프로즌은 인라인 복제가 다루지 않으므로 비교에서 제외).
  const roster = new Set(profiles.filter((p) => p.organization_slug != null && !restIds.has(p.user_id) && !frozen.has(p.user_id)).map((p) => p.user_id));

  // ── BEFORE(R 포함) / AFTER(R 제외) 인라인 ──
  const before = gradesInline(allUwp, roster, firstWeek);
  const afterReplica = gradesInline(allUwp.filter((r) => !restIds.has(r.user_id)), roster, firstWeek);

  // ── AFTER 실제 SoT batch ──
  const rosterArr = [...roster];
  const realBatch = await getClubRankGradeBatch(rosterArr);

  // 1) 복제(after) == 실제 batch?
  let mism = 0; const mismEx: string[] = [];
  for (const u of rosterArr) {
    const rep = afterReplica.get(u);
    const real = realBatch.get(u);
    const realLabel = real ? (real.label as RankGradeLabel) : null;
    if ((rep ?? null) !== (realLabel ?? null)) { mism++; if (mismEx.length < 10) mismEx.push(`${u.slice(0, 8)} replica=${rep} real=${realLabel}`); }
  }
  console.log(`\n[1] 복제(R제외) == 실제 getClubRankGradeBatch : ${mism === 0 ? "✅ 일치" : `✗ ${mism}건 불일치`}`);
  if (mismEx.length) console.log("    " + mismEx.join("\n    "));

  // 2) 분포 before/after + 변화 수
  const order: (RankGradeLabel | "(null)")[] = ["정승", "정1품", "정2품", "정3품", "정4품", "정5품", "정6품", "정7품", "정8품", "정9품", "(null)"];
  const dB = new Map<string, number>(), dA = new Map<string, number>(); let changed = 0;
  for (const u of roster) {
    const b = (before.get(u) ?? "(null)") as string, a = (afterReplica.get(u) ?? "(null)") as string;
    dB.set(b, (dB.get(b) ?? 0) + 1); dA.set(a, (dA.get(a) ?? 0) + 1);
    if (a !== b) changed++;
  }
  console.log(`\n[2] 품계 분포 (active 非frozen roster ${roster.size}명)`);
  console.log("    품계     | BEFORE(R포함) | AFTER(R제외)");
  for (const g of order) { const b = dB.get(g) ?? 0, a = dA.get(g) ?? 0; if (!a && !b) continue; console.log(`    ${String(g).padEnd(8)} | ${String(b).padStart(11)} | ${String(a).padStart(10)}${a !== b ? `  (Δ${a - b > 0 ? "+" : ""}${a - b})` : ""}`); }
  console.log(`    → 품계 변경 active 사용자: ${changed}/${roster.size}명`);

  // 3) seasonal_rest 샘플: getClubRank → null, batch → null
  const restSample = [...restIds].slice(0, 3);
  console.log(`\n[3] seasonal_rest 사용자 품계 (모집단 제외 → null/— 기대)`);
  const restBatch = await getClubRankGradeBatch(restSample);
  for (const u of restSample) {
    const dto = await getClubRank(u);
    const rb = restBatch.get(u);
    console.log(`    ${u.slice(0, 8)} getClubRank: avg=${dto.avgPercentile} grade=${dto.rankGrade} weeks=${dto.weeklyDetails.length} | batch=${rb ? rb.label : "null"}  ${dto.rankGrade === null && !rb ? "✅" : "✗"}`);
  }

  // 4) active 샘플: getClubRank == batch
  const actSample = rosterArr.slice(0, 3);
  console.log(`\n[4] active 사용자 getClubRank == batch`);
  for (const u of actSample) {
    const dto = await getClubRank(u);
    const rb = realBatch.get(u);
    const dtoGradeNum = dto.rankGrade ? GRADE_NUMBER_MAP[dto.rankGrade as RankGradeLabel] : null;
    const ok = (dtoGradeNum ?? null) === (rb?.grade ?? null);
    console.log(`    ${u.slice(0, 8)} getClubRank=${dto.rankGrade}(avg ${dto.avgPercentile}) | batch=${rb?.label ?? "null"}  ${ok ? "✅" : "✗"}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

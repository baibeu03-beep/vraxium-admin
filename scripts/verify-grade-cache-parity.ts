/** 검증(read-only): user_grade_stats 캐시 == live(getClubRankGradeBatch) — grade/label/avg_percentile.
 *   npx tsx --env-file=.env.local scripts/verify-grade-cache-parity.ts */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getClubRankGradeBatch } from "@/lib/cluster3ClubRankData";

async function main() {
  // 캐시 전수 로드
  const cache = new Map<string, { grade: number | null; label: string | null; pct: number | null }>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from("user_grade_stats").select("user_id, grade, grade_label, avg_percentile")
      .order("user_id", { ascending: true }).range(from, from + 999);
    if (error) throw error;
    for (const r of (data ?? []) as any[]) cache.set(r.user_id, { grade: r.grade, label: r.grade_label, pct: r.avg_percentile });
    if ((data ?? []).length < 1000) break;
  }
  // org 보유 전 사용자 = live 대상
  const ids: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from("user_profiles").select("user_id").not("organization_slug", "is", null)
      .order("user_id", { ascending: true }).range(from, from + 999);
    if (error) throw error;
    const rows = (data ?? []) as any[]; ids.push(...rows.map((r) => r.user_id));
    if (rows.length < 1000) break;
  }
  const live = await getClubRankGradeBatch(ids); // 1회 전체 스캔

  let gradedLive = 0, missingCache = 0, gradeMis = 0, labelMis = 0, pctMis = 0;
  const pctSamples: string[] = [];
  for (const id of ids) {
    const l = live.get(id) ?? null;
    const c = cache.get(id);
    if (l) gradedLive++;
    if (!c) { if (l) missingCache++; continue; }
    const lGrade = l?.grade ?? null, lLabel = l?.label ?? null;
    const lPct = l ? Number(l.avgPercentile.toFixed(2)) : null;
    const cPct = c.pct == null ? null : Number(Number(c.pct).toFixed(2));
    if ((c.grade ?? null) !== lGrade) gradeMis++;
    if ((c.label ?? null) !== lLabel) labelMis++;
    if (cPct !== lPct) { pctMis++; if (pctSamples.length < 6) pctSamples.push(`${id.slice(0,8)} cache=${cPct} live=${lPct}`); }
  }
  console.log(`대상 org 사용자=${ids.length} · live graded=${gradedLive} · 캐시행=${cache.size}`);
  console.log(`누락(live graded인데 캐시 없음)=${missingCache}`);
  console.log(`grade 불일치=${gradeMis} · label 불일치=${labelMis} · avg_percentile 불일치=${pctMis}`);
  if (pctSamples.length) console.log("  pct 샘플:", pctSamples.join(" | "));
  const ok = missingCache === 0 && gradeMis === 0 && labelMis === 0 && pctMis === 0;
  console.log(ok ? "✅ 캐시 == live (grade/label/avg_percentile 전부 일치) — 고객 캐시 전환 안전"
                 : "❌ 불일치 존재 — 재동기 또는 반올림 정책 점검 필요");
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });

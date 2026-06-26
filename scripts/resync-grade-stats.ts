/**
 * user_grade_stats 전체 재동기(1회 스캔) + 318 커버/parity 검증.
 *   npx tsx --env-file=.env.local scripts/resync-grade-stats.ts            # 검증만(write 0)
 *   npx tsx --env-file=.env.local scripts/resync-grade-stats.ts --apply    # resync 실행
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resyncGradeStatsBatch, getClubRankGradeBatch } from "@/lib/cluster3ClubRankData";
import { operationalSeasonDbKey } from "@/lib/seasonCalendar";

const APPLY = process.argv.includes("--apply");
const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(70));
let fail = 0;
const ck = (l: string, ok: boolean, d = "") => { line(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

async function participantIds(): Promise<string[]> {
  const opKey = operationalSeasonDbKey(new Date().toISOString().slice(0, 10));
  const out: string[] = [];
  for (let f = 0; ; f += 1000) {
    const { data } = await supabaseAdmin.from("user_season_statuses").select("user_id").eq("season_key", opKey).order("user_id").range(f, f + 999);
    for (const r of (data ?? []) as any[]) out.push(r.user_id);
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

async function main() {
  if (APPLY) {
    hr(); line("resyncGradeStatsBatch() 실행(1회 전체 스캔)"); hr();
    const r = await resyncGradeStatsBatch();
    line(`  total=${r.total} graded=${r.graded} nulled=${r.nulled}`);
  } else {
    line("(검증만 — resync 하려면 --apply)");
  }

  hr(); line("318 커버리지 + cache==live parity"); hr();
  const ids = await participantIds();
  line(`  operationalSeasonKey 모집단: ${ids.length}`);
  const cache = new Map<string, any>();
  for (let i = 0; i < ids.length; i += 300) {
    const { data } = await supabaseAdmin.from("user_grade_stats").select("user_id,grade,grade_label,avg_percentile,updated_at").in("user_id", ids.slice(i, i + 300));
    for (const r of (data ?? []) as any[]) cache.set(r.user_id, r);
  }
  ck("318 전원 user_grade_stats 존재", cache.size === ids.length, `${cache.size}/${ids.length}`);
  const missing = ids.filter((id) => !cache.has(id));
  if (missing.length) line(`  누락: ${missing.length} (${missing.slice(0, 5).map((s) => s.slice(0, 8)).join(",")}...)`);

  // parity: 전체 318 cache.grade == live grade
  const live = await getClubRankGradeBatch(ids);
  let match = 0, mismatch = 0; const diffs: string[] = [];
  for (const id of ids) {
    const cg = cache.get(id)?.grade ?? null;
    const lg = live.get(id)?.grade ?? null;
    if (cg === lg) match++; else { mismatch++; if (diffs.length < 10) diffs.push(`${id.slice(0, 8)} cache=${cg} live=${lg}`); }
  }
  ck("cache.grade == live.grade (318 전원)", mismatch === 0, `일치 ${match} 불일치 ${mismatch}`);
  for (const d of diffs) line(`   ${d}`);

  hr();
  line(fail === 0 ? "✅ grade-stats 캐시 검증 PASS" : `❌ ${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });

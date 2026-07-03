/**
 * verify-grade-cache-postresync.ts — 전체 resync 후 6기준 검증 (READ-ONLY).
 *   npx tsx --env-file=.env.local scripts/verify-grade-cache-postresync.ts
 */
import { createClient } from "@supabase/supabase-js";
import { getClubRank } from "@/lib/cluster3ClubRankData";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const IK = process.env.INTERNAL_API_KEY!;
const ADMIN = "https://vraxium-admin.vercel.app";
const FRONT = "https://vraxium.vercel.app";

async function adminHttp(uid: string): Promise<number | string | null> {
  try { const r = await fetch(`${ADMIN}/api/cluster3/club-rank?userId=${uid}`, { headers: { "x-internal-api-key": IK }, signal: AbortSignal.timeout(30000) }); const j = await r.json(); return j?.data?.avgPercentile ?? null; } catch { return "ERR"; }
}
async function custProfilePct(uid: string, key: "userId" | "demoUserId"): Promise<{ status: number; pct: number | null | string }> {
  try { const r = await fetch(`${FRONT}/api/profile?${key}=${uid}`, { signal: AbortSignal.timeout(30000) }); const j = await r.json(); return { status: r.status, pct: j?.gradeStats?.avgPercentile ?? null }; } catch { return { status: 0, pct: "ERR" }; }
}
const near = (a: any, b: any, tol = 0.5) => { const x = a == null ? null : Number(a), y = b == null ? null : Number(b); if (x === null && y === null) return true; if (x === null || y === null) return false; return Math.abs(x - y) <= tol; };

async function main() {
  // (5) 이전 극단 행 + (2,3) drift 행 대조
  const watch = ["aac4639b-", "c28b2409-", "08480e43-", "05ff6b96-", "e649370f-"];
  console.log("=== [기준2/3/5] 이전 문제 행: DB캐시 vs live vs adminHTTP ===");
  const { data: allCache } = await sb.from("user_grade_stats").select("user_id,avg_percentile,grade_label,updated_at");
  const cacheById = new Map((allCache ?? []).map((r: any) => [r.user_id, r]));
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const testerSet = new Set((markers ?? []).map((m: any) => m.user_id));
  for (const pre of watch) {
    const row = (allCache ?? []).find((r: any) => r.user_id.startsWith(pre));
    if (!row) { console.log(`${pre} (행 없음)`); continue; }
    const uid = row.user_id;
    const live = await getClubRank(uid);
    const http = await adminHttp(uid);
    const cache = row.avg_percentile == null ? null : Number(row.avg_percentile);
    console.log(`${uid.slice(0,8)} cache=${String(cache).padStart(6)} live=${String(live.avgPercentile).padStart(6)} http=${String(http).padStart(6)} upd=${String(row.updated_at).slice(0,16)} | cache==live:${near(cache,live.avgPercentile)?"✓":"✗"} cache==http:${near(cache,http)?"✓":"✗"} tester:${testerSet.has(uid)}`);
  }

  // (2,3) 전수 재스캔: 캐시 vs live 표본
  console.log("\n=== [기준2/3] 전수 재스캔(표본 40) cache vs live ===");
  const sample = (allCache ?? []).filter((r:any)=>r.avg_percentile!=null).slice(0, 40);
  let mism = 0, nullCnt = (allCache ?? []).filter((r:any)=>r.avg_percentile==null).length;
  const bad: any[] = [];
  for (const row of sample) {
    const live = await getClubRank(row.user_id);
    if (!near(Number(row.avg_percentile), live.avgPercentile)) { mism++; bad.push({ u: row.user_id.slice(0,8), cache: Number(row.avg_percentile), live: live.avgPercentile }); }
  }
  console.log(`표본 ${sample.length}명 중 cache≠live: ${mism}명 (기대 0)  | 전체 avg_percentile=null 행수: ${nullCnt}`);
  for (const b of bad.slice(0,10)) console.log("  MISMATCH", JSON.stringify(b));

  // (4,6) 고객 HTTP + demoUserId — 테스터로
  console.log("\n=== [기준4/6] 고객 /api/profile gradeStats.avgPercentile (테스터) userId vs demoUserId ===");
  const testers = [...testerSet].filter((id) => cacheById.has(id)).slice(0, 5);
  for (const uid of testers as string[]) {
    const live = await getClubRank(uid);
    const cache = cacheById.get(uid);
    const cUser = await custProfilePct(uid, "userId");
    const cDemo = await custProfilePct(uid, "demoUserId");
    console.log(`${uid.slice(0,8)} live=${String(live.avgPercentile).padStart(6)} cache=${String(cache?.avg_percentile).padStart(6)} custUser=${String(cUser.pct).padStart(6)}(${cUser.status}) custDemo=${String(cDemo.pct).padStart(6)}(${cDemo.status}) | cust==live:${near(cUser.pct,live.avgPercentile)?"✓":"✗"} user==demo:${near(cUser.pct,cDemo.pct,0.001)?"✓":"✗"}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

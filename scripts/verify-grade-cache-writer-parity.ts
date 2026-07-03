/**
 * verify-grade-cache-writer-parity.ts — user_grade_stats 캐시 stale 원인 규명 (READ-ONLY, write 0).
 *   npx tsx --env-file=.env.local scripts/verify-grade-cache-writer-parity.ts
 *
 * 각 사용자에 대해 4값 대조:
 *   (A) DB 캐시        user_grade_stats.avg_percentile (+updated_at)
 *   (B) live SoT       getClubRank(uid).avgPercentile        ← 고객/어드민 club-rank 라우트 정본
 *   (C) writer 재계산  getClubRankGradeBatch([...]).avgPercentile ← sync:grade-stats 가 UPSERT 하는 값(dry)
 *   (D) admin HTTP     GET /api/cluster3/club-rank?userId=
 * 판정: B==C==D → writer 알고리즘 == live(버그 아님). A != B → 캐시 stale(재동기 필요).
 */
import { createClient } from "@supabase/supabase-js";
import { getClubRank, getClubRankGradeBatch } from "@/lib/cluster3ClubRankData";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const IK = process.env.INTERNAL_API_KEY!;
const ADMIN = "https://vraxium-admin.vercel.app";

async function httpRank(uid: string) {
  try {
    const r = await fetch(`${ADMIN}/api/cluster3/club-rank?userId=${uid}`, { headers: { "x-internal-api-key": IK }, signal: AbortSignal.timeout(30000) });
    const j = await r.json();
    return j?.data?.avgPercentile ?? null;
  } catch { return "ERR"; }
}

async function main() {
  // 표본: 극단 2행(05-25) + drift 몇 명 + 캐시 최신행 몇 명
  const { data: oldRows } = await sb.from("user_grade_stats").select("user_id,avg_percentile,grade_label,updated_at").order("updated_at", { ascending: true }).limit(6);
  const { data: newRows } = await sb.from("user_grade_stats").select("user_id,avg_percentile,grade_label,updated_at").order("updated_at", { ascending: false }).limit(4);
  const sample = [...(oldRows ?? []), ...(newRows ?? [])];
  const ids = sample.map((r) => r.user_id);

  // C) writer 재계산 (한 번에) — read-only
  const batch = await getClubRankGradeBatch(ids);

  console.log("uid       | A:cache | B:live | C:writer | D:http | cacheUpdated | B==C | A==B");
  for (const row of sample) {
    const uid = row.user_id;
    const A = row.avg_percentile === null ? null : Number(row.avg_percentile);
    const live = await getClubRank(uid);
    const B = live.avgPercentile;
    const C = batch.get(uid)?.avgPercentile ?? null;
    const D = await httpRank(uid);
    const bc = (B === null && C === null) || (B !== null && C !== null && Math.abs(Number(B) - Number(C)) <= 0.01);
    const ab = (A === null && B === null) || (A !== null && B !== null && Math.abs(A - Number(B)) <= 0.5);
    console.log(
      `${uid.slice(0, 8)} | ${String(A).padStart(6)} | ${String(B).padStart(5)} | ${String(C).padStart(7)} | ${String(D).padStart(5)} | ${String(row.updated_at).slice(0,10)} | ${bc ? "✓" : "✗"} | ${ab ? "✓" : "STALE"}`,
    );
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

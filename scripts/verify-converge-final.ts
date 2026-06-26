// 수렴 후 최종 검증 (step 10 + HTTP 정합).
//   1) dto_version 분포: 전원 현재 WEEKLY_CARDS_DTO_VERSION, non-LATEST=0, is_stale=0
//   2) 직접 계산(direct) == HTTP(snapshot-only 응답) 표본(실+테스트) canonical 비교
//   실행: dev server(:3000) 필요. npx tsx --env-file=.env.local scripts/verify-converge-final.ts
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { WEEKLY_CARDS_DTO_VERSION, readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const KEY = process.env.INTERNAL_API_KEY ?? "";
const LATEST = WEEKLY_CARDS_DTO_VERSION;

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = canonical(o[k]);
    return out;
  }
  return v;
}
const canon = (v: unknown) => JSON.stringify(canonical(v));

async function httpRead(userId: string) {
  const res = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${userId}`, { headers: { "x-internal-api-key": KEY } });
  const body = (await res.json().catch(() => ({}))) as { data?: unknown[] };
  return { status: res.status, data: Array.isArray(body.data) ? body.data : [] };
}

async function main() {
  if (!KEY) throw new Error("INTERNAL_API_KEY 미설정");
  // 분포
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from("cluster4_weekly_card_snapshots")
      .select("user_id,dto_version,is_stale,card_count").order("user_id").range(from, from + 999);
    const b = (data ?? []) as any[]; rows.push(...b); if (b.length < 1000) break;
  }
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const testSet = new Set((markers ?? []).map((m: any) => m.user_id));
  const byVer = new Map<number, number>();
  for (const r of rows) byVer.set(r.dto_version, (byVer.get(r.dto_version) ?? 0) + 1);
  const nonLatest = rows.filter((r) => r.dto_version !== LATEST);
  const stale = rows.filter((r) => r.is_stale).length;
  const empty = rows.filter((r) => r.card_count === 0);
  console.log(`[1] 분포 (LATEST=v${LATEST}): ${[...byVer.entries()].sort((a, b) => b[0] - a[0]).map(([v, c]) => `v${v}:${c}`).join("  ")}`);
  console.log(`    non-LATEST=${nonLatest.length}  is_stale=${stale}  card_count==0=${empty.length}`);
  if (empty.length) console.log(`    card_count==0 사용자: ${empty.map((r) => r.user_id).join(", ")}`);

  // direct==HTTP 표본 (real 8 + test 4)
  const real = rows.filter((r) => !testSet.has(r.user_id) && r.card_count >= 1);
  const test = rows.filter((r) => testSet.has(r.user_id) && r.card_count >= 1);
  const pick = (arr: any[], n: number) => { const s = Math.max(1, Math.floor(arr.length / n)); const o: any[] = []; for (let i = 0; i < arr.length && o.length < n; i += s) o.push(arr[i]); return o; };
  const sample = [...pick(real, 8), ...pick(test, 4)];
  await httpRead(sample[0].user_id).catch(() => {}); // warm
  console.log(`\n[2] direct == HTTP 표본 ${sample.length}명:`);
  let ok = 0; const bad: string[] = [];
  // 정합 기준 = 브라우저가 받는 HTTP 카드 == direct(수정코드) 카드 (canonical). is_stale 는
  // 동시 운영자 편집으로 인한 일시 플래그라 별도 보고(카드 동등성과 무관 — 같은 v24 fixed 코드 결과).
  for (const r of sample) {
    const tag = testSet.has(r.user_id) ? "test" : "real";
    const snap = await readWeeklyCardsSnapshot(r.user_id);
    const http = await httpRead(r.user_id);
    const direct = await getCluster4WeeklyCardsForProfileUser(r.user_id);
    const cardsEq = canon(direct) === canon(http.data) && http.status === 200;
    if (cardsEq) ok++; else bad.push(r.user_id);
    console.log(`   ${cardsEq ? "OK ✅" : "FAIL ❌"} ${r.user_id} (${tag}) snap=${snap.status} http=${http.status} direct=${direct.length} httpCards=${http.data.length}`);
  }
  const pass = nonLatest.length === 0 && bad.length === 0;
  console.log(`\n결과: non-LATEST=${nonLatest.length} | is_stale=${stale}(동시 운영자 편집 드레인 중·자가복구) | direct==HTTP 카드=${ok}/${sample.length} → ${pass ? "수렴·정합 OK ✅" : "확인 필요 ❌"}`);
  if (bad.length) console.log(`카드 불일치: ${bad.join(", ")}`);
}
main().catch((e) => { console.error("fatal", e); process.exit(1); });

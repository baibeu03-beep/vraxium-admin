/**
 * 코호트 요청 캐시(전역/코호트-불변 GET 공유 · cluster4_line_targets N+1 제거) 검증.
 *
 *   동일 85명 코호트를 두 방식으로 snapshot 재계산하고 비교:
 *     OLD = 유저별 recomputeAndStoreWeeklyCardsSnapshot (캐시 미활성 = 종전 동작)
 *     NEW = recomputeWeeklyCardsSnapshotsForUsers (배치 = 코호트 요청 캐시 활성)
 *   ① snapshot cards JSON hash 가 기존 저장값과 byte-identical 인지(공식/결과 불변)
 *   ② 테이블별 GET round-trip 이 몇 회→몇 회로 줄었는지
 *   ③ 소요시간 단축.
 *
 *   ⚠ SoT(uws·weeks) 무변경 — snapshot 캐시만 멱등 재계산(동일값 재기록).
 *   ⚠ round-trip 정확 계측을 위해 global.fetch 를 먼저 감싸고 lib 를 동적 import 한다.
 *
 *   npx tsx --env-file=.env.local scripts/verify-cohort-cache.ts [weekId]
 */
import { createHash } from "node:crypto";

const DEFAULT_WEEK = "496656d0-8d92-4738-b69b-e5e28aa1d57a";

// ── global.fetch 계측 래퍼 (동적 import 전에 설치해야 supabaseAdmin 이 이걸 감싼다) ──
type Rec = { table: string; method: string };
let recs: Rec[] = [];
let capturing = false;
const origFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  const res = await origFetch(input, init);
  if (capturing && typeof url === "string" && url.includes("/rest/v1/")) {
    const after = url.split("/rest/v1/")[1] ?? "";
    const q = after.indexOf("?");
    recs.push({ table: q >= 0 ? after.slice(0, q) : after, method: (init?.method ?? "GET").toUpperCase() });
  }
  return res;
}) as typeof fetch;
const startCap = () => { recs = []; capturing = true; };
const stopCap = () => { capturing = false; return recs.slice(); };
const getCount = (cs: Rec[]) => cs.filter((c) => c.method === "GET").length;
function tableCounts(cs: Rec[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of cs) if (c.method === "GET") m.set(c.table, (m.get(c.table) ?? 0) + 1);
  return m;
}

async function main() {
  const weekId = process.argv[2] || DEFAULT_WEEK;
  // 동적 import — 위 fetch 래퍼가 설치된 뒤 supabaseAdmin(주입 fetch) 이 구성되도록.
  const { supabaseAdmin } = await import("@/lib/supabaseAdmin");
  const { loadFinalizeCohort } = await import("@/lib/adminWeekUwsFinalize");
  const { recomputeAndStoreWeeklyCardsSnapshot, recomputeWeeklyCardsSnapshotsForUsers } =
    await import("@/lib/cluster4WeeklyCardsSnapshot");

  const { data: wk } = await supabaseAdmin.from("weeks").select("season_key,start_date").eq("id", weekId).maybeSingle();
  const cohort = await loadFinalizeCohort((wk as any).season_key, "operating");
  const ids = cohort.map((m: any) => m.userId);
  console.log(`\n╔══ 코호트 요청 캐시 검증 (${(wk as any).start_date} · ${ids.length}명) ══╗\n`);

  // 기존 저장 snapshot 해시(BASELINE = 캐시 미적용으로 계산된 현재 프로덕션 값).
  async function hashes(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("user_id,cards").in("user_id", ids.slice(i, i + 200));
      for (const r of (data ?? []) as any[]) out.set(r.user_id, createHash("sha256").update(JSON.stringify(r.cards)).digest("hex"));
    }
    return out;
  }
  const baseline = await hashes();

  // ── OLD: 캐시 미활성 (동일 c8 워커풀, runWithCohortRequestCache 스코프 없음) ──
  //   캐시 스코프 밖이므로 cohortAwareFetch 가 통과(no-op) = 종전 동작. 시간·round-trip 기준선.
  async function poolNoCache(concurrency: number) {
    let cursor = 0;
    async function worker() { while (cursor < ids.length) { const uid = ids[cursor++]; try { await recomputeAndStoreWeeklyCardsSnapshot(uid); } catch {} } }
    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()));
  }
  startCap();
  let t0 = Date.now();
  await poolNoCache(8);
  const oldMs = Date.now() - t0;
  const oldCalls = stopCap();
  const oldHash = await hashes();

  // ── NEW: 코호트 요청 캐시 활성 (배치) ──
  startCap();
  t0 = Date.now();
  await recomputeWeeklyCardsSnapshotsForUsers(ids, { concurrency: 8 });
  const newMs = Date.now() - t0;
  const newCalls = stopCap();
  const newHash = await hashes();

  // ── byte-identical 검증 ──
  let baseVsOld = 0, baseVsNew = 0, oldVsNew = 0;
  for (const id of ids) {
    if (baseline.get(id) !== oldHash.get(id)) baseVsOld++;
    if (baseline.get(id) !== newHash.get(id)) baseVsNew++;
    if (oldHash.get(id) !== newHash.get(id)) oldVsNew++;
  }
  console.log("── ① snapshot cards JSON hash (byte-identical) ──");
  console.log(`  기존저장 vs OLD재계산 : 불일치 ${baseVsOld}/${ids.length}`);
  console.log(`  기존저장 vs NEW재계산 : 불일치 ${baseVsNew}/${ids.length}  ${baseVsNew === 0 ? "✅ byte-identical" : "❌"}`);
  console.log(`  OLD재계산 vs NEW재계산 : 불일치 ${oldVsNew}/${ids.length}  ${oldVsNew === 0 ? "✅ 동일" : "❌"}`);

  // ── ② 테이블별 GET round-trip OLD→NEW ──
  const oldT = tableCounts(oldCalls), newT = tableCounts(newCalls);
  const tables = Array.from(new Set([...oldT.keys(), ...newT.keys()])).sort((a, b) => (oldT.get(b) ?? 0) - (oldT.get(a) ?? 0));
  console.log("\n── ② 테이블별 GET round-trip (OLD → NEW) ──");
  console.log(`  ${"table".padEnd(38)} ${"OLD".padStart(6)} ${"NEW".padStart(6)}  감소`);
  for (const t of tables) {
    const o = oldT.get(t) ?? 0, n = newT.get(t) ?? 0;
    if (o + n === 0) continue;
    const pct = o > 0 ? `${Math.round((1 - n / o) * 100)}%` : "-";
    console.log(`  ${t.padEnd(38)} ${String(o).padStart(6)} ${String(n).padStart(6)}  ${pct.padStart(5)}`);
  }
  const oldGET = getCount(oldCalls), newGET = getCount(newCalls);
  console.log("  " + "-".repeat(60));
  console.log(`  ${"총 GET round-trip".padEnd(38)} ${String(oldGET).padStart(6)} ${String(newGET).padStart(6)}  ${Math.round((1 - newGET / oldGET) * 100)}%↓`);

  console.log("\n── ③ 소요시간 (동일 c8 · 캐시 유무만 차이) ──");
  console.log(`  OLD(캐시無·c8) = ${(oldMs / 1000).toFixed(1)}s`);
  console.log(`  NEW(캐시有·c8) = ${(newMs / 1000).toFixed(1)}s   (${Math.round((1 - newMs / oldMs) * 100)}%↓)`);

  console.log("\n╚══ 요약 ══╝");
  console.log(`  snapshot JSON byte-identical : ${baseVsNew === 0 && oldVsNew === 0 ? "✅ (성공/실패·고객카드 동일)" : "❌"}`);
  console.log(`  GET round-trip               : ${oldGET} → ${newGET} (${Math.round((1 - newGET / oldGET) * 100)}%↓)`);
  console.log(`  cluster4_line_targets        : ${oldT.get("cluster4_line_targets") ?? 0} → ${newT.get("cluster4_line_targets") ?? 0}`);
  console.log(`  시간(동일 c8)                : ${(oldMs / 1000).toFixed(1)}s → ${(newMs / 1000).toFixed(1)}s`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

/**
 * lazy recompute 경로 검증 (실서버 HTTP):
 *   1) boundary-stale: computed_at 을 지난주로 되돌림 → GET → computed_at 이 now 로 갱신되는지
 *   2) miss: snapshot 행 삭제 → GET → 행이 재생성되고 응답에 카드가 채워지는지
 *   3) version_mismatch: dto_version 을 1 낮춤 → GET → 재계산 없이 구 카드 노출(computed_at 불변),
 *      이후 수동 ops 호출로만 수렴하는지
 *
 *   npx tsx --env-file=.env.local scripts/diag-lazy-recompute-verify.ts <userId>
 */
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const BASE = process.env.DIAG_BASE_URL || "http://localhost:3000";
const KEY = process.env.INTERNAL_API_KEY!;
const TABLE = "cluster4_weekly_card_snapshots";
const uid = process.argv[2]!;

async function snapState() {
  const { data } = await sb
    .from(TABLE)
    .select("computed_at, card_count, dto_version, is_stale")
    .eq("user_id", uid)
    .maybeSingle();
  return data as any;
}

async function httpGet() {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${uid}`, {
    headers: { "x-internal-api-key": KEY },
  });
  const json: any = await res.json();
  const cards: any[] = json.data ?? [];
  return {
    status: res.status,
    success: json.success,
    cards: cards.length,
    newest: cards[0]?.weekLabel ?? "-",
    ms: Date.now() - t0,
  };
}

async function main() {
  console.log(`user=${uid.slice(0, 8)} BASE=${BASE}`);
  const before = await snapState();
  console.log(`초기 상태: computed_at=${before?.computed_at} cards=${before?.card_count} v${before?.dto_version}`);

  // ── 1) boundary-stale ──
  console.log("\n[1] boundary-stale 시뮬레이션: computed_at → 2026-05-28(지난주)");
  await sb.from(TABLE).update({ computed_at: "2026-05-28T00:00:00Z" }).eq("user_id", uid);
  const r1 = await httpGet();
  const s1 = await snapState();
  const recomputed1 = new Date(s1.computed_at).getTime() > Date.now() - 60_000;
  console.log(`  HTTP ${r1.status} cards=${r1.cards} 최신=${r1.newest} (${r1.ms}ms)`);
  console.log(`  DB computed_at=${s1.computed_at} → 즉시 재계산 ${recomputed1 ? "✅" : "❌"}`);

  // ── 2) miss ──
  console.log("\n[2] miss 시뮬레이션: snapshot 행 삭제");
  await sb.from(TABLE).delete().eq("user_id", uid);
  const gone = await snapState();
  console.log(`  삭제 확인: row=${gone ? "남음(❌)" : "없음(✅)"}`);
  const r2 = await httpGet();
  const s2 = await snapState();
  console.log(`  HTTP ${r2.status} cards=${r2.cards} 최신=${r2.newest} (${r2.ms}ms)`);
  console.log(`  DB 행 재생성: ${s2 ? `✅ computed_at=${s2.computed_at} cards=${s2.card_count}` : "❌ 없음"}`);

  // ── 3) version_mismatch → 수동 ops 전용 ──
  console.log("\n[3] version_mismatch 시뮬레이션: dto_version → (현재-1)");
  const curV = s2.dto_version;
  await sb.from(TABLE).update({ dto_version: curV - 1 }).eq("user_id", uid);
  const r3 = await httpGet();
  const s3 = await snapState();
  const untouched = s3.dto_version === curV - 1; // 조회로는 재계산되면 안 됨
  console.log(`  HTTP ${r3.status} cards=${r3.cards} (${r3.ms}ms) — 구 카드 graceful 노출`);
  console.log(`  DB dto_version=${s3.dto_version} → 조회 경로 재계산 안 함 ${untouched ? "✅" : "❌"}`);
  console.log("  수동 ops 호출로 수렴 확인:");
  const ops = await fetch(`${BASE}/api/admin/cluster4/recompute-snapshots?maxUsers=5`, {
    headers: { "x-internal-api-key": KEY },
  });
  console.log(`  ops → ${ops.status} ${JSON.stringify((await ops.json()).data)}`);
  const s4 = await snapState();
  console.log(`  DB dto_version=${s4.dto_version} → 수동 수렴 ${s4.dto_version === curV ? "✅" : "❌"}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

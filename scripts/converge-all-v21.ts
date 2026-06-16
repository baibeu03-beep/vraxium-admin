// converge-all-v21.ts
// 전 사용자 cluster4_weekly_card_snapshots → v21 수렴 (write) + 정합 검증.
//   실행(dev server 필요 — HTTP 검증용): npx tsx --env-file=.env.local scripts/converge-all-v21.ts
//
// 쓰기: recomputeStaleOrDueSnapshots (ops 엔드포인트와 동일 함수). dueOlderThanMs 를 크게 주어
//   "is_stale ∪ dto_version≠21" 만 대상(이미 fresh v21 92건 재churn 방지). 실패는 사용자별 격리
//   (기존 snapshot 보존). 반복 호출로 후보 0 까지.
// 검증(필수 확인 1·2·3): 직전 non-v21 사용자 표본을 direct(실시간) vs HTTP(snapshot) canonical 비교
//   → 전송 중 transient 실패로 degraded 저장된 행을 잡아낸다(잡히면 그 사용자 재계산).
import { config } from "dotenv";
config({ path: ".env.local" });
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import {
  WEEKLY_CARDS_DTO_VERSION,
  recomputeStaleOrDueSnapshots,
  recomputeAndStoreWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const INTERNAL_KEY = process.env.INTERNAL_API_KEY ?? "";
const TABLE = "cluster4_weekly_card_snapshots";
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
const canonEqual = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

async function distribution(label: string) {
  const { data, error } = await sb
    .from(TABLE)
    .select("user_id,dto_version,is_stale,card_count")
    .order("user_id", { ascending: true })
    .range(0, 4999);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as { user_id: string; dto_version: number; is_stale: boolean; card_count: number }[];
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const testSet = new Set((markers ?? []).map((m: { user_id: string }) => m.user_id));

  const byVer = new Map<number, { test: number; real: number }>();
  for (const r of rows) {
    const b = byVer.get(r.dto_version) ?? { test: 0, real: 0 };
    if (testSet.has(r.user_id)) b.test++; else b.real++;
    byVer.set(r.dto_version, b);
  }
  const total = rows.length;
  const v21 = rows.filter((r) => r.dto_version === LATEST);
  const nonV21 = rows.filter((r) => r.dto_version !== LATEST);
  const stale = rows.filter((r) => r.is_stale).length;
  const emptyCards = rows.filter((r) => r.card_count === 0).length;
  const v21Test = v21.filter((r) => testSet.has(r.user_id)).length;
  const v21Real = v21.length - v21Test;

  console.log(`\n──────── 분포 (${label}) ────────`);
  console.log(`전체 snapshot 수 : ${total}`);
  for (const v of Array.from(byVer.keys()).sort((a, b) => b - a)) {
    const b = byVer.get(v)!;
    console.log(`  v${v}: ${b.test + b.real}  (test ${b.test} / real ${b.real})${v === LATEST ? "  ← LATEST" : ""}`);
  }
  console.log(`v21 수           : ${v21.length}  (test ${v21Test} / real ${v21Real})`);
  console.log(`v20 이하 수      : ${nonV21.length}`);
  console.log(`is_stale 수      : ${stale}`);
  console.log(`card_count==0    : ${emptyCards} (miss-like)`);
  return { total, v21: v21.length, nonV21: nonV21.length, stale, emptyCards, v21Test, v21Real };
}

async function httpRead(userId: string): Promise<{ status: number; data: unknown[] }> {
  const res = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${userId}`, {
    headers: { "x-internal-api-key": INTERNAL_KEY },
  });
  const body = (await res.json().catch(() => ({}))) as { data?: unknown[] };
  return { status: res.status, data: Array.isArray(body.data) ? body.data : [] };
}

async function main() {
  console.log("════════════ 전 사용자 v21 수렴 ════════════");
  console.log(`LATEST=${LATEST} | BASE=${BASE}`);
  if (!INTERNAL_KEY) throw new Error("INTERNAL_API_KEY 미설정");

  const before = await distribution("수렴 전");

  // ── 쓰기: 후보 0 까지 반복 ──
  const HUGE_DUE_MS = 100000 * 60 * 1000; // ~69일 — due 분기 무력화(=stale∪mismatch 만 대상)
  let totalRecomputed = 0;
  const allFailed = new Set<string>();
  for (let iter = 1; iter <= 8; iter++) {
    const r = await recomputeStaleOrDueSnapshots({ maxUsers: 1000, dueOlderThanMs: HUGE_DUE_MS, concurrency: 3 });
    totalRecomputed += r.recomputed;
    r.failedUserIds.forEach((id) => allFailed.add(id));
    console.log(`[write iter ${iter}] scanned=${r.scanned} recomputed=${r.recomputed} failed=${r.failed} ${Math.round(r.durationMs / 1000)}s`);
    if (r.scanned === 0 || r.recomputed === 0) break;
  }
  console.log(`\n쓰기 합계: recomputed=${totalRecomputed} | 실패(격리)=${allFailed.size}${allFailed.size ? " → " + [...allFailed].slice(0, 20).join(",") : ""}`);

  const after = await distribution("수렴 후");

  // ── 검증(필수 확인 1·2·3): 직전 non-v21 표본 direct vs HTTP ──
  let sampleIds: string[] = [];
  try {
    sampleIds = JSON.parse(readFileSync("scripts/_tmp-nonv21-ids.json", "utf8")) as string[];
  } catch { /* 없으면 검증 표본 건너뜀 */ }
  const N = Math.min(18, sampleIds.length);
  const step = sampleIds.length > 0 ? Math.max(1, Math.floor(sampleIds.length / Math.max(1, N))) : 1;
  const chosen: string[] = [];
  for (let i = 0; i < sampleIds.length && chosen.length < N; i += step) chosen.push(sampleIds[i]);

  console.log(`\n──────── direct == HTTP 검증 (직전 non-v21 표본 ${chosen.length}명) ────────`);
  let okCount = 0;
  const mismatches: string[] = [];
  for (const uid of chosen) {
    try {
      const direct = await getCluster4WeeklyCardsForProfileUser(uid);
      const http = await httpRead(uid);
      const eq = canonEqual(direct, http.data);
      if (eq) okCount++; else mismatches.push(`${uid} (direct=${direct.length} http=${http.data.length} status=${http.status})`);
      console.log(`  ${uid} | direct=${direct.length} http=${http.data.length} | ${eq ? "일치 ✅" : "불일치 ❌"}`);
    } catch (e) {
      mismatches.push(`${uid} (compute throw: ${e instanceof Error ? e.message : e})`);
      console.log(`  ${uid} | direct compute throw: ${e instanceof Error ? e.message : e}`);
    }
  }

  // ── 완료 기준 판정 ──
  const done =
    after.nonV21 === 0 && after.stale === 0 && mismatches.length === 0;
  console.log("\n════════════════════ 최종 보고 ════════════════════");
  console.log(`전체 snapshot 수      : ${before.total} → ${after.total}`);
  console.log(`v21 수                : ${before.v21} → ${after.v21}`);
  console.log(`v20 이하 수           : ${before.nonV21} → ${after.nonV21}`);
  console.log(`실사용자 v21 수       : ${before.v21Real} → ${after.v21Real}`);
  console.log(`테스트 사용자 v21 수  : ${before.v21Test} → ${after.v21Test}`);
  console.log(`is_stale 수           : ${before.stale} → ${after.stale}`);
  console.log(`card_count==0(miss)   : ${before.emptyCards} → ${after.emptyCards}`);
  console.log(`direct==HTTP 표본      : ${okCount}/${chosen.length} 일치${mismatches.length ? " | 불일치: " + mismatches.join(" ; ") : ""}`);
  console.log(`\n완료 기준 (non-v21=0 ∧ is_stale=0 ∧ 표본 정합): ${done ? "충족 ✅" : "미충족 ❌"}`);
  if (after.emptyCards > 0) {
    console.log(`⚠ card_count==0 ${after.emptyCards}건 — 프로필 부재/계산 불가 사용자 가능. 개별 확인 필요.`);
  }
}

main().catch((e) => { console.error("fatal", e); process.exit(1); });

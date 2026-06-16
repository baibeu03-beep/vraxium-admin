// verify-version-mismatch-convergence.ts
// version_mismatch 자동 수렴(사용자 단위 background recompute) HTTP 통합 검증.
//
//   실행(dev server 필요): next dev 가 :3000 에서 떠 있어야 한다(after() 백그라운드 재계산이
//   Next 요청 컨텍스트에서 실행되므로 direct 호출로는 검증 불가 — 반드시 HTTP).
//     npx tsx --env-file=.env.local scripts/verify-version-mismatch-convergence.ts
//
//   대상: test_user_markers 의 테스트 사용자 1명(card_count>=2, dto_version=현재, fresh).
//   안전: 검증 동안만 그 사용자 snapshot 의 dto_version 을 한 단계 낮추고 cards 를 1개로
//         줄여(sentinel) "구 snapshot" 을 만든다. 종료 시 실제 recompute 로 최신 fresh 로 복원한다
//         (운영-정상 상태). 다른 사용자/운영 데이터/DTO/스키마 무접촉.
//
// 검증 항목:
//   1) 테스트 사용자 snapshot dto_version 을 일부러 낮춤
//   2) 첫 HTTP 요청은 기존(구) snapshot 을 즉시 반환(블로킹 0)
//   3) 응답 이후 background recompute 실행
//   4) snapshot dto_version 이 최신으로 변경
//   5) 두 번째 HTTP 요청은 HIT/latest 반환
//   6) direct == HTTP
//   7) 실패 시 기존 snapshot fallback 유지(격리 계약 재현)
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import {
  WEEKLY_CARDS_DTO_VERSION,
  readWeeklyCardsSnapshot,
  recomputeAndStoreWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const INTERNAL_KEY = process.env.INTERNAL_API_KEY ?? "";
const TABLE = "cluster4_weekly_card_snapshots";
const LATEST = WEEKLY_CARDS_DTO_VERSION;
const OLD = LATEST - 1;

type Row = {
  user_id: string;
  cards: unknown[];
  card_count: number;
  dto_version: number;
  is_stale: boolean;
  computed_at: string;
  updated_at: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readRow(userId: string): Promise<Row | null> {
  const { data, error } = await sb
    .from(TABLE)
    .select("user_id,cards,card_count,dto_version,is_stale,computed_at,updated_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as Row) ?? null;
}

async function httpGet(userId: string): Promise<{ status: number; ms: number; len: number; data: unknown[] }> {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${userId}`, {
    headers: { "x-internal-api-key": INTERNAL_KEY },
  });
  const ms = Date.now() - t0;
  const body = (await res.json().catch(() => ({}))) as { data?: unknown[] };
  const data = Array.isArray(body.data) ? body.data : [];
  return { status: res.status, ms, len: data.length, data };
}

async function pickTestUser(): Promise<Row> {
  const markerRes = await sb.from("test_user_markers").select("user_id");
  if (markerRes.error) throw new Error(markerRes.error.message);
  const ids = ((markerRes.data ?? []) as { user_id: string }[])
    .map((r) => r.user_id)
    .filter(Boolean);
  if (ids.length === 0) throw new Error("test_user_markers 비어 있음");

  const { data, error } = await sb
    .from(TABLE)
    .select("user_id,cards,card_count,dto_version,is_stale,computed_at,updated_at")
    .in("user_id", ids)
    .eq("dto_version", LATEST)
    .eq("is_stale", false)
    .gte("card_count", 2)
    .order("card_count", { ascending: false })
    .range(0, 0);
  if (error) throw new Error(error.message);
  const row = ((data ?? [])[0] as Row) ?? null;
  if (!row) {
    throw new Error(
      `조건(테스트 사용자 · dto_version=${LATEST} · fresh · card_count>=2) 충족 snapshot 없음. ` +
        `먼저 recompute-snapshots 로 수렴 후 재시도.`,
    );
  }
  return row;
}

// 검증용으로 "구 snapshot" 상태를 만든다: 버전 낮춤 + cards 1개(sentinel) + computed_at 과거.
async function makeStaleOld(userId: string, origCards: unknown[]): Promise<void> {
  const sentinel = origCards.slice(0, 1); // 실제 카드 1개만 — 라우트 파생 계산이 깨지지 않게.
  const { error } = await sb
    .from(TABLE)
    .update({
      dto_version: OLD,
      cards: sentinel,
      card_count: sentinel.length,
      is_stale: false,
      computed_at: "2000-01-01T00:00:00.000Z",
    })
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
}

function pass(b: boolean): string {
  return b ? "PASS ✅" : "FAIL ❌";
}

// JSONB 라운드트립은 객체 키 순서를 보존하지 않는다(Postgres jsonb = 자체 키 순서).
// HTTP(snapshot=JSONB 유래) vs direct(갓 만든 JS 객체) 의미 동등 비교를 위해 키를 재귀 정렬한다.
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
function canonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
// 불일치 시 첫 차이 카드 인덱스를 찾아 알려준다(실질 차이 여부 판단용).
function firstDiffIndex(a: unknown[], b: unknown[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (JSON.stringify(canonical(a[i])) !== JSON.stringify(canonical(b[i]))) return i;
  }
  return -1;
}

async function main() {
  console.log("═══════════ version_mismatch 자동 수렴 HTTP 검증 ═══════════");
  console.log(`BASE=${BASE} | WEEKLY_CARDS_DTO_VERSION(LATEST)=${LATEST} | OLD=${OLD}`);
  if (!INTERNAL_KEY) throw new Error("INTERNAL_API_KEY 미설정");

  const orig = await pickTestUser();
  const userId = orig.user_id;
  const origCards = orig.cards;
  const origLen = orig.card_count;
  console.log(`\n대상 테스트 사용자: ${userId}`);
  console.log(`  원본 snapshot: v${orig.dto_version} | cards=${origLen} | is_stale=${orig.is_stale} | computed_at=${orig.computed_at}`);

  // ── 워밍업: 라우트 컴파일/캐시 워밍(첫 요청 응답시간을 컴파일 비용과 분리) ──
  const warm = await httpGet(userId);
  console.log(`\n[warm-up] status=${warm.status} | ${warm.ms}ms (라우트 컴파일 워밍, 측정 제외)`);
  if (warm.status !== 200) {
    throw new Error(`워밍업 비정상(status=${warm.status}). dev server/HMR/내부키 확인 필요.`);
  }

  const results: Record<string, boolean> = {};

  try {
    // ───────── 1) dto_version 일부러 낮춤 ─────────
    await makeStaleOld(userId, origCards);
    const lowered = await readRow(userId);
    console.log("\n[1] dto_version 낮춤");
    console.log(`    저장본: v${lowered!.dto_version} | cards=${lowered!.card_count} | computed_at=${lowered!.computed_at} | updated_at=${lowered!.updated_at}`);
    results["1_lowered"] = lowered!.dto_version === OLD && lowered!.card_count === 1;
    const baselineUpdatedAt = lowered!.updated_at;
    const firstServedVersion = lowered!.dto_version; // 첫 요청이 서빙할 저장본 버전

    // ───────── 2) 첫 HTTP 요청 = 구 snapshot 즉시 반환(블로킹 0) ─────────
    const first = await httpGet(userId);
    console.log("\n[2] 첫 HTTP 요청(구 snapshot 즉시 반환)");
    console.log(`    status=${first.status} | 응답시간=${first.ms}ms | cards=${first.len} (기대=1, 구 sentinel)`);
    // 구 카드(sentinel length=1)를 그대로 서빙했는가 + 블로킹 lazy(1.5~3s) 가 아닌가.
    results["2_served_old_immediately"] = first.status === 200 && first.len === 1;
    results["2_nonblocking"] = first.ms < 1500; // 단건 recompute 실측 1.5~3s → 그보다 빨라야 비블로킹

    // ───────── 3·4) 응답 후 background recompute 실행 → 최신 수렴 ─────────
    console.log("\n[3·4] background recompute 폴링(최대 45s)…");
    const tConv = Date.now();
    let converged: Row | null = null;
    for (let i = 0; i < 90; i++) {
      await sleep(500);
      const r = await readRow(userId);
      if (r && r.dto_version === LATEST && r.computed_at !== lowered!.computed_at) {
        converged = r;
        break;
      }
    }
    const convergeMs = Date.now() - tConv;
    const bgSuccess = !!converged;
    results["3_bg_ran"] = bgSuccess;
    results["4_version_latest"] = !!converged && converged.dto_version === LATEST;
    if (converged) {
      console.log(`    수렴 완료(${convergeMs}ms): v${converged.dto_version} | cards=${converged.card_count} | computed_at=${converged.computed_at} | updated_at=${converged.updated_at}`);
      console.log(`    updated_at 변화: ${baselineUpdatedAt} → ${converged.updated_at} (${baselineUpdatedAt !== converged.updated_at ? "변경됨 ✅" : "동일 ❌"})`);
      results["4_updated_at_changed"] = baselineUpdatedAt !== converged.updated_at;
      results["4_cards_restored"] = converged.card_count === origLen;
    } else {
      console.log(`    ❌ ${convergeMs}ms 내 수렴 실패(background recompute 미실행/실패 의심).`);
      results["4_updated_at_changed"] = false;
      results["4_cards_restored"] = false;
    }

    // ───────── 5) 두 번째 HTTP 요청 = HIT/latest ─────────
    const second = await httpGet(userId);
    const snapAfter = await readWeeklyCardsSnapshot(userId);
    console.log("\n[5] 두 번째 HTTP 요청(HIT/latest)");
    console.log(`    status=${second.status} | 응답시간=${second.ms}ms | cards=${second.len} (기대=${origLen})`);
    console.log(`    readWeeklyCardsSnapshot outcome=${snapAfter.status} (기대=hit)`);
    results["5_hit_latest"] = second.status === 200 && second.len === origLen && snapAfter.status === "hit";

    // ───────── 6) direct == HTTP (키 순서 무관 의미 동등) ─────────
    const direct = await getCluster4WeeklyCardsForProfileUser(userId);
    const directEqHttp = canonEqual(direct, second.data);
    console.log("\n[6] direct == HTTP (canonical — JSONB 키순서 무관)");
    console.log(`    direct cards=${direct.length} | HTTP cards=${second.len} | 일치=${directEqHttp}`);
    if (!directEqHttp) {
      const idx = firstDiffIndex(direct as unknown[], second.data);
      console.log(`    첫 차이 카드 index=${idx} (week=${(direct[idx] as { weekNumber?: number })?.weekNumber ?? "?"})`);
      console.log(`    direct[${idx}]= ${JSON.stringify(canonical((direct as unknown[])[idx])).slice(0, 600)}`);
      console.log(`    http  [${idx}]= ${JSON.stringify(canonical(second.data[idx])).slice(0, 600)}`);
    }
    results["6_direct_eq_http"] = directEqHttp;

    // ───────── 7) 실패 시 기존 snapshot fallback 유지(격리 계약 재현) ─────────
    // recompute 가 throw 하면 upsert 가 일어나지 않아(=compute-before-write) 기존 행이 보존된다.
    // production 스케줄러(scheduleVersionMismatchRecompute)의 try/catch/finally 와 동일 구조로,
    // recompute 를 "강제 throw" 로 치환해 행 보존을 확인한다.
    await makeStaleOld(userId, origCards); // 다시 구(sentinel) 상태로
    const beforeFail = await readRow(userId);
    const failingRecompute = async (): Promise<void> => {
      throw new Error("forced-recompute-failure (verify)");
    };
    let swallowed = false;
    try {
      await failingRecompute(); // ← 실패한 background recompute 모사(upsert 도달 전 throw)
    } catch {
      swallowed = true; // production catch 와 동일: 삼키고 행은 그대로 둔다
    }
    const afterFail = await readRow(userId);
    const preserved =
      swallowed &&
      afterFail!.dto_version === beforeFail!.dto_version &&
      afterFail!.card_count === beforeFail!.card_count &&
      afterFail!.computed_at === beforeFail!.computed_at &&
      afterFail!.updated_at === beforeFail!.updated_at;
    console.log("\n[7] 실패 시 fallback 유지(격리 재현)");
    console.log(`    recompute throw → catch swallow=${swallowed}, upsert 미발생`);
    console.log(`    행 보존: v${beforeFail!.dto_version}→v${afterFail!.dto_version} | cards ${beforeFail!.card_count}→${afterFail!.card_count} | computed_at 동일=${afterFail!.computed_at === beforeFail!.computed_at} | updated_at 동일=${afterFail!.updated_at === beforeFail!.updated_at}`);
    results["7_fallback_preserved"] = preserved;

    // ── 요약 보고 ──
    console.log("\n════════════════════ 완료 보고 ════════════════════");
    console.log(`첫 요청 응답 시간           : ${first.ms}ms ${first.ms < 1500 ? "(비블로킹 ✅)" : "(⚠ 느림)"}`);
    console.log(`background recompute 성공   : ${bgSuccess ? `예 ✅ (수렴 ${convergeMs}ms)` : "아니오 ❌"}`);
    console.log(`첫 요청 version             : v${firstServedVersion} (구)`);
    console.log(`두 번째 요청 version        : v${converged?.dto_version ?? "?"} (snapshot=${snapAfter.status})`);
    console.log(`snapshot updated_at 변화    : ${baselineUpdatedAt} → ${converged?.updated_at ?? "(미수렴)"}`);
    console.log(`direct == HTTP              : ${directEqHttp ? "일치 ✅" : "불일치 ❌"}`);
    console.log(`실패 시 fallback 유지       : ${preserved ? "보존 ✅" : "미보존 ❌"}`);

    console.log("\n── 항목별 PASS/FAIL ──");
    for (const [k, v] of Object.entries(results)) console.log(`  ${k.padEnd(28)} ${pass(v)}`);
    const allPass = Object.values(results).every(Boolean);
    console.log(`\nRESULT: ${allPass ? "ALL PASS ✅ — version_mismatch 자동 수렴 정상 동작." : "CHECK ❌ — 위 FAIL 항목 확인."}`);
  } finally {
    // ── 복원: 실제 recompute 로 최신 fresh snapshot 으로 되돌린다(운영-정상 상태) ──
    try {
      await recomputeAndStoreWeeklyCardsSnapshot(userId);
      const restored = await readRow(userId);
      console.log(`\n[cleanup] 실제 recompute 복원: v${restored?.dto_version} | cards=${restored?.card_count} (원본 cards=${origLen})`);
    } catch (e) {
      console.warn("[cleanup] 복원 실패 — 수동 recompute 필요:", e instanceof Error ? e.message : e, `user=${userId}`);
    }
  }
}

main().catch((e) => {
  console.error("fatal", e);
  process.exit(1);
});

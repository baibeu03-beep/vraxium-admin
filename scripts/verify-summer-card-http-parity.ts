/**
 * 2026-summer 시즌 카드 — direct == HTTP(internal) == HTTP(demo) 파이프라인 파리티 검증.
 *
 * 진단 전제: 오늘(2026-06-28 UTC)은 여름 시즌 시작(2026-06-29) 전이라, 실시계로는 snapshot 에
 *   여름 카드가 없다. 그래서 "테스트 계정 1명"의 snapshot 을 시계 시뮬레이션(2026-06-29)으로
 *   recompute 해 구워 두고(bake), 실행 중인 dev server(실시계)가 그 snapshot 을 그대로
 *   서빙하는지(여름 W1 카드 동일) 비교한다. 검증 후 실시계로 다시 recompute 해 원복한다.
 *
 *   ⚠ 대상은 test_user_markers 테스트 계정만(운영 계정 불가). user_week_statuses 에는 절대
 *     쓰지 않는다(snapshot 캐시만 굽고 원복).
 *
 *   사전조건: dev server 가 localhost:3000(또는 BASE_URL) 에서 실행 중.
 *   npx tsx --env-file=.env.local scripts/verify-summer-card-http-parity.ts <testUserId>
 */
const FIXED = Date.UTC(2026, 5, 29, 0, 0, 1); // 2026-06-29T00:00:01Z = 2026-06-29 09:00 KST
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...a: any[]) { if (a.length === 0) { super(FIXED); } else { super(...(a as [])); } }
  static now() { return FIXED; }
}
function withFakeClock<T>(fn: () => Promise<T>): Promise<T> {
  // @ts-expect-error sim
  globalThis.Date = FakeDate;
  return fn().finally(() => { globalThis.Date = RealDate; });
}

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  recomputeAndStoreWeeklyCardsSnapshot,
  readWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const INTERNAL_KEY = process.env.INTERNAL_API_KEY || "";
const USER_ID = (process.argv[2] || "a80ea67a-8836-4c13-8568-66dff79d7a66").trim();

function summerW1(cards: any[] | null | undefined) {
  const w1 = (cards ?? []).find((c) => c.seasonKey === "2026-summer" && c.weekNumber === 1);
  if (!w1) return null;
  return { weekNumber: w1.weekNumber, userWeekStatus: w1.userWeekStatus, statusLabel: w1.statusLabel, points: w1.points, seasonKey: w1.seasonKey };
}

async function httpCards(qs: string, headers: Record<string,string>) {
  const res = await fetch(`${BASE_URL}/api/cluster4/weekly-cards?${qs}`, { headers });
  const ct = res.headers.get("content-type") || "";
  if (!res.ok || !ct.includes("application/json")) return { status: res.status, cards: null as any[]|null, raw: await res.text() };
  const json = await res.json();
  return { status: res.status, cards: Array.isArray(json.data) ? json.data : null, raw: null };
}

async function main() {
  // 0) 테스트 계정 가드
  const { data: marker } = await supabaseAdmin.from("test_user_markers").select("user_id").eq("user_id", USER_ID).maybeSingle();
  if (!marker) { console.error("거부: 대상이 test_user_markers 가 아님(운영 계정 보호).", USER_ID); process.exit(2); }
  const { data: prof } = await supabaseAdmin.from("user_profiles").select("display_name,growth_status").eq("user_id", USER_ID).maybeSingle();
  console.log(`대상 테스트 계정: ${prof?.display_name} (${USER_ID}) growth=${prof?.growth_status}`);

  try {
    // 1) bake — 시뮬레이션 시계로 snapshot 재계산(여름 카드 포함)
    await withFakeClock(async () => { await recomputeAndStoreWeeklyCardsSnapshot(USER_ID); });
    console.log("[bake] 2026-06-29 시계로 snapshot recompute 완료");

    // 2) direct
    const direct = await readWeeklyCardsSnapshot(USER_ID);
    const directCards = direct.status === "hit" || direct.status === "stale" ? direct.cards : null;
    const dW1 = summerW1(directCards);
    console.log("\n[direct] readWeeklyCardsSnapshot status =", direct.status, "| summerW1 =", JSON.stringify(dW1));

    // 3) HTTP internal (일반 모드 등가 — userId + x-internal-api-key)
    const http = await httpCards(`userId=${USER_ID}`, { "x-internal-api-key": INTERNAL_KEY });
    const hW1 = summerW1(http.cards);
    console.log("[http internal] status", http.status, "| summerW1 =", JSON.stringify(hW1), http.raw ? `| raw=${http.raw.slice(0,120)}` : "");

    // 4) HTTP demo (demoUserId)
    const demo = await httpCards(`demoUserId=${USER_ID}`, {});
    const demoW1 = summerW1(demo.cards);
    console.log("[http demo] status", demo.status, "| summerW1 =", JSON.stringify(demoW1), demo.raw ? `| raw=${demo.raw.slice(0,120)}` : "");

    // 5) 비교
    const eq = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
    const directHasW1 = !!dW1 && dW1.userWeekStatus === "running";
    const directEqHttp = eq(dW1, hW1);
    const demoEqNormal = demo.status === 200 ? eq(hW1, demoW1) : "SKIPPED(demo gate)";
    console.log("\n=== 판정 ===");
    console.log("  direct 여름 W1 running:", directHasW1);
    console.log("  direct == HTTP(internal):", directEqHttp);
    console.log("  HTTP(demo) == HTTP(normal):", demoEqNormal);
    const pass = directHasW1 && directEqHttp && (demoEqNormal === true || demoEqNormal === "SKIPPED(demo gate)");
    console.log("  OVERALL:", pass ? "PASS" : "FAIL");
    process.exitCode = pass ? 0 : 1;
  } finally {
    // 6) 원복 — 실시계로 다시 recompute (테스트 계정 snapshot 을 정상 상태로)
    await recomputeAndStoreWeeklyCardsSnapshot(USER_ID);
    console.log("\n[restore] 실시계로 snapshot recompute 완료(원복)");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

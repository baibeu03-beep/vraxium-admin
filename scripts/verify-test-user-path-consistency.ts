// 진입경로 일관성 검증 — 테스트 유저 동일 userId 가 mode 유무와 무관하게 동일 snapshot DTO 반환.
//   direct(readWeeklyCardsSnapshot) == HTTP(mode=test) == HTTP(no mode) == HTTP(demoUserId).
// 사용법: SMOKE_BASE_URL=http://localhost:3000 npx tsx --env-file=.env.local scripts/verify-test-user-path-consistency.ts [userId]
import { createClient } from "@supabase/supabase-js";
import { readWeeklyCardsSnapshot } from "../lib/cluster4WeeklyCardsSnapshot";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const KEY = process.env.INTERNAL_API_KEY!;

type Card = { weekId?: string; startDate?: string; weekNumber?: number; userWeekStatus?: string; growthNumerator?: number; growthDenominator?: number; lines?: any[] };
function sig(cards: Card[]): string[] {
  return (cards ?? []).map((c) =>
    `${c.startDate ?? c.weekId}|W${c.weekNumber}|${c.userWeekStatus}|${c.growthNumerator}/${c.growthDenominator}|lines=${(c.lines ?? []).length}`,
  );
}
async function http(qs: string): Promise<{ status: number; cards: Card[] }> {
  const r = await fetch(`${BASE}/api/cluster4/weekly-cards?${qs}`, { headers: { "x-internal-api-key": KEY } });
  const j: any = await r.json();
  return { status: r.status, cards: Array.isArray(j?.data) ? j.data : [] };
}

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function main() {
  let userId = process.argv[2];
  if (!userId) {
    const { data: snaps } = await supabase.from("cluster4_weekly_card_snapshots").select("user_id").limit(500);
    const ids = Array.from(new Set((snaps ?? []).map((s: any) => s.user_id)));
    for (const uid of ids) {
      const { data: m } = await supabase.from("test_user_markers").select("user_id").eq("user_id", uid).maybeSingle();
      if (m) { userId = uid; break; }
    }
  }
  const { data: prof } = await supabase.from("user_profiles").select("display_name,organization_slug").eq("user_id", userId).maybeSingle();
  console.log(`테스트 유저: ${prof?.display_name} (${userId}) org=${prof?.organization_slug}`);

  // direct snapshot-only (HTTP 가 서빙하는 원본).
  const snapRow: any = await readWeeklyCardsSnapshot(userId);
  const directSig = sig((snapRow?.cards ?? []) as Card[]);

  // HTTP — internal key: mode=test / mode 없음 (세션 경로와 동일 코드 경로).
  const hTest = await http(`userId=${userId}&mode=test`);
  const hPlain = await http(`userId=${userId}`);

  const sigTest = sig(hTest.cards), sigPlain = sig(hPlain.cards);
  console.log(`\n  direct snapshot 카드=${directSig.length} status=${snapRow?.status}`);
  console.log(`  HTTP mode=test 카드=${sigTest.length} (status ${hTest.status})`);
  console.log(`  HTTP no-mode  카드=${sigPlain.length} (status ${hPlain.status})`);

  // 데모 경로(/admin/test-users 가 실제로 쓰는 demoUserId) — 동일 loadWeeklyCards 사용.
  //   (internal-key 없이 demoUserId 인증으로 통과 — ENABLE_DEMO_MODE 게이트는 진입만 가르고 DTO 동일)
  const dTest = await fetch(`${BASE}/api/cluster4/weekly-cards?demoUserId=${userId}&mode=test`).then((r) => r.json()).catch(() => ({}));
  const dPlain = await fetch(`${BASE}/api/cluster4/weekly-cards?demoUserId=${userId}`).then((r) => r.json()).catch(() => ({}));
  const sigDemoTest = sig((dTest as any)?.data ?? []);
  const sigDemoPlain = sig((dPlain as any)?.data ?? []);
  console.log(`  HTTP demoUserId+mode=test 카드=${sigDemoTest.length}`);
  console.log(`  HTTP demoUserId(no mode)  카드=${sigDemoPlain.length}`);

  check("HTTP(mode=test) == HTTP(no mode) — mode 가 DTO 를 바꾸지 않음", JSON.stringify(sigTest) === JSON.stringify(sigPlain),
    `test=${sigTest.length} plain=${sigPlain.length}`);
  check("HTTP(mode=test) == direct snapshot — snapshot-only DTO", JSON.stringify(sigTest) === JSON.stringify(directSig));
  check("HTTP(no mode) == direct snapshot — snapshot-only DTO", JSON.stringify(sigPlain) === JSON.stringify(directSig));
  check("demoUserId(/admin/test-users 경로) == direct snapshot", JSON.stringify(sigDemoTest) === JSON.stringify(directSig),
    `demoTest=${sigDemoTest.length}`);
  check("demoUserId+mode=test == demoUserId(no mode) == userId 경로", JSON.stringify(sigDemoTest) === JSON.stringify(sigDemoPlain) && JSON.stringify(sigDemoTest) === JSON.stringify(sigTest));

  // 진입경로 시뮬: /admin/test-users(demoUserId+mode=test) 는 demo 경로지만 동일 loadWeeklyCards 사용.
  //   demoUserId HTTP 는 로컬 ENABLE_DEMO_MODE 게이트로 비어있을 수 있어 internal 경로로 동치 검증함.
  if (JSON.stringify(sigTest) !== JSON.stringify(sigPlain)) {
    console.log("\n  [잔존 차이 샘플]");
    const n = Math.max(sigTest.length, sigPlain.length);
    for (let i = 0, s = 0; i < n && s < 5; i++) if (sigTest[i] !== sigPlain[i]) { console.log(`   test : ${sigTest[i] ?? "∅"}`); console.log(`   plain: ${sigPlain[i] ?? "∅"}`); s++; }
  }

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().then(() => {}, (e) => { console.error(e); process.exit(1); });

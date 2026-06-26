// 브라우저 스모크 — 수렴된 snapshot 이 실제 브라우저 네트워크 스택에서 정상 서빙되는지 확인.
//   제약: 스냅샷 사용자는 전원 PMS 이관/로그인 불가 프로필(auth 이메일 없음) → 고객앱 로그인
//   DOM 렌더 검증 불가. 대신 (1) 고객앱(:3001)이 브라우저에서 로드되는지, (2) 고객앱이 소비하는
//   admin snapshot API(/api/cluster4/weekly-cards)를 admin 동일출처 브라우저 컨텍스트에서 fetch 해
//   운영·테스트 대표 사용자의 카드가 200/배열로 내려오는지 확인한다.
//   전제: admin dev(:3000) + 고객앱 dev(:3001) + ../vraxium playwright.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const adminRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const r = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = r("@supabase/supabase-js");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const ADMIN = "http://localhost:3000", FRONT = "http://localhost:3001";
const sb = createClient(get("NEXT_PUBLIC_SUPABASE_URL"), get("SUPABASE_SERVICE_ROLE_KEY"));
const KEY = get("INTERNAL_API_KEY");

let pass = 0, fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

// 운영·테스트 대표(card_count>0) 선정 + 저장 snapshot 카드 수
const { data: mk } = await sb.from("test_user_markers").select("user_id");
const tset = new Set((mk ?? []).map((m) => m.user_id));
const allSnaps = [];
for (let f = 0; ; f += 1000) {
  const { data } = await sb.from("cluster4_weekly_card_snapshots")
    .select("user_id,card_count,dto_version").gte("card_count", 4).order("card_count", { ascending: false }).range(f, f + 999);
  const b = data ?? []; allSnaps.push(...b); if (b.length < 1000) break;
}
const real = allSnaps.find((s) => !tset.has(s.user_id));
const test = allSnaps.find((s) => tset.has(s.user_id));
console.log(`운영 대표 ${real?.user_id} (v${real?.dto_version} cards=${real?.card_count}) | 테스트 대표 ${test?.user_id} (v${test?.dto_version} cards=${test?.card_count})`);

const browser = await chromium.launch();
try {
  const page = await browser.newPage();

  // (1) 고객앱 로드 확인
  const fr = await page.goto(FRONT, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((e) => ({ err: e }));
  ck("고객앱(:3001) 로드", fr && !fr.err && (fr.status() ?? 0) < 500, `status=${fr?.status?.() ?? fr?.err?.message}`);

  // (2) admin 동일출처 컨텍스트에서 snapshot API fetch (CORS 회피)
  await page.goto(ADMIN, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  const fetchCards = async (userId) =>
    page.evaluate(async ({ userId, KEY }) => {
      const res = await fetch(`/api/cluster4/weekly-cards?userId=${userId}`, { headers: { "x-internal-api-key": KEY } });
      let len = -1;
      try { const b = await res.json(); len = Array.isArray(b?.data) ? b.data.length : -1; } catch { /* */ }
      return { status: res.status, len };
    }, { userId, KEY });

  for (const [tag, rep] of [["운영", real], ["테스트", test]]) {
    if (!rep) { ck(`${tag} 대표 존재`, false); continue; }
    const got = await fetchCards(rep.user_id);
    ck(`${tag} snapshot API (브라우저 fetch)`, got.status === 200 && got.len === rep.card_count,
      `status=${got.status} cards=${got.len} (기대 ${rep.card_count})`);
  }

  console.log(`\n결과: PASS ${pass} / FAIL ${fail} → ${fail === 0 ? "브라우저 스모크 통과 ✅" : "확인 필요 ❌"}`);
  process.exit(fail === 0 ? 0 : 2);
} finally {
  await browser.close();
}

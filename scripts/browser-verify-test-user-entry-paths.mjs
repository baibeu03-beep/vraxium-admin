// 브라우저 — 두 진입경로가 고객 카드에서 동일 DTO 를 받는지.
//   path A(/admin/test-users 경유): 고객카드 ?demoUserId=<test>&mode=test → weekly-cards 응답 가로채기
//   비교군: direct snapshot(readWeeklyCardsSnapshot). 둘이 같으면 진입경로 일관 확인.
// 사용법: node scripts/browser-verify-test-user-entry-paths.mjs [userId]
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const requireAdmin = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = requireAdmin("@supabase/supabase-js");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const supabase = createClient(get("NEXT_PUBLIC_SUPABASE_URL"), get("SUPABASE_SERVICE_ROLE_KEY"));
const FRONT = process.env.FRONT_BASE_URL ?? "http://localhost:3001";

const sig = (cs) => (cs || []).map((c) => `${c.startDate || c.weekId}|W${c.weekNumber}|${c.userWeekStatus}|${c.growthNumerator}/${c.growthDenominator}|L${(c.lines || []).length}`);

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function main() {
  let userId = process.argv[2];
  if (!userId) {
    const { data: snaps } = await supabase.from("cluster4_weekly_card_snapshots").select("user_id").limit(500);
    for (const uid of Array.from(new Set((snaps ?? []).map((s) => s.user_id)))) {
      const { data: m } = await supabase.from("test_user_markers").select("user_id").eq("user_id", uid).maybeSingle();
      if (m) { userId = uid; break; }
    }
  }
  const { data: prof } = await supabase.from("user_profiles").select("display_name").eq("user_id", userId).maybeSingle();
  console.log(`테스트 유저: ${prof?.display_name} (${userId})`);

  // direct snapshot sig — 저장 snapshot row 의 cards 직접 조회(브라우저와 독립 비교군).
  const { data: snapRow } = await supabase
    .from("cluster4_weekly_card_snapshots").select("cards").eq("user_id", userId).maybeSingle();
  const directSig = sig((snapRow?.cards ?? []));
  console.log(`  direct snapshot 카드=${directSig.length}`);

  const browser = await chromium.launch({ channel: "chromium", headless: true });
  const page = await browser.newContext().then((c) => c.newPage());
  try {
    // path A: /admin/test-users 가 여는 고객 URL 형태(demoUserId+mode=test). weekly-cards 응답 가로채기.
    const captured = { A: null, B: null };
    page.on("response", async (res) => {
      if (res.url().includes("/api/cluster4/weekly-cards")) {
        try { const j = await res.json(); if (Array.isArray(j?.data)) captured.cur = j.data; } catch {}
      }
    });

    for (const [label, qs] of [["A", `demoUserId=${userId}&mode=test&admin=true`], ["B(직접·mode없음)", `demoUserId=${userId}`]]) {
      captured.cur = null;
      for (const route of ["/cluster-4-card-ec", "/cluster-4-card"]) {
        await page.goto(`${FRONT}${route}?${qs}`, { waitUntil: "networkidle" }).catch(() => {});
        await page.waitForTimeout(1500);
        if (captured.cur) break;
      }
      const s = sig(captured.cur || []);
      console.log(`  [path ${label}] 브라우저 수신 weekly-cards 카드=${s.length}`);
      check(`path ${label}: 브라우저 수신 DTO == direct snapshot`, JSON.stringify(s) === JSON.stringify(directSig), `got=${s.length}`);
      if (label === "A") captured.A = s; else captured.B = s;
    }
    check("path A(mode=test) == path B(mode없음) — 브라우저 수신 DTO 동일", JSON.stringify(captured.A) === JSON.stringify(captured.B));
  } catch (e) {
    console.error("browser error:", e?.stack ?? e?.message ?? e); fail++;
  } finally { await browser.close(); }
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

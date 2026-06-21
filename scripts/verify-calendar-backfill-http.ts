// 캘린더 백필 검증 — 실제 HTTP API + direct + 브라우저 DOM.
//   1) GET /api/admin/cluster4/info-line-results 로 백필 주차 캘린더 status=opened (oranke+통합).
//   2) direct getInfoLineResultsForWeek 와 HTTP 응답 일치(direct==HTTP).
//   3) 브라우저: /admin/line-opening/practical-info?org=oranke 에서 주차 선택 → 캘린더 카드 "개설 완료".
//   4) 컨트롤: W10/W11 은 종전대로 opened(중복/회귀 없음).
// 실행: npx tsx --env-file=.env.local scripts/verify-calendar-backfill-http.ts
import { config } from "dotenv";
config({ path: ".env.local" });
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { getInfoLineResultsForWeek } from "@/lib/adminCluster4InfoLineResults";

const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");

const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE);

const WEEKS: Record<string, string> = {
  "25가을 W1 (백필)": "5513969c-4e98-4222-9a2b-87f05bbc0e86",
  "26봄 W1 (백필)": "d3aa89d8-35f6-42b3-bb12-a1d65b6b0e91",
  "26봄 W5 (백필)": "20a7ebcb-85ea-4a98-83fa-a920d010038a",
  "26봄 W9 (백필)": "b531c234-e860-499a-992c-b74d2c1d5349",
  "26봄 W10 (컨트롤)": "6cc59d70-3aa6-4823-8854-5b82691d1a84",
  "26봄 W11 (컨트롤)": "67e07106-564e-4dab-b180-8f11c909973a",
};
const BROWSER_WEEK = "d3aa89d8-35f6-42b3-bb12-a1d65b6b0e91"; // 26봄 W1

async function makeAdminCookies() {
  const b = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await sb.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await b.auth.verifyOtp({
    email: adminEmail,
    token: (linkData as any).properties.email_otp,
    type: "magiclink",
  });
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (items: any[]) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: (verifyData as any).session.access_token,
    refresh_token: (verifyData as any).session.refresh_token,
  });
  return captured.map((i) => ({
    name: i.name, value: i.value, domain: "localhost", path: "/",
    httpOnly: false, secure: false, sameSite: "Lax" as const,
  }));
}

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

async function main() {
const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext();
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();
await page.goto(`${BASE}/admin/line-opening/practical-info?org=oranke`, { waitUntil: "domcontentloaded" });

async function httpResults(weekId: string, org: string | null) {
  const sp = new URLSearchParams({ week_id: weekId });
  if (org) sp.set("organization", org);
  return page.evaluate(async (url: string) => {
    const r = await fetch(url);
    const j = await r.json();
    return { status: r.status, data: j.data ?? null };
  }, `/api/admin/cluster4/info-line-results?${sp.toString()}`);
}
const calOf = (data: any) => (data?.lines ?? []).find((l: any) => l.activityTypeId === "calendar") ?? null;

try {
  console.log("\n[1] HTTP info-line-results — oranke 스코프 (백필 주차 opened + direct==HTTP)");
  for (const [label, wid] of Object.entries(WEEKS)) {
    const http = await httpResults(wid, "oranke");
    const direct = await getInfoLineResultsForWeek({ weekId: wid, organization: "oranke" });
    const hc = calOf(http.data), dc = calOf(direct);
    check(`${label} HTTP 200`, http.status === 200, `status=${http.status}`);
    check(`${label} 캘린더 opened`, hc?.status === "opened", `status=${hc?.status} title="${hc?.mainTitle ?? "—"}"`);
    const eq = hc?.status === dc?.status && hc?.lineId === dc?.lineId && hc?.mainTitle === dc?.mainTitle;
    check(`${label} direct==HTTP`, eq, `direct(${dc?.status}/${dc?.lineId?.slice(0, 8)}) http(${hc?.status}/${hc?.lineId?.slice(0, 8)})`);
  }

  console.log("\n[2] HTTP 통합 스코프 — 백필 주차 캘린더 opened");
  for (const [label, wid] of Object.entries(WEEKS)) {
    const http = await httpResults(wid, null);
    const hc = calOf(http.data);
    check(`${label} 통합 캘린더 opened`, hc?.status === "opened", `status=${hc?.status}`);
  }

  console.log("\n[3] 브라우저 DOM — 26봄 W1 선택 → 캘린더 카드 '개설 완료'");
  const sel = page.locator('select[aria-label="개설 결과 주차 선택"]');
  await sel.waitFor({ state: "visible", timeout: 20000 });
  await sel.selectOption(BROWSER_WEEK);
  const calCard = page.locator("div.rounded-md.border", { hasText: "캘린더" }).first();
  await calCard.waitFor({ state: "visible", timeout: 20000 });
  const cardText = (await calCard.innerText()).replace(/\s+/g, " ");
  check("DOM 캘린더 카드 '개설 완료'", /개설 완료/.test(cardText), cardText.slice(0, 90));
  check("DOM 캘린더 메인 타이틀", /관심있는 산업\/직무/.test(cardText), cardText.includes("관심있는") ? "title 표시됨" : "title 없음");
  check("DOM 개설 해당자 0명(시리즈 표준)", /개설 해당자\s*0명/.test(cardText), cardText.match(/개설 해당자[^·\n]*/)?.[0] ?? "");
} catch (e) {
  check("스크립트 예외 없음", false, e instanceof Error ? e.message : String(e));
} finally {
  await browser.close();
}

console.log(`\n═══ 결과: ${pass} pass / ${fail} fail ═══`);
process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

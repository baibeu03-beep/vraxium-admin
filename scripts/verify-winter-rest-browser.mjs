// 브라우저 검증 (운영): W5=정상/성장, W8=공식 휴식.
//   1) front  https://vraxium.vercel.app/cluster-4?userId=<tester> — 주차 카드 W5/W8 표시
//   2) admin  https://vraxium-admin.vercel.app/admin/season-weeks — 기준표 W5=운영/W8=공식 휴식
//   Playwright 는 ../vraxium(front repo) 의존성 재사용, channel: chromium.
//     node scripts/verify-winter-rest-browser.mjs <userId>
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const requireFront = createRequire(resolve(frontRoot, "package.json"));
const { chromium } = requireFront("playwright");
const requireAdmin = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = requireAdmin("@supabase/supabase-js");
const { createServerClient } = requireAdmin("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();

const userId = process.argv[2];
if (!userId) throw new Error("usage: node ... <userId>");
const FRONT = "https://vraxium.vercel.app";
const ADMIN = "https://vraxium-admin.vercel.app";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

// ── admin 세션 쿠키 생성 (verify-status-label-sot-http.ts 와 동일 패턴) ──
async function makeAdminCookies() {
  const supabaseUrl = get("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const serviceRoleKey = get("SUPABASE_SERVICE_ROLE_KEY");
  const admin = createClient(supabaseUrl, serviceRoleKey);
  const browser = createClient(supabaseUrl, anonKey);
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: adminEmail,
  });
  if (linkError || !linkData?.properties?.email_otp)
    throw new Error(linkError?.message ?? "generateLink failed");
  const { data: verifyData, error: verifyError } = await browser.auth.verifyOtp({
    email: adminEmail,
    token: linkData.properties.email_otp,
    type: "magiclink",
  });
  if (verifyError || !verifyData.session)
    throw new Error(verifyError?.message ?? "verifyOtp failed");
  const captured = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [],
      setAll: (items) => captured.push(...items),
    },
  });
  const { error: setError } = await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  if (setError) throw new Error(setError.message);
  return captured.map((i) => ({
    name: i.name,
    value: i.value,
    domain: "vraxium-admin.vercel.app",
    path: "/",
    httpOnly: false,
    secure: true,
    sameSite: "Lax",
  }));
}

const browser = await chromium.launch({ channel: "chromium", headless: true });
let failures = 0;

// ── 1) front 고객 화면 ────────────────────────────────────────────────────
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 2000 } });
  await page.goto(`${FRONT}/cluster-4?userId=${userId}`, { waitUntil: "domcontentloaded" });
  // 카드 목록 로드 대기 후, 시즌 필터 드롭다운("역대 시즌")에서 겨울 시즌만 선택.
  await page.waitForFunction(
    "document.body.innerText.includes('역대 시즌')",
    undefined,
    { timeout: 60000 },
  );
  await page.waitForTimeout(2000); // weekly-cards fetch 완료 여유
  // 드롭다운 열기 → '겨울' 옵션 클릭 (옵션 마운트가 늦을 수 있어 폴링)
  let clicked = null;
  for (let i = 0; i < 20 && !clicked; i++) {
    clicked = await page.evaluate(`(() => {
      const opts = [...document.querySelectorAll('div,button,li,span')]
        .filter(e => e.innerText && /겨울 시즌$/.test(e.innerText.trim()) && e.innerText.trim().length < 20 && e.querySelectorAll('*').length < 4);
      if (opts.length) {
        opts[opts.length - 1].click();
        return opts[opts.length - 1].innerText.trim();
      }
      // 옵션이 없으면 드롭다운 오프너 클릭
      const openers = [...document.querySelectorAll('div,button,span')]
        .filter(e => e.innerText && e.innerText.trim().replace(/\\s+/g, ' ') === '역대 시즌 ▼');
      if (openers.length) openers[openers.length - 1].click();
      return null;
    })()`);
    await page.waitForTimeout(800);
  }
  console.log("[front] 시즌 필터 선택:", clicked);
  await page.waitForTimeout(1200);
  let found = false;
  for (let i = 0; i < 30 && !found; i++) {
    await page.evaluate("window.scrollBy(0, 1400)");
    await page.waitForTimeout(400);
    found = await page.evaluate(
      "document.body.innerText.includes('겨울 시즌, 5주차') && document.body.innerText.includes('겨울 시즌, 8주차')",
    );
  }
  if (!found) {
    const dump = await page.evaluate("(() => { const t = document.body.innerText; const i = t.indexOf('겨울'); return i < 0 ? t.slice(-1500) : t.slice(Math.max(0, i - 200), i + 1500); })()");
    console.log("[front][debug] '겨울' 부근/말미 텍스트:\n" + dump);
    await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-front-winter-cards-FAIL.png"), fullPage: true });
    throw new Error("winter W5/W8 카드 라벨을 찾지 못함");
  }
  // 카드 상태 라벨(성장(성공)/휴식(공식))은 카드 제목 직전에 렌더되므로 앞쪽 윈도우 포함.
  const result = await page.evaluate(`(() => {
    const text = document.body.innerText;
    const probe = (label) => {
      const i = text.indexOf(label);
      if (i < 0) return null;
      return text.slice(Math.max(0, i - 50), i + 120).replace(/\\n/g, " | ");
    };
    return {
      w5: probe('겨울 시즌, 5주차'),
      w8: probe('겨울 시즌, 8주차'),
    };
  })()`);
  console.log("[front] W5 부근:", result.w5);
  console.log("[front] W8 부근:", result.w8);
  const w5ok = result.w5 && result.w5.includes("성장") && !result.w5.includes("휴식(공식)");
  const w8ok = result.w8 && (result.w8.includes("휴식(공식)") || result.w8.includes("공식 휴식주"));
  console.log(`[front] W5 정상(성장) 표시: ${w5ok ? "✅" : "❌"}`);
  console.log(`[front] W8 공식 휴식 표시: ${w8ok ? "✅" : "❌"}`);
  if (!w5ok || !w8ok) failures++;
  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-front-winter-cards.png"), fullPage: true });
  await page.close();
}

// ── 2) admin 시즌/주차 기준표 ─────────────────────────────────────────────
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 1800 } });
  await context.addCookies(await makeAdminCookies());
  const page = await context.newPage();
  await page.goto(`${ADMIN}/admin/season-weeks`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    "document.body.innerText.includes('2026-winter')",
    undefined,
    { timeout: 60000 },
  );
  // 2026-winter 시즌 그룹은 접혀 있음 — 해당 카드의 "주차 보기" 버튼 클릭
  const expanded = await page.evaluate(`(() => {
    const cards = [...document.querySelectorAll('div')].filter(
      (d) => d.innerText && d.innerText.includes('2026-winter') && d.querySelector('button'),
    );
    // 가장 안쪽(작은) 카드 선택
    const card = cards.sort((a, b) => a.innerText.length - b.innerText.length)[0];
    if (!card) return false;
    const btn = [...card.querySelectorAll('button')].find((b) => b.innerText.includes('주차 보기'));
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  console.log("[admin] winter 그룹 펼침:", expanded);
  await page.waitForFunction(
    "[...document.querySelectorAll('tr')].some(tr => tr.innerText.includes('5주차'))",
    undefined,
    { timeout: 30000 },
  );
  const rows = await page.evaluate(`(() => {
    const out = [];
    for (const tr of document.querySelectorAll('tr')) {
      const t = tr.innerText.replace(/\\n/g, ' | ');
      if (/(^|\\| )[58]주차/.test(t) || t.includes('5주차') || t.includes('8주차')) out.push(t);
    }
    return out;
  })()`);
  console.log("[admin] 대상 행:");
  for (const r of rows) console.log("   " + r);
  const w5row = rows.find((r) => r.includes("5주차") && !r.includes("15주차"));
  const w8row = rows.find((r) => r.includes("8주차") && !r.includes("18주차"));
  const w5ok = w5row && w5row.includes("운영") && !w5row.includes("공식 휴식");
  const w8ok = w8row && w8row.includes("공식 휴식");
  console.log(`[admin] W5 운영(정상) 표시: ${w5ok ? "✅" : "❌"}`);
  console.log(`[admin] W8 공식 휴식 표시: ${w8ok ? "✅" : "❌"}`);
  if (!w5ok || !w8ok) failures++;
  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-admin-season-weeks.png"), fullPage: true });
  await context.close();
}

await browser.close();
console.log(failures ? `\n❌ 실패 ${failures}건` : "\n✅ 브라우저 검증 전부 통과");
process.exit(failures ? 1 : 0);

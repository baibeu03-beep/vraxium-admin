// 고객 브라우저 검증 (B안 sentinel 백필) — 프론트(vraxium :3001) cluster-4-card 데모 페이지가
//   재계산된 snapshot 의 info 강화 실패(개설+미배정)를 받아 렌더하는지. 데모 경로(demoUserId=테스트유저
//   actor, userId=영향 오랑캐 유저 target)로 본다 → demoUserId 경로 == 일반(같은 loadWeeklyCards) 동시 확인.
//   페이지가 받은 /weekly-cards API JSON 을 캡처해 info fail tally 를 snapshot 기대값과 대조. 프론트 무수정.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const requireAdmin = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = requireAdmin("@supabase/supabase-js");
const { createServerClient } = requireAdmin("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const FRONT = process.env.FRONT_BASE_URL ?? "http://localhost:3001";
const SUPABASE_URL = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");

const AFFECTED = "5c03de6a-0fbb-4b7c-bbd3-0427de8d6973"; // 전지연(oranke) — 백필 후 info fail 99
const ACTOR = "e649370f-ba2c-4d2f-b642-6800cb078d54";    // 테스트 유저(데모 actor)
const EXPECT_FAIL = 99; // snapshot/http 검증값

const sb = createClient(SUPABASE_URL, get("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

async function makeCookies() {
  const b = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await sb.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await b.auth.verifyOtp({ email: adminEmail, token: linkData.properties.email_otp, type: "magiclink" });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (items) => captured.push(...items) } });
  await server.auth.setSession({ access_token: verifyData.session.access_token, refresh_token: verifyData.session.refresh_token });
  return captured.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}

function tallyInfo(cards) {
  let fail = 0, na = 0, success = 0;
  for (const c of cards ?? []) for (const ln of c?.lines ?? []) {
    if (ln?.partType !== "information") continue;
    if (ln.enhancementStatus === "fail") fail++;
    else if (ln.enhancementStatus === "success") success++;
    else if (ln.enhancementStatus !== "pending") na++;
  }
  return { fail, success, na, cards: (cards ?? []).length };
}

async function main() {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1800 } });
  await context.addCookies(await makeCookies());
  const page = await context.newPage();

  let apiTally = null;
  page.on("response", async (res) => {
    if (/\/api\/cluster4\/weekly-cards/.test(res.url())) {
      try {
        const body = await res.json();
        if (Array.isArray(body?.data)) apiTally = tallyInfo(body.data);
      } catch {}
    }
  });

  const url = `${FRONT}/cluster-4-card?userId=${AFFECTED}&demoUserId=${ACTOR}&mode=test`;
  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(2500);

  const bodyText = await page.evaluate(() => document.body.innerText);
  const rendered = bodyText.length > 200;
  const hasFailWord = /강화\s*실패|실패/.test(bodyText);

  console.log("URL:", url);
  console.log("페이지 렌더:", rendered ? "OK" : "빈 페이지", "· '실패' 텍스트:", hasFailWord ? "있음" : "없음");
  console.log("브라우저가 받은 weekly-cards API info tally:", JSON.stringify(apiTally));
  const ok = apiTally && apiTally.fail === EXPECT_FAIL;
  console.log(ok ? `✅ 브라우저 info fail=${apiTally.fail} == 기대 ${EXPECT_FAIL} (snapshot/http 정합·demo 경로)` : `❌ 불일치 (기대 ${EXPECT_FAIL})`);

  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "info-sentinel-customer.png"), fullPage: false });
  await browser.close();
  if (!ok) process.exit(2);
}
main().catch((e) => { console.error("ERR", e?.message || e); process.exit(1); });

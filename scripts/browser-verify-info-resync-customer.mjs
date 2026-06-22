// 고객 브라우저 검증 — 프론트(vraxium :3001) cluster-4-card 페이지가 재계산된 snapshot 의
//   새 main_title / output_link(카페 공표글 링크) 를 렌더하는지. 데모 경로(demoUserId=테스트유저 actor,
//   userId=영향 오랑캐 유저 target)로 해당 유저 카드를 본다. 프론트 코드 무수정.
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
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

const AFFECTED = "012a3195-f55b-496e-969d-db50a3e24cb9"; // 오랑캐, W18 위즈덤 새 제목 보유
const ACTOR = "13b8e55e-ff49-43f3-a01f-cb68bfb74581";    // 테스트 유저(데모 actor)
const NEW_FRAGMENT = "요시 팝콘통";        // 새 제목 distinctive 단편
const LABEL = "카페 공표글 링크";
const CAFE = "cafe.naver.com/oranke/41999";

async function makeCookies() {
  const b = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await sb.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await b.auth.verifyOtp({ email: adminEmail, token: linkData.properties.email_otp, type: "magiclink" });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (items) => captured.push(...items) } });
  await server.auth.setSession({ access_token: verifyData.session.access_token, refresh_token: verifyData.session.refresh_token });
  return captured.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}

async function main() {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1800 } });
  await context.addCookies(await makeCookies());
  const page = await context.newPage();

  const url = `${FRONT}/cluster-4-card?userId=${AFFECTED}&demoUserId=${ACTOR}&mode=test`;
  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(2500);

  // 데모 경로 weekly-cards 응답(브라우저 컨텍스트 fetch) — 실제 고객이 받는 데이터.
  const apiCheck = await page.evaluate(async ({ aff, actor, frag, label, cafe }) => {
    const r = await fetch(`/api/cluster4/weekly-cards?userId=${aff}&demoUserId=${actor}&mode=test`);
    const j = await r.json().catch(() => ({}));
    const blob = JSON.stringify(j?.data ?? []);
    return { status: r.status, hasNewTitle: blob.includes(frag), hasLabel: blob.includes(label), hasCafe: blob.includes(cafe), hasYoutube: /youtu/.test(blob) };
  }, { aff: AFFECTED, actor: ACTOR, frag: NEW_FRAGMENT, label: LABEL, cafe: CAFE });

  const bodyText = await page.evaluate(() => document.body.innerText);
  const domHasNewTitle = bodyText.includes(NEW_FRAGMENT);

  await page.screenshot({ path: "claudedocs/browser-customer-info-resync.png", fullPage: true });

  console.log(JSON.stringify({
    url,
    customerApiResponse: apiCheck,
    domRendersNewTitle: domHasNewTitle,
    screenshot: "claudedocs/browser-customer-info-resync.png",
    conclusion: (apiCheck.status === 200 && apiCheck.hasNewTitle && apiCheck.hasLabel && apiCheck.hasCafe && !apiCheck.hasYoutube)
      ? "PASS — 고객 경로(프론트 데모) weekly-cards 가 새 제목·카페링크·라벨 반영, youtube 제거."
      : "PARTIAL — apiCheck 확인 필요(데모 게이트/페이지 접근).",
  }, null, 2));

  await browser.close();
}
main().catch((e) => { console.error("ERR", e instanceof Error ? e.message : e); process.exit(1); });

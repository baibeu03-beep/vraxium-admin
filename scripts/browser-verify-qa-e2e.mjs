// 고객앱 브라우저 검증(QA E2E) — front(:3001) 크루 카드 페이지가 개설된 라인을 실제로 렌더하는지.
//   env: QA_USER(test user id) QA_SUFFIX(card page suffix: px/ec/'') QA_MARKER(output link 마커) QA_PART(competency|experience)
//   실행: QA_USER=... QA_SUFFIX=px QA_MARKER=qa-e2e-competency QA_PART=competency \
//         npx tsx --env-file=.env.local scripts/browser-verify-qa-e2e.mjs
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
const SB_URL = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const FRONT = process.env.FRONT_BASE_URL ?? "http://localhost:3001";
const sb = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });

const T = process.env.QA_USER;
const SUFFIX = process.env.QA_SUFFIX ?? "";
const MARKER = process.env.QA_MARKER ?? "qa-e2e";
const PART = process.env.QA_PART ?? "competency";
const CARD_PATH = SUFFIX ? `/cluster-4-card-${SUFFIX}` : `/cluster-4-card`;

async function makeCookies() {
  const b = createClient(SB_URL, ANON);
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verify } = await b.auth.verifyOtp({ email: adminEmail, token: link.properties.email_otp, type: "magiclink" });
  const captured = [];
  const server = createServerClient(SB_URL, ANON, { cookies: { getAll: () => [], setAll: (items) => captured.push(...items) } });
  await server.auth.setSession({ access_token: verify.session.access_token, refresh_token: verify.session.refresh_token });
  return captured.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}

async function main() {
  // 1) 고객 API(admin upstream)에서 T 의 개설된 QA 라인(마커 보유)을 찾아 기대 렌더값 추출.
  const apiRes = await fetch(`http://localhost:3000/api/cluster4/weekly-cards?demoUserId=${T}&mode=test`, { cache: "no-store" });
  const apiJson = await apiRes.json();
  const cards = apiJson?.data ?? [];
  let found = null;
  for (const c of cards) {
    for (const ln of c.lines ?? []) {
      const links = JSON.stringify(ln.outputLinks ?? ln.output_links ?? []);
      if (ln.partType === PART && ln.status !== "void" && links.includes(MARKER)) {
        found = { weekId: c.weekId, weekNumber: c.weekNumber, mainTitle: ln.mainTitle ?? ln.lineName, lineId: ln.lineId, link: (ln.outputLinks ?? [])[0]?.url };
      }
    }
  }
  if (!found) {
    console.log(JSON.stringify({ FAIL: "고객 API 에서 QA 라인(마커) 미발견", part: PART, marker: MARKER, cardCount: cards.length }, null, 2));
    process.exit(1);
  }
  const titleFrag = (found.mainTitle ?? "").slice(0, 12);

  // 2) 브라우저로 front 카드 페이지 진입 → 실제 고객이 보는 렌더.
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 2200 } });
  await context.addCookies(await makeCookies());
  const page = await context.newPage();
  const url = `${FRONT}${CARD_PATH}?userId=${T}&demoUserId=${T}&mode=test`;
  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(2500);

  // 브라우저 컨텍스트(front origin)에서 고객 weekly-cards 재확인 — 진짜 고객 데이터 경로.
  const inPage = await page.evaluate(async ({ t, marker, part }) => {
    const r = await fetch(`/api/cluster4/weekly-cards?demoUserId=${t}&mode=test`);
    const j = await r.json().catch(() => ({}));
    const blob = JSON.stringify(j?.data ?? []);
    return { status: r.status, hasMarker: blob.includes(marker), partCount: (j?.data ?? []).flatMap((c) => c.lines ?? []).filter((l) => l.partType === part && l.status !== "void").length };
  }, { t: T, marker: MARKER, part: PART });

  const bodyText = await page.evaluate(() => document.body.innerText);
  const html = await page.content();
  const domHasTitle = titleFrag.length > 0 && bodyText.includes(titleFrag);
  const domHasLink = html.includes(MARKER);

  const shot = `claudedocs/qa-e2e-${PART}-customer.png`;
  await page.screenshot({ path: shot, fullPage: true });

  const pass = inPage.status === 200 && inPage.hasMarker && (domHasTitle || domHasLink);
  console.log(JSON.stringify({
    part: PART, testUser: T, cardPage: url,
    expected: found, titleFragment: titleFrag,
    inPageCustomerApi: inPage,
    domRendersTitle: domHasTitle, domHasOutputLinkMarker: domHasLink,
    screenshot: shot,
    CONCLUSION: pass
      ? `PASS — 고객앱(front ${CARD_PATH}) 브라우저에서 개설된 ${PART} 라인이 렌더됨(고객 데이터+DOM 확인).`
      : "FAIL — 고객앱 렌더 미확인(아래 필드로 추적).",
  }, null, 2));

  await browser.close();
  if (!pass) process.exit(1);
}
main().catch((e) => { console.error("ERR", e instanceof Error ? e.message : e); process.exit(1); });

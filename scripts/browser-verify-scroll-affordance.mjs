// 좁은 뷰포트에서 가로 오버플로를 강제해 스크롤 어포던스 동작을 검증.
//   초기: 우측 fade on + 좌측 fade off + 힌트 visible.
//   스크롤 후: 좌측 fade on + 힌트 hidden(한 번 상호작용).
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
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const SUPABASE_URL = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const admin = createClient(SUPABASE_URL, SERVICE);

async function makeAdminCookies() {
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await browser.auth.verifyOtp({
    email: adminEmail, token: linkData.properties.email_otp, type: "magiclink",
  });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  return captured.map((i) => ({
    name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax",
  }));
}

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();

// 오버플로하는 첫 어포던스 컨테이너의 상태를 읽는다.
const readState = () =>
  page.evaluate(() => {
    const c = Array.from(document.querySelectorAll('[data-slot="table-container"]')).find((el) => {
      const sc = el.querySelector(":scope > div");
      return sc && sc.scrollWidth > sc.clientWidth + 1;
    });
    if (!c) return { overflow: false };
    const scroller = c.querySelector(":scope > div");
    const divs = Array.from(c.children).filter(
      (ch) => ch.tagName === "DIV" && /gradient/.test(getComputedStyle(ch).backgroundImage),
    );
    const leftFade = divs.find((d) => getComputedStyle(d).left === "0px");
    const rightFade = divs.find((d) => getComputedStyle(d).right === "0px");
    // 힌트 = text 포함된 pointer-events-none 칩(gradient 없음)
    const hint = Array.from(c.children).find(
      (ch) => ch.tagName === "DIV" && ch.textContent && ch.textContent.includes("스크롤"),
    );
    return {
      overflow: true,
      scrollLeft: scroller.scrollLeft,
      leftOpacity: leftFade ? getComputedStyle(leftFade).opacity : null,
      rightOpacity: rightFade ? getComputedStyle(rightFade).opacity : null,
      hintOpacity: hint ? getComputedStyle(hint).opacity : null,
    };
  });

try {
  console.log("[members @1440px, 오버플로 강제] /admin/members?org=encre");
  try {
    await page.goto(`${BASE}/admin/members?org=encre`, { waitUntil: "networkidle", timeout: 30000 });
  } catch {
    await page.goto(`${BASE}/admin/members?org=encre`, { waitUntil: "domcontentloaded", timeout: 30000 });
  }
  await page.waitForTimeout(1500);

  // 실제 오버플로 강제 — 첫 표의 min-width 를 넓힌다. 그런 다음 뷰포트를 1px 리사이즈해
  // 스크롤러의 ResizeObserver(=measure) 를 발생시킨다. scroll 이벤트가 아니므로 interacted
  // 가 false 로 유지 → 초기 힌트(첫 진입) 상태를 그대로 관찰할 수 있다.
  await page.evaluate(() => {
    const c = document.querySelector('[data-slot="table-container"]');
    if (!c) return;
    c.querySelector("table").style.minWidth = "3000px";
  });
  await page.setViewportSize({ width: 1441, height: 900 });
  await page.waitForTimeout(500);

  const s0 = await readState();
  console.log("  초기:", JSON.stringify(s0));
  check("표 가로 오버플로 발생", s0.overflow === true);
  if (s0.overflow) {
    check("초기: 우측 fade ON", s0.rightOpacity === "1", `right=${s0.rightOpacity}`);
    check("초기: 좌측 fade OFF", s0.leftOpacity === "0", `left=${s0.leftOpacity}`);
    check("초기: 힌트 visible", s0.hintOpacity === "1", `hint=${s0.hintOpacity}`);

    await page.screenshot({ path: resolve(adminRoot, "claudedocs", "qa-scroll-hint-initial.png") });

    // 스크롤 — 스크롤러(오버플로 요소)를 찾아 실제 scroll.
    await page.evaluate(() => {
      const c = Array.from(document.querySelectorAll('[data-slot="table-container"]')).find((el) => {
        const sc = el.querySelector(":scope > div");
        return sc && sc.scrollWidth > sc.clientWidth + 1;
      });
      const sc = c.querySelector(":scope > div");
      sc.scrollLeft = 200;
      sc.dispatchEvent(new Event("scroll"));
    });
    await page.waitForTimeout(400);
    const s1 = await readState();
    console.log("  스크롤 후:", JSON.stringify(s1));
    check("스크롤 후: 좌측 fade ON", s1.leftOpacity === "1", `left=${s1.leftOpacity}`);
    check("스크롤 후: 힌트 hidden(상호작용됨)", s1.hintOpacity === "0", `hint=${s1.hintOpacity}`);
    await page.screenshot({ path: resolve(adminRoot, "claudedocs", "qa-scroll-hint-scrolled.png") });
  }
  console.log(`\n=== RESULT: ${pass} pass / ${fail} fail ===`);
} catch (e) {
  console.error("ERROR:", e);
  fail++;
} finally {
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
}

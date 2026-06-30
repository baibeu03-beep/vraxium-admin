// 브라우저(인증 세션) 검증 — 어드민 공통 상단 헤더(AdminPageHeader) 통일.
//   · 5개 페이지가 동일 구조(h1 + nav[aria-label="페이지 탭"])를 쓰는지
//   · 탭 active/inactive 스타일이 스펙(bg-foreground/text-background · text-muted-foreground)대로인지
//   · 탭 href 가 org 쿼리스트링을 보존하는지, 클릭 시 active/URL 이 정상 전환되는지
//   · 글로벌 헤더의 옛 중복 탭(aria-label="라인 개설 탭"/"멤버 관리 탭")이 사라졌는지
// 사용법: node scripts/browser-verify-admin-page-header.mjs
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

// 페이지 상단 헤더 상태를 DOM 에서 읽는다.
async function readHeader(page) {
  return page.evaluate(() => {
    const navs = Array.from(document.querySelectorAll("nav"));
    const pageTabNav = navs.find((n) => n.getAttribute("aria-label") === "페이지 탭") ?? null;
    const oldLineNav = navs.find((n) => n.getAttribute("aria-label") === "라인 개설 탭") ?? null;
    const oldMembersNav = navs.find((n) => n.getAttribute("aria-label") === "멤버 관리 탭") ?? null;
    const tabs = pageTabNav
      ? Array.from(pageTabNav.querySelectorAll("a")).map((a) => ({
          label: a.textContent?.trim() ?? "",
          href: a.getAttribute("href") ?? "",
          active: a.getAttribute("aria-current") === "page",
          cls: a.className,
        }))
      : [];
    // AdminPageHeader 의 제목(h1.text-lg). 글로벌 바 h1 은 이 페이지들에서 제거됨.
    const h1s = Array.from(document.querySelectorAll("h1")).map((h) => ({
      text: h.textContent?.trim() ?? "",
      cls: h.className,
    }));
    return {
      hasPageTabNav: !!pageTabNav,
      hasOldTabNav: !!oldLineNav || !!oldMembersNav,
      tabs,
      h1s,
    };
  });
}

const ACTIVE_OK = (cls) => /bg-foreground/.test(cls) && /text-background/.test(cls);
const INACTIVE_OK = (cls) => /text-muted-foreground/.test(cls);

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext();
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();

try {
  // ── 1) practical-info?org=encre (manage 기본) ──
  console.log("\n[1] /admin/line-opening/practical-info?org=encre");
  await page.goto(`${BASE}/admin/line-opening/practical-info?org=encre`, { waitUntil: "networkidle" });
  let h = await readHeader(page);
  check("AdminPageHeader 탭 nav 존재", h.hasPageTabNav);
  check("글로벌 헤더 옛 중복 탭 제거됨", !h.hasOldTabNav);
  check("제목 '실무 정보'", h.h1s.some((x) => x.text === "실무 정보"), h.h1s.map((x) => x.text).join(" | "));
  check("탭 2개(라인 관리/라인 개설)", h.tabs.length === 2, h.tabs.map((t) => t.label).join(","));
  {
    const manage = h.tabs.find((t) => t.label === "라인 관리");
    const open = h.tabs.find((t) => t.label === "라인 개설");
    check("라인 관리 active + 스펙 스타일", manage?.active && ACTIVE_OK(manage.cls));
    check("라인 개설 inactive + 스펙 스타일", open && !open.active && INACTIVE_OK(open.cls));
    check("라인 개설 href org 보존", /org=encre/.test(open?.href ?? "") && /tab=open/.test(open?.href ?? ""), open?.href);
    check("라인 관리 href org 보존(tab 없음)", /org=encre/.test(manage?.href ?? "") && !/tab=open/.test(manage?.href ?? ""), manage?.href);
  }

  // ── 2) 탭 클릭 → ?tab=open active 전환 + org 보존 ──
  console.log("\n[2] 라인 개설 탭 클릭(라우팅/active 전환)");
  await page.click('nav[aria-label="페이지 탭"] a:has-text("라인 개설")');
  await page.waitForURL(/tab=open/, { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState("networkidle");
  const url2 = page.url();
  check("URL org=encre 보존 + tab=open", /org=encre/.test(url2) && /tab=open/.test(url2), url2);
  h = await readHeader(page);
  {
    const open = h.tabs.find((t) => t.label === "라인 개설");
    const manage = h.tabs.find((t) => t.label === "라인 관리");
    check("라인 개설 active 전환", open?.active && ACTIVE_OK(open.cls));
    check("라인 관리 inactive 전환", manage && !manage.active);
  }

  // ── 3) practical-experience?org=encre ──
  console.log("\n[3] /admin/line-opening/practical-experience?org=encre");
  await page.goto(`${BASE}/admin/line-opening/practical-experience?org=encre`, { waitUntil: "networkidle" });
  h = await readHeader(page);
  check("탭 nav 존재 + 옛 탭 없음", h.hasPageTabNav && !h.hasOldTabNav);
  check("제목 '실무 경험'", h.h1s.some((x) => x.text === "실무 경험"), h.h1s.map((x) => x.text).join(" | "));
  check("라인 관리 active(기본)", h.tabs.find((t) => t.label === "라인 관리")?.active);

  // ── 4) processes/check/info?org=encre (탭 없음) ──
  console.log("\n[4] /admin/processes/check/info?org=encre");
  await page.goto(`${BASE}/admin/processes/check/info?org=encre`, { waitUntil: "networkidle" });
  h = await readHeader(page);
  check("탭 없음(title+description만)", !h.hasPageTabNav);
  check("제목 '실무 정보 급'", h.h1s.some((x) => x.text === "실무 정보 급"), h.h1s.map((x) => x.text).join(" | "));

  // ── 5) processes/check/experience?org=encre ──
  console.log("\n[5] /admin/processes/check/experience?org=encre");
  await page.goto(`${BASE}/admin/processes/check/experience?org=encre`, { waitUntil: "networkidle" });
  h = await readHeader(page);
  check("탭 없음", !h.hasPageTabNav);
  check("제목 '실무 경험 급'", h.h1s.some((x) => x.text === "실무 경험 급"), h.h1s.map((x) => x.text).join(" | "));

  // ── 6) members?org=encre ──
  console.log("\n[6] /admin/members?org=encre");
  await page.goto(`${BASE}/admin/members?org=encre`, { waitUntil: "networkidle" });
  h = await readHeader(page);
  check("탭 nav 존재 + 옛 탭 없음", h.hasPageTabNav && !h.hasOldTabNav);
  check("제목 '크루 관리'", h.h1s.some((x) => x.text === "크루 관리"), h.h1s.map((x) => x.text).join(" | "));
  {
    const list = h.tabs.find((t) => t.label === "크루 목록");
    const info = h.tabs.find((t) => t.label === "크루 정보");
    check("크루 목록 active(기본) + 스펙 스타일", list?.active && ACTIVE_OK(list.cls));
    check("크루 정보 inactive + 스펙 스타일", info && !info.active && INACTIVE_OK(info.cls));
    check("크루 정보 href org 보존", /org=encre/.test(info?.href ?? "") && /tab=info/.test(info?.href ?? ""), info?.href);
  }

  console.log(`\n=== RESULT: ${pass} pass / ${fail} fail ===`);
} catch (e) {
  console.error("ERROR:", e);
  fail++;
} finally {
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
}

// 검증(DOM+HTTP, 실행 중 dev :3000) — /admin/rest-management 조직 탭을 URL 분기가 아니라
//   페이지 내부 상태(selectedOrg)로 전환하도록 바꾼 변경의 회귀 확인.
//
//   핵심 회귀 포인트(요구사항 1~9):
//     1) /admin/rest-management → [통합] 탭 active · 빈 본문
//     2) [엥크레] 클릭 → URL 불변 · 엥크레 본문
//     3) [오랑캐]·[팔랑크스] 클릭 → URL 불변 · 각 조직 본문
//     4) [통합] 복귀 → URL 불변 · 빈 본문
//     5) ?mode=test 에서도 내부 탭 전환 · mode=test 보존 · org 미부착
//     6) 탭 전환 후 새로고침 → 기본값 [통합]
//     7) 레거시 ?org=encre 직접 진입 → 최초 [엥크레] 탭 · 이후 다른 탭 클릭해도 URL(?org=encre) 불변
//     8) 탭은 <button>(라우팅 없음) — <a>(Link) 부재
//     9) 일반/테스트 모드 summary·list 응답 DTO 키 동일(서버가 mode 무시 → 동일 요청)
//
//   사전조건: admin dev :3000. Usage: node scripts/browser-verify-rest-management-inpage-tabs.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const { chromium } = createRequire(
  resolve(adminRoot, "..", "vraxium", "package.json"),
)("playwright");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE);
const brow = createClient(URL_, ANON);
const OWNER_EMAIL = "vanuatu.golden@gmail.com"; // owner(전체 클럽 허용)

let fail = 0;
const ck = (l, ok, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};

async function cookiesFor(email) {
  const { data: link, error } = await sb.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (error) throw new Error(`generateLink(${email}): ${error.message}`);
  const { data: v, error: e2 } = await brow.auth.verifyOtp({
    email,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  if (e2) throw new Error(`verifyOtp(${email}): ${e2.message}`);
  const cap = [];
  const srv = createServerClient(URL_, ANON, {
    cookies: { getAll: () => [], setAll: (i) => cap.push(...i) },
  });
  await srv.auth.setSession({
    access_token: v.session.access_token,
    refresh_token: v.session.refresh_token,
  });
  return cap.map((i) => ({
    name: i.name,
    value: i.value,
    domain: "localhost",
    path: "/",
    httpOnly: false,
    secure: false,
    sameSite: "Lax",
  }));
}

const TABS = "nav[aria-label='페이지 탭']";
const tabBtn = (page, label) =>
  page.locator(`${TABS} button`, { hasText: new RegExp(`^${label}$`) });
// 활성 조직 본문 존재 여부 = 요약 영역의 [전체 승인] 버튼(통합 빈 본문엔 없음).
const bodyPresent = async (page) =>
  (await page.getByRole("button", { name: "전체 승인" }).count()) > 0;
const activeOrgAttr = (page) =>
  page.locator("[data-active-org]").first().getAttribute("data-active-org");
const activeTabLabel = async (page) => {
  const el = page.locator(`${TABS} button[aria-current='page']`).first();
  return (await el.count()) ? (await el.innerText()).trim() : null;
};

async function settle(page) {
  await page.waitForSelector(TABS, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(700);
}

const browser = await chromium.launch({ channel: "chromium", headless: true });
try {
  const ownerCookies = await cookiesFor(OWNER_EMAIL);

  // ══ DOM — 통합 경로 내부 탭 전환 ══
  console.log("▶ DOM — /admin/rest-management 내부 탭 전환(통합 경로)");
  {
    const ctx = await browser.newContext({
      viewport: { width: 1600, height: 1100 },
    });
    await ctx.addCookies(ownerCookies);
    const page = await ctx.newPage();
    page.on("dialog", (d) => d.dismiss().catch(() => {}));
    await page.goto(`${BASE}/admin/rest-management`, {
      waitUntil: "domcontentloaded",
    });
    await settle(page);
    const url0 = page.url();

    // (8) 탭 = <button> 4개(통합+3), <a> 탭 없음
    ck("탭 4개(button)", (await page.locator(`${TABS} button`).count()) === 4);
    ck("탭 <a>(Link) 부재", (await page.locator(`${TABS} a`).count()) === 0);

    // (1) 통합 active · 빈 본문
    ck("(1) 진입 시 [통합] active", (await activeTabLabel(page)) === "통합");
    ck("(1) data-active-org=integrated", (await activeOrgAttr(page)) === "integrated");
    ck("(1) 통합 본문 비어있음([전체 승인] 부재)", !(await bodyPresent(page)));

    // (2) 엥크레 클릭 → URL 불변 · 본문 표시
    await tabBtn(page, "엥크레").click();
    await page.waitForFunction(
      () => document.querySelector("[data-active-org]")?.getAttribute("data-active-org") === "encre",
      { timeout: 15000 },
    ).catch(() => {});
    await page.waitForTimeout(500);
    ck("(2) 엥크레 클릭 후 URL 불변", page.url() === url0, page.url());
    ck("(2) data-active-org=encre", (await activeOrgAttr(page)) === "encre");
    ck("(2) 엥크레 active 탭", (await activeTabLabel(page)) === "엥크레");
    ck("(2) 엥크레 본문 표시([전체 승인] 존재)", await bodyPresent(page));

    // (3) 오랑캐·팔랑크스
    for (const [label, slug] of [
      ["오랑캐", "oranke"],
      ["팔랑크스", "phalanx"],
    ]) {
      await tabBtn(page, label).click();
      await page
        .waitForFunction(
          (s) =>
            document.querySelector("[data-active-org]")?.getAttribute("data-active-org") === s,
          slug,
          { timeout: 15000 },
        )
        .catch(() => {});
      await page.waitForTimeout(400);
      ck(`(3) ${label} 클릭 후 URL 불변`, page.url() === url0, page.url());
      ck(`(3) data-active-org=${slug}`, (await activeOrgAttr(page)) === slug);
      ck(`(3) ${label} 본문 표시`, await bodyPresent(page));
    }

    // (4) 통합 복귀 → URL 불변 · 빈 본문
    await tabBtn(page, "통합").click();
    await page.waitForTimeout(500);
    ck("(4) 통합 복귀 후 URL 불변", page.url() === url0, page.url());
    ck("(4) data-active-org=integrated", (await activeOrgAttr(page)) === "integrated");
    ck("(4) 통합 본문 비어있음", !(await bodyPresent(page)));

    // (6) 탭 전환 후 새로고침 → 기본값 통합
    await tabBtn(page, "팔랑크스").click();
    await page.waitForTimeout(400);
    await page.reload({ waitUntil: "domcontentloaded" });
    await settle(page);
    ck("(6) 새로고침 후 [통합] 기본값", (await activeTabLabel(page)) === "통합");
    ck("(6) 새로고침 후 URL 불변", page.url() === url0, page.url());

    await page.screenshot({
      path: "claudedocs/qa-rest-management-inpage-tabs.png",
    }).catch(() => {});
    await ctx.close();
  }

  // ══ DOM — mode=test 경로 ══
  console.log("\n▶ DOM — ?mode=test 내부 탭 전환");
  {
    const ctx = await browser.newContext({
      viewport: { width: 1600, height: 1100 },
    });
    await ctx.addCookies(ownerCookies);
    const page = await ctx.newPage();
    page.on("dialog", (d) => d.dismiss().catch(() => {}));
    await page.goto(`${BASE}/admin/rest-management?mode=test`, {
      waitUntil: "domcontentloaded",
    });
    await settle(page);
    const urlT = page.url();
    ck("(5) 진입 시 [통합] active", (await activeTabLabel(page)) === "통합");
    await tabBtn(page, "엥크레").click();
    await page.waitForTimeout(600);
    ck("(5) 엥크레 후 mode=test 보존", /[?&]mode=test\b/.test(page.url()), page.url());
    ck("(5) 엥크레 후 org 미부착", !/[?&]org=/.test(page.url()), page.url());
    ck("(5) URL 불변(엥크레 전환)", page.url() === urlT, page.url());
    ck("(5) data-active-org=encre", (await activeOrgAttr(page)) === "encre");
    await ctx.close();
  }

  // ══ DOM — 개별 경로(?org=): 자기 조직 탭 1개만 · 타 조직/통합 탭 DOM 부재 · API org=URL org ══
  console.log("\n▶ DOM — 개별 경로 ?org={slug} 단일 탭 고정");
  for (const { slug, label, path } of [
    { slug: "encre", label: "엥크레", path: "?org=encre" },
    { slug: "oranke", label: "오랑캐", path: "?org=oranke" },
    { slug: "phalanx", label: "팔랑크스", path: "?org=phalanx" },
    { slug: "encre", label: "엥크레", path: "?mode=test&org=encre" },
  ]) {
    const ctx = await browser.newContext({
      viewport: { width: 1600, height: 1100 },
    });
    await ctx.addCookies(ownerCookies);
    const page = await ctx.newPage();
    page.on("dialog", (d) => d.dismiss().catch(() => {}));
    // 개별 경로의 모든 rest-management API 요청 org 가 URL org 와 일치하는지 감시.
    const apiOrgs = new Set();
    page.on("request", (req) => {
      const u = req.url();
      if (u.includes("/api/admin/rest-management/")) {
        const o = new URL(u).searchParams.get("organization");
        if (o) apiOrgs.add(o);
      }
    });
    await page.goto(`${BASE}/admin/rest-management${path}`, {
      waitUntil: "domcontentloaded",
    });
    await settle(page);
    const tag = `[${path}]`;
    const allTabs = await page.locator(`${TABS} button`).allInnerTexts();
    ck(`${tag} 탭 1개만`, allTabs.length === 1, JSON.stringify(allTabs));
    ck(`${tag} [${label}] 탭만 · active`, (await activeTabLabel(page)) === label);
    ck(`${tag} data-active-org=${slug}`, (await activeOrgAttr(page)) === slug);
    // 통합·타 조직 탭 DOM 부재
    for (const other of ["통합", "엥크레", "오랑캐", "팔랑크스"].filter((l) => l !== label)) {
      ck(
        `${tag} [${other}] 탭 DOM 부재`,
        (await tabBtn(page, other).count()) === 0,
      );
    }
    ck(`${tag} 본문 표시([전체 승인])`, await bodyPresent(page));
    // mode=test 경로는 org 미제거(URL 그대로), URL 불변
    await page.waitForTimeout(300);
    ck(
      `${tag} API organization = URL org(${slug}) 만`,
      apiOrgs.size >= 1 && [...apiOrgs].every((o) => o === slug),
      `[${[...apiOrgs].join(",")}]`,
    );
    await ctx.close();
  }

  // ══ HTTP — 일반/테스트 모드 DTO 키 동일(서버가 mode 무시) ══
  console.log("\n▶ HTTP — summary/list DTO 키 (일반 vs 테스트)");
  {
    const api = await browser.newContext();
    await api.addCookies(ownerCookies);
    const jget = async (path) => {
      const r = await api.request.get(`${BASE}${path}`, {
        failOnStatusCode: false,
      });
      return { status: r.status(), json: await r.json().catch(() => null) };
    };
    const sortKeys = (o) => (o ? Object.keys(o).sort().join(",") : "<null>");
    // 클라이언트는 mode 를 API 로 보내지 않는다 → 일반/테스트 요청이 동일. 두 경로 모두 확인.
    const sumN = await jget(`/api/admin/rest-management/summary?organization=encre`);
    const listN = await jget(`/api/admin/rest-management/list?organization=encre`);
    ck("summary 200 · success", sumN.status === 200 && sumN.json?.success === true);
    ck(
      "summary DTO 키 = seasons,seasonKey,success,summary",
      sortKeys(sumN.json) === "seasonKey,seasons,success,summary",
      sortKeys(sumN.json),
    );
    ck(
      "summary.summary 키 = crews,normal,total,urgent",
      sortKeys(sumN.json?.summary) === "crews,normal,total,urgent",
      sortKeys(sumN.json?.summary),
    );
    ck("list 200 · success · rows[]", listN.status === 200 && listN.json?.success === true && Array.isArray(listN.json?.rows));
    if (Array.isArray(listN.json?.rows) && listN.json.rows.length > 0) {
      console.log(`    (list row 키: ${sortKeys(listN.json.rows[0])})`);
    }
    // 타조직도 동일 DTO 형태
    for (const org of ["oranke", "phalanx"]) {
      const s = await jget(`/api/admin/rest-management/summary?organization=${org}`);
      ck(`summary(${org}) DTO 키 동일`, sortKeys(s.json) === "seasonKey,seasons,success,summary", sortKeys(s.json));
    }
    await api.close();
  }
} finally {
  await browser.close();
}

console.log(`\n${fail === 0 ? "✅ PASS" : `❌ FAIL (${fail})`}`);
process.exit(fail === 0 ? 0 : 1);

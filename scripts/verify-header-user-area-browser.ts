/**
 * 헤더 우측 관리자 정보+로그아웃 이동 브라우저 검증 (2026-06-07).
 *   - 사이드바: 하단 footer(이름/환영/이메일/로그아웃) 제거 확인
 *   - 헤더 우측: 관리자 이름 "{이름}님" + 로그아웃 버튼 노출
 *   - 개발자 표시 버튼 미노출 (기능은 SHOW_DEV_TOGGLE 플래그로만 숨김)
 *   - 대상: /admin/members, /admin/import, /admin/users/applicants, /admin/test-users
 *   - 모바일 폭(390px)에서 헤더 깨짐(가로 오버플로) 여부
 *   - 로그아웃 클릭 → /login 이동 + 세션 종료 확인
 *   사전조건: admin dev :3000.
 *   npx tsx scripts/verify-header-user-area-browser.ts
 * READ-ONLY(인증 세션 외 데이터 변경 없음). 스크린샷은 claudedocs/.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const adminBase = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

function ensureEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function makeAdminCookies(): Promise<Array<{ name: string; value: string }>> {
  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const serviceRoleKey = ensureEnv("SUPABASE_SERVICE_ROLE_KEY");
  const admin = createClient(supabaseUrl, serviceRoleKey);
  const browser = createClient(supabaseUrl, anonKey);
  const { data: linkData, error: linkError } =
    await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  if (linkError || !linkData?.properties?.email_otp)
    throw new Error(linkError?.message ?? "generateLink failed");
  const { data: verifyData, error: verifyError } = await browser.auth.verifyOtp({
    email: adminEmail,
    token: linkData.properties.email_otp,
    type: "magiclink",
  });
  if (verifyError || !verifyData.session)
    throw new Error(verifyError?.message ?? "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [],
      setAll: (items) =>
        void captured.push(...items.map((i) => ({ name: i.name, value: i.value }))),
    },
  });
  const { error } = await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  if (error) throw new Error(error.message);
  return captured;
}

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

// tsx 변환 __name 헬퍼 이슈 회피: evaluate 는 문자열로 전달
const READ_STATE = `(() => {
  const header = document.querySelector("header");
  const aside = document.querySelector("aside");
  const headerText = header ? header.innerText : "";
  const headerBtns = [...(header ? header.querySelectorAll("button") : [])];
  const logoutBtn = headerBtns.find((b) => (b.textContent || "").includes("로그아웃"));
  const asideBtns = [...(aside ? aside.querySelectorAll("button") : [])];
  const asideLogout = asideBtns.some((b) => (b.textContent || "").includes("로그아웃"));
  const asideText = aside ? aside.innerText : "";
  const nameSpan = [...(header ? header.querySelectorAll("span") : [])]
    .find((s) => /님(\\s*환영합니다)?$/.test((s.textContent || "").trim()));
  // innerText = 화면에 실제 보이는 텍스트 (hidden sm:inline 분기 반영)
  const headerVisibleWelcome = header ? header.innerText.includes("환영합니다") : false;
  let logoutRight = null;
  if (logoutBtn && header) {
    const h = header.getBoundingClientRect();
    const b = logoutBtn.getBoundingClientRect();
    logoutRight = Math.round(h.right - b.right);
  }
  return {
    headerHasName: !!nameSpan,
    headerName: nameSpan ? nameSpan.textContent.trim() : null,
    headerVisibleWelcome,
    headerHasLogout: !!logoutBtn,
    logoutGapToHeaderRight: logoutRight,
    headerHasDevToggle: headerText.includes("개발자 표시"),
    asideHasLogout: asideLogout,
    asideHasWelcome: asideText.includes("환영합니다"),
    asideHasEmail: asideText.includes("@"),
    asideStickyHscreen: aside ? (getComputedStyle(aside).position === "sticky" && Math.abs(aside.getBoundingClientRect().height - window.innerHeight) < 2) : false,
    hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
})()`;

const PAGES = [
  "/admin/members",
  "/admin/import",
  "/admin/users/applicants",
  "/admin/test-users",
];

async function main() {
  // Turbopack dev + headless-shell 즉사 이슈 → channel chromium 사용
  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const cookies = await makeAdminCookies();
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await ctx.addCookies(
      cookies.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" })),
    );
    const page = await ctx.newPage();

    // 1) 4개 페이지: 헤더 우측 이름+로그아웃, 개발자 표시 미노출, 사이드바 footer 제거
    for (const path of PAGES) {
      console.log(`\n[${path}]`);
      await page.goto(`${adminBase}${path}`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(2500);
      const st = (await page.evaluate(READ_STATE)) as Record<string, unknown>;
      check("헤더 이름 노출({이름}님)", st.headerHasName === true, String(st.headerName));
      check("헤더 환영 문구 노출(환영합니다)", st.headerVisibleWelcome === true);
      check("헤더 로그아웃 버튼 노출", st.headerHasLogout === true);
      check(
        "로그아웃 버튼 우측 정렬(40px 이내)",
        typeof st.logoutGapToHeaderRight === "number" && (st.logoutGapToHeaderRight as number) <= 40,
        `gap=${st.logoutGapToHeaderRight}px`,
      );
      check("개발자 표시 버튼 미노출", st.headerHasDevToggle === false);
      check("사이드바 로그아웃 제거", st.asideHasLogout === false);
      check("사이드바 환영 문구 제거", st.asideHasWelcome === false);
      check("사이드바 이메일 제거", st.asideHasEmail === false);
      check("사이드바 sticky+h-screen 유지", st.asideStickyHscreen === true);
      check("가로 오버플로 없음", st.hScroll === false);
    }
    await page.screenshot({ path: "claudedocs/header-user-area-members.png" });

    // 2) /admin HOME: 헤더 우측 로그아웃 유지(사이드바 footer 제거로 유일한 진입점)
    {
      console.log("\n[/admin HOME]");
      await page.goto(`${adminBase}/admin`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(2500);
      const st = (await page.evaluate(READ_STATE)) as Record<string, unknown>;
      check("HOME 헤더 로그아웃 노출", st.headerHasLogout === true);
      check("HOME 개발자 표시 미노출", st.headerHasDevToggle === false);
      check("HOME 사이드바 로그아웃 제거", st.asideHasLogout === false);
      await page.screenshot({ path: "claudedocs/header-user-area-home.png" });
    }

    // 3) 모바일 폭(390px): 헤더 줄바꿈/깨짐 여부
    {
      console.log("\n[mobile 390px /admin/members]");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${adminBase}/admin/members`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(2500);
      const st = (await page.evaluate(READ_STATE)) as Record<string, unknown>;
      check("모바일 헤더 로그아웃 노출", st.headerHasLogout === true);
      check("모바일 헤더 이름 노출", st.headerHasName === true, String(st.headerName));
      const headerOk = (await page.evaluate(`(() => {
        const header = document.querySelector("header");
        if (!header) return null;
        const r = header.getBoundingClientRect();
        const children = [...header.querySelectorAll("h1, button, span")];
        const overflow = children.some((c) => {
          const b = c.getBoundingClientRect();
          if (b.width === 0 && b.height === 0) return false; // display:none(의도적 숨김) 제외
          return b.right > r.right + 1 || b.left < r.left - 1;
        });
        return { height: Math.round(r.height), overflow };
      })()`)) as { height: number; overflow: boolean } | null;
      check("모바일 헤더 높이 56px 유지(한 줄)", !!headerOk && headerOk.height === 56, `h=${headerOk?.height}`);
      check("모바일 헤더 요소 오버플로 없음", !!headerOk && !headerOk.overflow);
      await page.screenshot({ path: "claudedocs/header-user-area-mobile.png" });
      await page.setViewportSize({ width: 1600, height: 1000 });
    }

    // 4) 로그아웃 클릭 → /login 이동 + 세션 종료
    {
      console.log("\n[logout flow]");
      await page.goto(`${adminBase}/admin/members`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(2500);
      await page.locator("header button", { hasText: "로그아웃" }).click();
      await page.waitForURL("**/login**", { timeout: 30000 });
      check("로그아웃 후 /login 이동", page.url().includes("/login"), page.url());
      await page.goto(`${adminBase}/admin`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(2000);
      check("로그아웃 후 /admin → /login 리다이렉트", page.url().includes("/login"), page.url());
      await page.screenshot({ path: "claudedocs/header-user-area-after-logout.png" });
    }

    await ctx.close();
  } finally {
    await browser.close();
  }
  console.log(`\n${failures === 0 ? "✓ 전체 통과" : `✗ 실패 ${failures}건`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

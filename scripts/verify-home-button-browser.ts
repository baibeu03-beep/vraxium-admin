/**
 * 헤더 "홈" 버튼 + 사이드바 HOME 링크 브라우저 검증 (2026-06-07).
 *   - 하위 페이지: 헤더 우측에 "홈" 버튼(링크) 노출 + 클릭 시 /admin 이동
 *   - 사이드바 상단 HOME 라벨 = /admin 링크, 클릭 시 /admin 이동
 *   - /admin HOME: 헤더 홈 버튼 미노출(이미 홈), 사이드바 HOME 은 navLocked(이동 차단)
 *   - 기존 로그아웃 버튼/사용자 정보 영역 유지, 가로 오버플로 없음
 *   - 모바일 폭(390px)에서도 홈 버튼 노출 + 깨짐 없음
 *   - 새로고침 후에도 정상 표시
 *   사전조건: admin dev :3000.
 *   npx tsx scripts/verify-home-button-browser.ts
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
  // 홈 버튼은 Button render={<Link/>} → <a> 로 렌더링된다
  const homeLink = [...(header ? header.querySelectorAll("a") : [])]
    .find((a) => (a.textContent || "").includes("홈"));
  const logoutBtn = [...(header ? header.querySelectorAll("button") : [])]
    .find((b) => (b.textContent || "").includes("로그아웃"));
  const asideHome = [...(aside ? aside.querySelectorAll("a") : [])]
    .find((a) => (a.textContent || "").trim() === "HOME");
  let overlap = null;
  if (homeLink && logoutBtn) {
    const h = homeLink.getBoundingClientRect();
    const l = logoutBtn.getBoundingClientRect();
    overlap = !(h.right <= l.left || l.right <= h.left || h.bottom <= l.top || l.bottom <= h.top);
  }
  const headerText = header ? header.innerText : "";
  return {
    headerHomeVisible: !!homeLink && homeLink.getBoundingClientRect().width > 0,
    headerHomeHref: homeLink ? homeLink.getAttribute("href") : null,
    headerHasLogout: !!logoutBtn,
    headerHasUserInfo: headerText.includes("반갑습니다"),
    homeOverlapsLogout: overlap,
    asideHomeIsLink: !!asideHome,
    asideHomeHref: asideHome ? asideHome.getAttribute("href") : null,
    asideHomeLocked: asideHome ? getComputedStyle(asideHome).pointerEvents === "none" : null,
    hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
})()`;

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

    // 1) 하위 페이지: 홈 버튼 노출 + 기존 로그아웃/사용자 정보 유지
    for (const path of ["/admin/members", "/admin/season-weeks"]) {
      console.log(`\n[${path}]`);
      await page.goto(`${adminBase}${path}`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(2500);
      const st = (await page.evaluate(READ_STATE)) as Record<string, unknown>;
      check("헤더 홈 버튼 노출", st.headerHomeVisible === true);
      check("홈 버튼 href=/admin", st.headerHomeHref === "/admin", String(st.headerHomeHref));
      check("로그아웃 버튼 유지", st.headerHasLogout === true);
      check("사용자 정보 영역 유지", st.headerHasUserInfo === true);
      check("홈/로그아웃 겹침 없음", st.homeOverlapsLogout === false);
      check("사이드바 HOME = /admin 링크", st.asideHomeIsLink === true && st.asideHomeHref === "/admin");
      check("가로 오버플로 없음", st.hScroll === false);
    }
    await page.screenshot({ path: "claudedocs/home-button-members.png" });

    // 2) 헤더 홈 버튼 클릭 → /admin 이동
    {
      console.log("\n[header 홈 click → /admin]");
      await page.goto(`${adminBase}/admin/members`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(2000);
      await page.locator("header a", { hasText: "홈" }).click();
      await page.waitForURL("**/admin", { timeout: 30000 });
      check("홈 클릭 후 /admin 이동", new URL(page.url()).pathname === "/admin", page.url());
    }

    // 3) /admin HOME: 헤더 홈 버튼 미노출(early return) + 로그아웃 유지, 사이드바 HOME navLocked
    {
      console.log("\n[/admin HOME]");
      await page.waitForTimeout(2000);
      const st = (await page.evaluate(READ_STATE)) as Record<string, unknown>;
      check("HOME 헤더 홈 버튼 미노출", st.headerHomeVisible !== true);
      check("HOME 로그아웃 유지", st.headerHasLogout === true);
      check("HOME 사이드바 HOME 잠금(pointer-events none)", st.asideHomeLocked === true);
      await page.screenshot({ path: "claudedocs/home-button-admin-home.png" });
    }

    // 4) 사이드바 HOME 클릭 → /admin 이동
    {
      console.log("\n[sidebar HOME click → /admin]");
      await page.goto(`${adminBase}/admin/season-weeks`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(2000);
      await page.locator("aside a", { hasText: "HOME" }).first().click();
      await page.waitForURL("**/admin", { timeout: 30000 });
      check("사이드바 HOME 클릭 후 /admin 이동", new URL(page.url()).pathname === "/admin", page.url());
    }

    // 4.5) 홈 이동 시 nav open state 초기화 (새로고침 없는 클라이언트 네비게이션)
    {
      console.log("\n[홈 클릭 → 하위 카테고리 접힘]");
      // 주차와 시즌(자동 펼침) + 허브별 프로세스(수동 펼침) 두 분기를 연 상태로 만든다
      await page.goto(`${adminBase}/admin/season-weeks`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(2000);
      await page.locator('aside button[aria-controls="submenu-/admin/processes"]').click();
      await page.waitForTimeout(300);
      const openBefore = await page.locator('aside ul[id^="submenu-"]').count();
      check("홈 클릭 전 하위 카테고리 2개 이상 펼침", openBefore >= 2, `open=${openBefore}`);

      // 헤더 홈 버튼 클릭 → /admin (full reload 아님: 같은 클라이언트 세션에서 state 만 확인)
      await page.locator("header a", { hasText: "홈" }).click();
      await page.waitForURL("**/admin", { timeout: 30000 });
      await page.waitForTimeout(800);
      const openAfter = await page.locator('aside ul[id^="submenu-"]').count();
      const expandedAfter = await page
        .locator('aside button[aria-controls^="submenu-"][aria-expanded="true"]')
        .count();
      check("홈 이동 직후 모든 하위 카테고리 접힘", openAfter === 0, `open=${openAfter}`);
      check("모든 분기 aria-expanded=false", expandedAfter === 0, `expanded=${expandedAfter}`);
      await page.screenshot({ path: "claudedocs/home-button-collapsed.png" });

      // 다시 하위 페이지로 이동하면 해당 분기는 기존처럼 자동으로 펼쳐지고 active 표시 유지
      await page.goto(`${adminBase}/admin/season-weeks`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(2000);
      const reopened = await page
        .locator('aside ul[id="submenu-/admin/season-weeks"]')
        .count();
      const activeLink = await page
        .locator('aside a[aria-current="page"][href="/admin/season-weeks"]')
        .count();
      check("하위 페이지 재진입 시 해당 분기 자동 펼침", reopened === 1);
      check("현재 페이지 active 표시 유지", activeLink === 1);
    }

    // 5) 새로고침 후에도 정상 표시
    {
      console.log("\n[reload /admin/members]");
      await page.goto(`${adminBase}/admin/members`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(2000);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);
      const st = (await page.evaluate(READ_STATE)) as Record<string, unknown>;
      check("새로고침 후 홈 버튼 노출", st.headerHomeVisible === true);
      check("새로고침 후 로그아웃 유지", st.headerHasLogout === true);
    }

    // 6) 모바일 폭(390px): 홈 버튼 노출 + 깨짐 없음
    //    사이드바 펼침(w-60) 상태의 390px 는 본문 자체가 ~150px 로 무너지는 기존 한계 상태라
    //    (헤더 포함 페이지 전체가 변경 전부터 오버플로) 겹침 없음만 확인하고,
    //    실사용 모바일 상태인 사이드바 접힘에서 오버플로 없음을 검증한다.
    {
      console.log("\n[mobile 390px /admin/members]");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${adminBase}/admin/members`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(2500);
      const st = (await page.evaluate(READ_STATE)) as Record<string, unknown>;
      check("모바일 홈 버튼 노출", st.headerHomeVisible === true);
      check("모바일 로그아웃 유지", st.headerHasLogout === true);
      check("모바일 홈/로그아웃 겹침 없음", st.homeOverlapsLogout === false);

      // 사이드바 접기 → 실사용 모바일 레이아웃
      await page.locator('aside button[aria-label="사이드바 접기"]').click();
      await page.waitForTimeout(800);
      const headerOk = (await page.evaluate(`(() => {
        const header = document.querySelector("header");
        if (!header) return null;
        const r = header.getBoundingClientRect();
        const children = [...header.querySelectorAll("h1, a, button, span")];
        const overflow = children.some((c) => {
          const b = c.getBoundingClientRect();
          if (b.width === 0 && b.height === 0) return false; // display:none(의도적 숨김) 제외
          return b.right > r.right + 1 || b.left < r.left - 1;
        });
        return { overflow };
      })()`)) as { overflow: boolean } | null;
      const st2 = (await page.evaluate(READ_STATE)) as Record<string, unknown>;
      check("모바일(사이드바 접힘) 홈 버튼 노출", st2.headerHomeVisible === true);
      check("모바일(사이드바 접힘) 헤더 요소 오버플로 없음", !!headerOk && !headerOk.overflow);
      check("모바일(사이드바 접힘) 가로 스크롤 없음", st2.hScroll === false);
      await page.screenshot({ path: "claudedocs/home-button-mobile.png" });
      // 다음 실행을 위해 사이드바 상태 복원
      await page.locator('aside button[aria-label="사이드바 펴기"]').click();
      await page.waitForTimeout(300);
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

/**
 * 사이드바 최하단 로그아웃 버튼 브라우저 검증.
 *   1) 로그인 후 /admin HOME: 사이드바에 로그아웃 버튼 노출 + 클릭 가능(메뉴는 잠김 유지)
 *      + 버튼이 사이드바 최하단에 고정(바닥 근접) + HOME 헤더는 여전히 빈 상태
 *   2) 하위 페이지(/admin/members): 사이드바 로그아웃 노출, 헤더에는 로그아웃 중복 없음
 *      (개발자 표시 버튼은 유지)
 *   3) HOME 에서 로그아웃 클릭 → /login 이동
 *   4) 로그아웃 후 /admin 접근 → /login 리다이렉트 (세션 종료 확인)
 *   사전조건: admin dev :3000.
 *   npx tsx scripts/verify-sidebar-logout-browser.ts
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

// aside 바닥에서 로그아웃 버튼 상태를 수집
const readLogoutState = () => {
  const aside = document.querySelector("aside");
  const btns = [...(aside?.querySelectorAll("button") ?? [])];
  const logout = btns.find((b) => b.textContent?.includes("로그아웃")) as
    | HTMLButtonElement
    | undefined;
  if (!aside || !logout) return null;
  const a = aside.getBoundingClientRect();
  const r = logout.getBoundingClientRect();
  return {
    disabled: logout.disabled,
    pe: getComputedStyle(logout).pointerEvents,
    insideNav: !!logout.closest("nav"),
    gapToAsideBottom: Math.round(a.bottom - r.bottom),
  };
};

async function main() {
  // Turbopack dev + headless-shell 즉사 이슈 → channel chromium 사용 (카페 크롤러와 동일)
  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const cookies = await makeAdminCookies();
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await ctx.addCookies(
      cookies.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" })),
    );
    const page = await ctx.newPage();

    // 1) HOME: 로그아웃 노출 + 클릭 가능 + 최하단 고정, 메뉴는 잠김 유지
    {
      console.log("\n[1] /admin HOME 사이드바 로그아웃");
      await page.goto(`${adminBase}/admin`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(3000);
      const st = await page.evaluate(readLogoutState);
      check("로그아웃 버튼 노출", !!st);
      check("클릭 가능(disabled 아님, pointer-events 정상)", !!st && !st.disabled && st.pe !== "none", JSON.stringify(st));
      check("nav 외부(잠금 영향 없음)", !!st && !st.insideNav);
      check("사이드바 최하단 고정(바닥 30px 이내)", !!st && st.gapToAsideBottom >= 0 && st.gapToAsideBottom <= 30, `gap=${st?.gapToAsideBottom}px`);
      const navState = await page.evaluate(() => {
        const links = [...document.querySelectorAll("aside nav a")];
        return links.length > 0 && links.every((l) => l.getAttribute("aria-disabled") === "true");
      });
      check("메뉴 잠금 유지(aria-disabled)", navState);
      const headerText = await page.evaluate(
        () => document.querySelector("header")?.innerText?.trim() ?? "(no header)",
      );
      check("HOME 헤더 여전히 빈 상태", headerText === "", `"${headerText}"`);
      await page.screenshot({ path: "claudedocs/sidebar-logout-home.png", fullPage: true });
    }

    // 2) 하위 페이지: 사이드바 로그아웃 1개, 헤더에는 중복 없음
    {
      console.log("\n[2] /admin/members 중복 제거 확인");
      await page.goto(`${adminBase}/admin/members`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(3000);
      const st = await page.evaluate(readLogoutState);
      check("사이드바 로그아웃 노출", !!st && !st.disabled);
      // tsx 변환 __name 헬퍼 이슈 회피: evaluate 는 문자열로 전달
      const counts = (await page.evaluate(`(() => ({
        header: [...(document.querySelector("header")?.querySelectorAll("button") ?? [])]
          .filter((b) => (b.textContent || "").includes("로그아웃")).length,
        page: [...document.body.querySelectorAll("button")]
          .filter((b) => (b.textContent || "").includes("로그아웃")).length,
        devToggle: (document.querySelector("header")?.textContent || "").includes("개발자 표시"),
      }))()`)) as { header: number; page: number; devToggle: boolean };
      check("헤더에 로그아웃 없음(중복 제거)", counts.header === 0, `header=${counts.header}`);
      check("페이지 전체 로그아웃 버튼 1개", counts.page === 1, `total=${counts.page}`);
      check("헤더 개발자 표시 버튼 유지", counts.devToggle);
      await page.screenshot({ path: "claudedocs/sidebar-logout-subpage.png" });
    }

    // 3) HOME 에서 로그아웃 클릭 → /login
    {
      console.log("\n[3] HOME 로그아웃 클릭 → /login 이동");
      await page.goto(`${adminBase}/admin`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(3000);
      await page.locator("aside button", { hasText: "로그아웃" }).click();
      await page.waitForURL("**/login**", { timeout: 30000 });
      check("로그아웃 후 /login 이동", page.url().includes("/login"), page.url());
      await page.screenshot({ path: "claudedocs/sidebar-logout-after.png" });
    }

    // 4) 세션 종료 확인: /admin 재접근 → /login
    {
      console.log("\n[4] 세션 종료 확인");
      await page.goto(`${adminBase}/admin`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(2000);
      check("로그아웃 후 /admin → /login 리다이렉트", page.url().includes("/login"), page.url());
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

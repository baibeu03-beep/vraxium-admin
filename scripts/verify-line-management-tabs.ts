/**
 * 라인 관리 통합 탭 + 라인 정보 탭 개편 검증 (2026-06-27).
 *   npx tsx --env-file=.env.local scripts/verify-line-management-tabs.ts
 * 검증 항목:
 *   1) /admin/lines/register 직접 접근 → "라인 관리" 헤더 + 탭 순서 [라인 정보, 라인 등록] + 기본=라인 정보 active
 *   2) /admin/lines/info 직접 접근도 기본=라인 정보 active (기존 URL 유지)
 *   3) ?tab=register → 라인 등록 탭 active + 등록 폼 노출
 *   4) 탭 href 가 ?tab 토글 + ?org 보존
 *   5) 라인 정보 탭: 상단 통계(전체 허브/전체 라인) + 표 컬럼 순서 + career 제외 + 유닛 버튼
 * 사전 조건: dev 서버(3000) 기동.
 */
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

function ensureEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}
const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
const serviceKey = ensureEnv("SUPABASE_SERVICE_ROLE_KEY");
const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (ok) pass++;
  else fail++;
}

async function makeCookies() {
  const admin = createClient(supabaseUrl, serviceKey);
  const browser = createClient(supabaseUrl, anonKey);
  const { data: l, error: le } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: adminEmail,
  });
  if (le || !l?.properties?.email_otp) throw new Error(le?.message ?? "generateLink failed");
  const { data: v, error: ve } = await browser.auth.verifyOtp({
    email: adminEmail,
    token: l.properties.email_otp,
    type: "magiclink",
  });
  if (ve || !v.session) throw new Error(ve?.message ?? "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [],
      setAll: (items) => captured.push(...items.map((i) => ({ name: i.name, value: i.value }))),
    },
  });
  await server.auth.setSession(v.session);
  return captured;
}

async function tabInfo(page: import("playwright-core").Page) {
  return page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="페이지 탭"]');
    const heading = document.querySelector("h1")?.textContent?.trim() ?? null;
    const tabs = nav
      ? Array.from(nav.querySelectorAll("a")).map((a) => ({
          text: (a.textContent || "").trim(),
          href: a.getAttribute("href"),
          active: a.getAttribute("aria-current") === "page",
        }))
      : [];
    return { heading, tabs };
  });
}

async function main() {
  const cookies = await makeCookies();
  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const ctx = await browser.newContext();
    const url = new URL(baseUrl);
    await ctx.addCookies(
      cookies.map((c) => ({ name: c.name, value: c.value, domain: url.hostname, path: "/" })),
    );
    const page = await ctx.newPage();

    // 1) /admin/lines/register → 기본 라인 정보 탭
    const r1 = await page.goto(`${baseUrl}/admin/lines/register`, { waitUntil: "networkidle" });
    check("register: HTTP 200", r1?.status() === 200, String(r1?.status()));
    const t1 = await tabInfo(page);
    check("register: 헤더 '라인 관리'", t1.heading === "라인 관리", t1.heading ?? "(none)");
    check(
      "register: 탭 순서 [라인 정보, 라인 등록]",
      t1.tabs.length === 2 && t1.tabs[0].text === "라인 정보" && t1.tabs[1].text === "라인 등록",
      JSON.stringify(t1.tabs.map((t) => t.text)),
    );
    check("register: 기본 활성 탭 = 라인 정보", t1.tabs[0]?.active === true);
    check(
      "register: 탭 href ?tab 토글",
      t1.tabs[0]?.href === "/admin/lines/register" &&
        t1.tabs[1]?.href === "/admin/lines/register?tab=register",
      JSON.stringify(t1.tabs.map((t) => t.href)),
    );

    // 라인 정보 탭 내용: 통계 + 표 컬럼 + 유닛
    const infoView = await page.evaluate(() => {
      const text = document.body.innerText;
      const tbodyText = (document.querySelector("table tbody") as HTMLElement)?.innerText || "";
      const rowCount = document.querySelectorAll("table tbody tr").length;
      const headers = Array.from(document.querySelectorAll("table thead th")).map((th) =>
        (th.textContent || "").trim(),
      );
      const unitButtons = Array.from(document.querySelectorAll("table tbody a, table tbody button")).filter(
        (el) => (el.textContent || "").trim() === "유닛",
      ).length;
      return {
        hasHubStat: text.includes("전체 허브 갯수"),
        hasLineStat: text.includes("전체 라인 갯수"),
        headers,
        unitButtons,
        rowCount,
        // career 제외는 표 본문 기준(사이드바의 "라인 개설 [실무 경력]" 메뉴 텍스트와 구분).
        careerInTable: tbodyText.includes("실무 경력"),
      };
    });
    check("info: 통계 '전체 허브 갯수'", infoView.hasHubStat);
    check("info: 통계 '전체 라인 갯수'", infoView.hasLineStat);
    check(
      "info: 표 컬럼 순서",
      JSON.stringify(infoView.headers) ===
        JSON.stringify([
          "적용 클럽",
          "라인 코드",
          "라인명",
          "소속 허브",
          "라인 종류",
          "메인 타이틀 내용",
          "유닛",
        ]),
      JSON.stringify(infoView.headers),
    );
    check("info: career(실무 경력) 표 제외", infoView.careerInTable === false);
    check(
      "info: 행마다 유닛 컨트롤 존재",
      infoView.rowCount > 0 && infoView.unitButtons === infoView.rowCount,
      `행 ${infoView.rowCount} / 유닛 ${infoView.unitButtons}`,
    );
    // 유닛 링크가 실제로 새 탭 anchor(target=_blank)로 열리는 것은 별도 라운드트립
    // (scripts 임시 검증: 링크 보유 라인 생성→anchor href/target 확인→삭제)으로 입증됨.
    // 현재 등록 데이터는 unit_link 가 모두 '-' 라 라이브 화면에선 비활성 버튼이 정상.

    // 2) /admin/lines/info 직접 접근도 기본=라인 정보
    const r2 = await page.goto(`${baseUrl}/admin/lines/info`, { waitUntil: "networkidle" });
    check("info route: HTTP 200", r2?.status() === 200, String(r2?.status()));
    const t2 = await tabInfo(page);
    check("info route: 기본 활성 탭 = 라인 정보", t2.tabs[0]?.active === true);

    // 3) ?tab=register → 라인 등록 탭 + 폼
    const r3 = await page.goto(`${baseUrl}/admin/lines/register?tab=register`, {
      waitUntil: "networkidle",
    });
    check("register tab: HTTP 200", r3?.status() === 200, String(r3?.status()));
    const t3 = await tabInfo(page);
    check("register tab: 라인 등록 active", t3.tabs[1]?.active === true);
    const hasForm = await page.evaluate(() =>
      document.body.innerText.includes("소속 허브") &&
      Array.from(document.querySelectorAll("button")).some(
        (b) => (b.textContent || "").includes("등록"),
      ),
    );
    check("register tab: 등록 폼 노출", hasForm);

    // 4) ?org 보존
    const r4 = await page.goto(`${baseUrl}/admin/lines/register?org=encre`, {
      waitUntil: "networkidle",
    });
    check("?org: HTTP 200", r4?.status() === 200, String(r4?.status()));
    const t4 = await tabInfo(page);
    check(
      "?org: 탭 href 에 org 보존",
      t4.tabs.every((t) => (t.href ?? "").includes("org=encre")),
      JSON.stringify(t4.tabs.map((t) => t.href)),
    );
  } finally {
    await browser.close();
  }
  console.log(`\n  결과: ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

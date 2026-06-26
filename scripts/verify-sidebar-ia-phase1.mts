/**
 * Sidebar IA 개편 Phase 1 브라우저 검증
 *  1) 통합 검수 시스템(/admin/members)에서 신규 8개 대분류 구조 노출
 *  2) 기존 기능 메뉴 클릭 시 기존 화면 정상 진입
 *  3) 기존 URL 직접 접속 유지 (HTTP 200)
 *  4) placeholder 메뉴 → "추후 구현 예정" 화면
 *  5) 조직별 페이지(/admin/crews/encre)에서 허브별 라인 개설 메뉴 유지
 *  6) 통합 모드에서 허브별 라인 개설 메뉴 숨김
 *
 *   사전조건: dev 서버 (http://localhost:3000).
 *   npx tsx --env-file=.env.local scripts/verify-sidebar-ia-phase1.mts
 */
import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// playwright 는 admin repo 에 미설치 — 인접 고객 repo(../vraxium) 설치본을 재사용.
const requireFromFront = createRequire(
  new URL("../../vraxium/package.json", import.meta.url),
);
const { chromium } = requireFromFront("playwright") as typeof import("playwright");

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const VIEWPORT = { width: 1280, height: 900 };

function ensureEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function makeAdminCookies() {
  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const serviceRoleKey = ensureEnv("SUPABASE_SERVICE_ROLE_KEY");
  const admin = createClient(supabaseUrl, serviceRoleKey);
  const browser = createClient(supabaseUrl, anonKey);
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: adminEmail,
  });
  if (linkError || !linkData?.properties?.email_otp) {
    throw new Error(linkError?.message ?? "Failed to generate admin magic link");
  }
  const { data: verifyData, error: verifyError } = await browser.auth.verifyOtp({
    email: adminEmail,
    token: linkData.properties.email_otp,
    type: "magiclink",
  });
  if (verifyError || !verifyData.session) {
    throw new Error(verifyError?.message ?? "Failed to verify admin OTP");
  }
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll() {
        return [];
      },
      setAll(items) {
        captured.push(...items.map((i) => ({ name: i.name, value: i.value })));
      },
    },
  });
  const { error: setError } = await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  if (setError) throw new Error(setError.message);
  return captured.map((i) => ({
    name: i.name,
    value: i.value,
    domain: "localhost",
    path: "/",
  }));
}

type Page = import("playwright").Page;

async function expandAllBranches(page: Page) {
  // 접힌 branch 를 모두 펼친다 (최대 20회 안전 루프).
  for (let i = 0; i < 20; i++) {
    const btn = page.locator('nav button[aria-expanded="false"]').first();
    if ((await btn.count()) === 0) break;
    await btn.click();
    await page.waitForTimeout(80);
  }
}

async function collectNav(page: Page) {
  await expandAllBranches(page);
  const branches = (await page.evaluate(
    "Array.from(document.querySelectorAll('nav button[aria-expanded]')).map(b => (b.textContent||'').trim())",
  )) as string[];
  const links = (await page.evaluate(
    "Array.from(document.querySelectorAll('nav a')).map(a => ({ text: (a.textContent||'').trim(), href: a.getAttribute('href') }))",
  )) as Array<{ text: string; href: string | null }>;
  return { branches, links };
}

const EXPECTED_BRANCHES = [
  "주차와 시즌",
  "허브와 라인",
  "허브별 프로세스",
  "클럽 정보",
  "클럽 진행",
  "크루 활동",
  "크루 온보딩",
  "어드민 관리",
];

// 통합 모드 기대 매핑 (label → href)
const EXPECTED_INTEGRATED: Array<[string, string]> = [
  ["대시보드", "/admin"],
  ["기간 등록", "/admin/periods/register"],
  ["기간 정보", "/admin/season-weeks"],
  ["주차 인정 결과", "/admin/week-recognitions"],
  ["라인 등록", "/admin/lines/register"],
  ["라인 정보", "/admin/line-opening/line-history"],
  ["라인 개설 [실무 경력]", "/admin/line-opening/practical-career"],
  ["프로세스 등록", "/admin/processes/register"],
  ["프로세스 정보", "/admin/processes/info"],
  ["프로세스 체크 [실무 경력]", "/admin/processes/check"],
  ["팀 내역", "/admin/team-parts/info"],
  ["팀 & 파트 등록", "/admin/team-parts/register"],
  ["주차 내역", "/admin/club-progress/weekly"],
  ["시즌 내역", "/admin/club-progress/seasons"],
  ["크루 관리", "/admin/members"],
  ["휴식 관리", "/admin/rest-management"],
  ["시즌 참여/휴식", "/admin/season-participations"],
  ["공식 휴식 관리", "/admin/official-rest-periods"],
  ["커뮤니케이션", "/admin/communications"],
  ["크루 등록", "/admin/users/applicants"],
  ["어드민 계정", "/admin/settings/accounts"],
  ["작성 기간 관리", "/admin/settings/edit-windows"],
  ["권한 설정", "/admin/settings/permissions"],
  ["운영 정합성 점검", "/admin/operation-health-check"],
  ["테스트 모드", "/admin/test-users"],
  ["가져오기", "/admin/import"],
];

// 기존 URL 직접 접속 유지 확인 대상 (대표 set)
const LEGACY_URLS = [
  "/admin/members",
  "/admin/season-weeks",
  "/admin/week-recognitions",
  "/admin/season-participations",
  "/admin/official-rest-periods",
  "/admin/operation-health-check",
  "/admin/line-opening/practical-info",
  "/admin/line-opening/practical-experience",
  "/admin/line-opening/practical-competency",
  "/admin/line-opening/practical-career",
  "/admin/line-opening/line-history",
  "/admin/career-projects",
  "/admin/settings/accounts",
  "/admin/settings/edit-windows",
  "/admin/settings/permissions",
  "/admin/users/applicants",
  "/admin/test-users",
  "/admin/import",
  "/admin/crews/encre",
];

const PLACEHOLDER_URLS = [
  "/admin/periods/register",
  "/admin/lines/register",
  "/admin/processes/register",
  "/admin/processes/info",
  "/admin/processes/check",
  "/admin/team-parts/info",
  "/admin/team-parts/register",
  "/admin/club-progress/weekly",
  "/admin/club-progress/seasons",
  "/admin/rest-management",
  "/admin/communications",
];

async function main() {
  const cookies = await makeAdminCookies();
  const browser = await chromium.launch({ channel: "chromium" });

  try {
    const ctx = await browser.newContext({ baseURL: baseUrl, viewport: VIEWPORT });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();

    // ── 1) 통합 모드: 신규 8개 대분류 + 매핑 ─────────────────────────────
    await page.goto("/admin/members", { waitUntil: "networkidle" });
    const integrated = await collectNav(page);
    for (const label of EXPECTED_BRANCHES) {
      check(`통합: 대분류 '${label}' 노출`, integrated.branches.includes(label));
    }
    for (const old of ["멤버 관리", "라인 개설", "운영 관리", "데이터 관리"]) {
      check(
        `통합: 구 대분류 '${old}' 미노출`,
        !integrated.branches.includes(old),
      );
    }
    for (const [label, href] of EXPECTED_INTEGRATED) {
      check(
        `통합: '${label}' → ${href}`,
        integrated.links.some((l) => l.text === label && l.href === href),
      );
    }
    // 허브별 라인 개설 메뉴 숨김 (practical-career 는 '라인 개설 [실무 경력]'으로만 1회)
    for (const hidden of [
      "/admin/line-opening/practical-info",
      "/admin/line-opening/practical-experience",
      "/admin/line-opening/practical-competency",
    ]) {
      check(
        `통합: 허브별 메뉴 숨김 (${hidden})`,
        !integrated.links.some((l) => l.href === hidden),
      );
    }
    check(
      "통합: practical-career 링크 1개(중복 없음)",
      integrated.links.filter((l) => l.href === "/admin/line-opening/practical-career").length === 1,
    );
    check(
      "통합: 조직 크루 링크(/admin/crews/*) 미노출",
      !integrated.links.some((l) => l.href?.startsWith("/admin/crews/")),
    );
    await page.screenshot({
      path: "claudedocs/browser-sidebar-ia-integrated.png",
      fullPage: false,
    });

    // ── 2) 기존 기능 메뉴 클릭 → 기존 화면 ───────────────────────────────
    await page.getByRole("link", { name: "기간 정보", exact: true }).click();
    await page.waitForURL("**/admin/season-weeks", { timeout: 15000 });
    await page.waitForLoadState("networkidle");
    const seasonWeeksBody = (await page.evaluate("document.body.innerText")) as string;
    check(
      "클릭: 기간 정보 → /admin/season-weeks 기존 화면",
      /시즌|주차/.test(seasonWeeksBody) && !seasonWeeksBody.includes("추후 구현 예정"),
    );

    await expandAllBranches(page);
    await page.getByRole("link", { name: "크루 등록", exact: true }).click();
    await page.waitForURL("**/admin/users/applicants", { timeout: 15000 });
    await page.waitForLoadState("networkidle");
    check("클릭: 크루 등록 → /admin/users/applicants", page.url().includes("/admin/users/applicants"));

    await expandAllBranches(page);
    await page.getByRole("link", { name: "어드민 계정", exact: true }).click();
    await page.waitForURL("**/admin/settings/accounts", { timeout: 15000 });
    check("클릭: 어드민 계정 → /admin/settings/accounts", page.url().includes("/admin/settings/accounts"));

    // ── 3) placeholder 메뉴 클릭 ────────────────────────────────────────
    await expandAllBranches(page);
    await page.getByRole("link", { name: "기간 등록", exact: true }).click();
    await page.waitForURL("**/admin/periods/register", { timeout: 15000 });
    await page.waitForLoadState("networkidle");
    const placeholderBody = (await page.evaluate("document.body.innerText")) as string;
    check(
      "클릭: 기간 등록 → placeholder('추후 구현 예정')",
      placeholderBody.includes("추후 구현 예정"),
    );
    await page.screenshot({ path: "claudedocs/browser-sidebar-ia-placeholder.png" });

    // ── 4) placeholder 전 라우트 직접 접속 ──────────────────────────────
    for (const url of PLACEHOLDER_URLS) {
      const resp = await page.goto(url, { waitUntil: "networkidle" });
      const body = (await page.evaluate("document.body.innerText")) as string;
      check(
        `placeholder 직접 접속: ${url}`,
        resp?.status() === 200 && body.includes("추후 구현 예정"),
        `status=${resp?.status()}`,
      );
    }

    // ── 5) 기존 URL 직접 접속 유지 ──────────────────────────────────────
    for (const url of LEGACY_URLS) {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded" });
      check(`기존 URL 유지: ${url}`, resp?.status() === 200, `status=${resp?.status()}`);
    }

    // ── 6) 조직별 페이지: 허브별 라인 개설 메뉴 유지 ─────────────────────
    await page.goto("/admin/crews/encre", { waitUntil: "networkidle" });
    const org = await collectNav(page);
    for (const [label, href] of [
      ["실무 정보", "/admin/line-opening/practical-info"],
      ["실무 경험", "/admin/line-opening/practical-experience"],
      ["실무 역량", "/admin/line-opening/practical-competency"],
      ["실무 경력", "/admin/line-opening/practical-career"],
    ] as Array<[string, string]>) {
      check(
        `조직(encre): 허브별 '${label}' → ${href} 유지`,
        org.links.some((l) => l.text === label && l.href === href),
      );
    }
    check(
      "조직(encre): '라인 개설 [실무 경력]' 라벨 미노출(실무 경력으로 대체)",
      !org.links.some((l) => l.text === "라인 개설 [실무 경력]"),
    );
    check(
      "조직(encre): 전체 멤버(/admin/members) 링크 숨김",
      !org.links.some((l) => l.href === "/admin/members"),
    );
    check(
      "조직(encre): 크루 관리 (Encre) → /admin/crews/encre",
      org.links.some((l) => l.href === "/admin/crews/encre"),
    );
    check(
      "조직(encre): 타 조직 링크 숨김",
      !org.links.some(
        (l) => l.href === "/admin/crews/oranke" || l.href === "/admin/crews/phalanx",
      ),
    );
    for (const label of EXPECTED_BRANCHES) {
      check(`조직(encre): 대분류 '${label}' 노출`, org.branches.includes(label));
    }
    await page.screenshot({
      path: "claudedocs/browser-sidebar-ia-org-encre.png",
      fullPage: false,
    });

    await ctx.close();
  } finally {
    await browser.close();
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

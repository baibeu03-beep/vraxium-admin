// 검증(브라우저) — 실무 경험 [라인 개설] 파트장 입력 그리드의 테스트 팀/파트 스코프.
//   /admin/line-opening/practical-experience?org=oranke&tab=open
//   1) 테스트 팀 탭(콘텐츠실험(T)) → 그리드 크루 = 전원 test_user_markers(이름 'T…').
//   2) 운영 팀 탭(첫 비-(T) 팀) → 그리드 크루에 test_user_markers 0명.
//   read-only(저장/개설 버튼 미클릭). snapshot 무접촉.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL"),
  ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE),
  brow = createClient(URL_, ANON);
const EMAIL = "vanuatu.golden@gmail.com",
  ORG = "oranke",
  TEST_TEAM = "콘텐츠실험(T)";

let pass = 0,
  fail = 0;
const ck = (l, ok, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({
  email: EMAIL,
  token: link.properties.email_otp,
  type: "magiclink",
});
const cap = [];
const srv = createServerClient(URL_, ANON, {
  cookies: { getAll: () => [], setAll: (i) => cap.push(...i) },
});
await srv.auth.setSession({
  access_token: v.session.access_token,
  refresh_token: v.session.refresh_token,
});
const cookies = cap.map((i) => ({
  name: i.name,
  value: i.value,
  domain: "localhost",
  path: "/",
  httpOnly: false,
  secure: false,
  sameSite: "Lax",
}));

// 권위 있는 테스트 마커 user_id 집합 + display_name 맵(이름 교차검증).
const { data: markerRows } = await sb.from("test_user_markers").select("user_id");
const testIds = new Set((markerRows ?? []).map((m) => m.user_id));
const { data: profRows } = await sb
  .from("user_profiles")
  .select("user_id,display_name")
  .in("user_id", [...testIds]);
const testNames = new Set((profRows ?? []).map((p) => (p.display_name ?? "").trim()));

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 2200 } });
await context.addCookies(cookies);
const page = await context.newPage();

// 파트 그리드(헤더에 '크루 상태' 포함된 테이블)의 첫 컬럼(이름) 목록.
const readGridNames = () =>
  page.evaluate(() => {
    const tables = [...document.querySelectorAll("table")];
    const grid = tables.find((t) =>
      [...t.querySelectorAll("thead th")].some((th) => (th.textContent || "").trim() === "크루 상태"),
    );
    if (!grid) return null;
    return [...grid.querySelectorAll("tbody tr")]
      .map((tr) => tr.querySelector("td")?.textContent?.trim() ?? "")
      .filter((s) => s && s !== "이 파트에 평가 대상 크루가 없습니다.");
  });

async function selectTeamTab(teamName) {
  const clicked = await page.evaluate((name) => {
    const btn = [...document.querySelectorAll("button")].find(
      (b) => (b.textContent || "").trim() === name,
    );
    if (!btn) return false;
    btn.click();
    return true;
  }, teamName);
  await page.waitForTimeout(1500); // parts + grid 재조회 대기.
  return clicked;
}

try {
  await page.goto(`${BASE}/admin/line-opening/practical-experience?org=${ORG}&tab=open`, {
    waitUntil: "domcontentloaded",
  });
  // 파트장 입력 카드(팀 탭) 로드 대기 — 테스트 팀 탭 버튼 등장.
  await page.waitForFunction(
    (name) => [...document.querySelectorAll("button")].some((b) => (b.textContent || "").trim() === name),
    TEST_TEAM,
    { timeout: 30000 },
  );
  ck("[UI] 테스트 팀 탭 노출(콘텐츠실험(T))", true);

  // ── 1) 테스트 팀 → 그리드 크루 전원 테스트 계정 ──
  const okTab = await selectTeamTab(TEST_TEAM);
  ck("[1] 테스트 팀 탭 클릭", okTab);
  // 그리드 등장 대기.
  await page
    .waitForFunction(() => {
      const tables = [...document.querySelectorAll("table")];
      return tables.some((t) =>
        [...t.querySelectorAll("thead th")].some((th) => (th.textContent || "").trim() === "크루 상태"),
      );
    }, undefined, { timeout: 20000 })
    .catch(() => {});
  const testTeamNames = (await readGridNames()) ?? [];
  const nonTestInTestTeam = testTeamNames.filter((n) => !testNames.has(n));
  ck(
    "[1] 테스트 팀 그리드 크루 = 전원 test_user_markers",
    testTeamNames.length > 0 && nonTestInTestTeam.length === 0,
    `크루=${testTeamNames.length} 비테스트=${JSON.stringify(nonTestInTestTeam)} 예시=${JSON.stringify(testTeamNames.slice(0, 3))}`,
  );

  await page.screenshot({
    path: resolve(adminRoot, "claudedocs", "browser-experience-test-scope-testteam.png"),
    fullPage: true,
  });

  // ── 2) 운영 팀 → 그리드 크루에 테스트 계정 0명 ──
  // org 활성 팀 중 첫 비-(T) 팀.
  const { data: teamRows } = await sb
    .from("cluster4_teams")
    .select("team_name")
    .eq("organization_slug", ORG)
    .eq("is_active", true)
    .order("team_name");
  const opTeam = (teamRows ?? [])
    .map((r) => r.team_name)
    .find((name) => !/\(T\)$/.test(name));
  ck("[2] 운영 팀 존재", Boolean(opTeam), String(opTeam));
  if (opTeam) {
    const okOp = await selectTeamTab(opTeam);
    ck(`[2] 운영 팀 탭 클릭(${opTeam})`, okOp);
    await page
      .waitForFunction(() => {
        const tables = [...document.querySelectorAll("table")];
        return tables.some((t) =>
          [...t.querySelectorAll("thead th")].some((th) => (th.textContent || "").trim() === "크루 상태"),
        );
      }, undefined, { timeout: 20000 })
      .catch(() => {});
    const opNames = (await readGridNames()) ?? [];
    const testInOpTeam = opNames.filter((n) => testNames.has(n));
    ck(
      `[2] 운영 팀(${opTeam}) 그리드에 test_user_markers 0명`,
      testInOpTeam.length === 0,
      `크루=${opNames.length} 테스트혼입=${JSON.stringify(testInOpTeam)}`,
    );
    await page.screenshot({
      path: resolve(adminRoot, "claudedocs", "browser-experience-test-scope-opteam.png"),
      fullPage: true,
    });
  }

  console.log("  screenshots → claudedocs/browser-experience-test-scope-{testteam,opteam}.png");
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
  try {
    await page.screenshot({
      path: resolve(adminRoot, "claudedocs", "browser-experience-test-scope-error.png"),
      fullPage: true,
    });
  } catch {}
} finally {
  await browser.close();
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

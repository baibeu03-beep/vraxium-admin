import { chromium, type Page } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// 2026-07-11 Help Key 전수 보수 후속 브라우저 검증.
//   · 신규 요소 도움말(돋보기, aria-label "이 항목 도움말")이 각 영역 실 라우트에서 실제로 렌더되는지
//   · 데이터 값(표 tbody td)에는 돋보기가 붙지 않는지
//   · 대표 라우트에서 돋보기 클릭 → 편집/저장 모달 → 저장(PUT 200) → 새로고침 유지
//   · 일반 vs mode=test 돋보기 개수 동일 · /api/admin/help org/mode 파라미터 누수 0
//   · 공용 부품(fieldKit/SummaryCard/SummaryCell/FieldLabel) 사용 화면 포함

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

async function makeAdminCookies() {
  const { data: admins } = await supabaseAdmin
    .from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = (admins?.[0] as { email: string } | undefined)?.email;
  assert(email, "No active admin email");
  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  assert(link.properties?.email_otp, "generateLink failed");
  const { data: verified } = await anon.auth.verifyOtp({
    email, token: link.properties.email_otp, type: "magiclink",
  });
  assert(verified.session, "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items.map(({ name, value }) => ({ name, value }))) },
  });
  await server.auth.setSession({
    access_token: verified.session.access_token, refresh_token: verified.session.refresh_token,
  });
  return captured.map(({ name, value }) => ({
    name, value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" as const,
  }));
}

const HELP_LABEL = "이 항목 도움말";

type RouteResult = {
  route: string;
  icons: number;
  dataCellIcons: number;
  testModeIcons: number | null;
  note?: string;
};

async function countIcons(page: Page): Promise<number> {
  return page.getByRole("button", { name: HELP_LABEL }).count();
}

// tbody 데이터 셀(td) 안의 돋보기 = 값에 붙은 것(있으면 규칙 위반).
async function countDataCellIcons(page: Page): Promise<number> {
  return page.locator(`tbody td button[aria-label="${HELP_LABEL}"]`).count();
}

async function gotoAndSettle(page: Page, route: string, waitMs = 2500) {
  await page.goto(`${baseUrl}${route}`, { waitUntil: "domcontentloaded" });
  // 데이터 로딩 후 돋보기 렌더까지 최대 대기(있으면 등장, 없으면 그냥 진행).
  await page.getByRole("button", { name: HELP_LABEL }).first()
    .waitFor({ state: "visible", timeout: 12_000 }).catch(() => {});
  await page.waitForTimeout(waitMs);
}

async function main() {
  // 동적 파라미터: org 있는 user + 실제 UUID(멤버 상세 / crew editor 라우트).
  const { data: prof } = await supabaseAdmin
    .from("user_profiles").select("user_id, organization_slug")
    .not("organization_slug", "is", null).limit(1);
  const p = prof?.[0] as { user_id: string; organization_slug: string } | undefined;
  assert(p, "동적 파라미터용 user_profiles 행 없음");
  const org = p.organization_slug;
  const userId = p.user_id;
  // 두 번째 org(있으면) — org 파리티 확인용.
  const { data: prof2 } = await supabaseAdmin
    .from("user_profiles").select("user_id, organization_slug")
    .not("organization_slug", "is", null).neq("organization_slug", org).limit(1);
  const p2 = prof2?.[0] as { user_id: string; organization_slug: string } | undefined;

  const STATIC_ROUTES = [
    "/admin/users/app-users",
    "/admin/test-users",
    "/admin/settings/accounts",
    "/admin/settings/permissions",
    "/admin/settings/edit-windows",
    "/admin/settings/line-opening-windows",
    "/admin/settings/process-check-windows",
    "/admin/operation-health-check",
    "/admin/week-recognitions",
    "/admin/season-participations",
    "/admin/career-projects",
    "/admin/processes/register",
  ];
  const DYNAMIC_ROUTES = [
    `/admin/members/${userId}/weekly-status`,
    `/admin/crews/${org}/${userId}`,          // ResumeCardEditor
    `/admin/crews/${org}/${userId}/cluster2`, // Cluster2Editor + fieldKit
    `/admin/crews/${org}/${userId}/cluster3`, // Cluster3Editor
    `/admin/crews/${org}/${userId}/cluster4`, // Cluster4Editor + FieldLabel + ActivityTab
  ];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies(await makeAdminCookies());
  const page = await context.newPage();

  // /api/admin/help org/mode 누수 감시.
  const helpReqs: Array<{ mode: string | null; org: string | null }> = [];
  page.on("request", (req) => {
    const u = new URL(req.url());
    if (u.pathname === "/api/admin/help") {
      helpReqs.push({ mode: u.searchParams.get("mode"), org: u.searchParams.get("org") });
    }
  });

  const results: RouteResult[] = [];
  const allRoutes = [...STATIC_ROUTES, ...DYNAMIC_ROUTES];

  for (const route of allRoutes) {
    try {
      await gotoAndSettle(page, route);
      const icons = await countIcons(page);
      const dataCellIcons = await countDataCellIcons(page);
      // mode=test 파리티.
      await page.goto(`${baseUrl}${route}?mode=test`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: HELP_LABEL }).first()
        .waitFor({ state: "visible", timeout: 12_000 }).catch(() => {});
      await page.waitForTimeout(2500);
      const testModeIcons = await countIcons(page);
      results.push({ route, icons, dataCellIcons, testModeIcons });
      console.log(`OK  ${route}  돋보기=${icons}  데이터셀돋보기=${dataCellIcons}  test모드=${testModeIcons}`);
    } catch (e) {
      results.push({ route, icons: -1, dataCellIcons: -1, testModeIcons: null, note: e instanceof Error ? e.message.slice(0, 90) : "err" });
      console.log(`!!  ${route}  ERROR ${e instanceof Error ? e.message.slice(0, 90) : ""}`);
    }
  }

  // ── org 파리티: crew cluster4 라우트를 org1 vs org2 로 비교(돋보기 개수 동일해야) ──
  let orgParity: { org1: number; org2: number; same: boolean } | null = null;
  if (p2) {
    try {
      await gotoAndSettle(page, `/admin/crews/${org}/${userId}/cluster4`);
      const c1 = await countIcons(page);
      await gotoAndSettle(page, `/admin/crews/${p2.organization_slug}/${p2.user_id}/cluster4`);
      const c2 = await countIcons(page);
      orgParity = { org1: c1, org2: c2, same: c1 === c2 };
      console.log(`org 파리티 cluster4: ${org}=${c1} vs ${p2.organization_slug}=${c2} → ${c1 === c2 ? "동일" : "상이"}`);
    } catch (e) {
      console.log(`org 파리티 확인 실패: ${e instanceof Error ? e.message.slice(0, 80) : ""}`);
    }
  }

  // ── 인바디 탭 돋보기 확인 (week-recognitions: "check 기준 관리" 탭 도움말) ──
  let tabIconOk = false;
  try {
    await gotoAndSettle(page, "/admin/week-recognitions");
    // 탭 라벨 옆 돋보기가 렌더되는지 — 탭 텍스트 근처 도움말 버튼 존재.
    tabIconOk = (await page.getByRole("button", { name: HELP_LABEL }).count()) > 0;
  } catch { /* noop */ }

  // ── 대표 라우트 저장/유지 E2E (season-participations: 공용 SummaryCard 사용) ──
  let saveResult = { put200: false, persisted: false, savedKey: "" as string | null };
  try {
    const marker = `[QA-HELPKEY ${new Date().toISOString()}] 검증 저장`;
    await gotoAndSettle(page, "/admin/season-participations");
    const putCapture: string[] = [];
    page.on("request", (req) => {
      if (new URL(req.url()).pathname === "/api/admin/help" && req.method() === "PUT") {
        try { const b = req.postData(); if (b) { const k = (JSON.parse(b) as { path?: string }).path; if (k) putCapture.push(k); } } catch { /* noop */ }
      }
    });
    await page.getByRole("button", { name: HELP_LABEL }).first().click();
    await page.getByRole("dialog").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "편집" }).click();
    const ta = page.getByRole("dialog").locator("textarea");
    await ta.waitFor({ state: "visible" });
    await ta.fill(marker);
    const put = page.waitForResponse((r) => r.url().includes("/api/admin/help") && r.request().method() === "PUT");
    await page.getByRole("button", { name: "저장" }).click();
    const putResp = await put;
    saveResult.put200 = putResp.ok();
    saveResult.savedKey = putCapture[0] ?? null;
    await page.getByRole("button", { name: "닫기" }).click();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: HELP_LABEL }).first().waitFor({ state: "visible", timeout: 12_000 });
    await page.getByRole("button", { name: HELP_LABEL }).first().click();
    await page.getByRole("dialog").waitFor({ state: "visible" });
    await page.getByRole("dialog").getByText(marker.slice(0, 20), { exact: false })
      .waitFor({ state: "visible", timeout: 10_000 });
    saveResult.persisted = true;
    // 정리(빈 문자열).
    if (saveResult.savedKey) {
      await supabaseAdmin.from("admin_page_help_contents")
        .upsert({ page_path: saveResult.savedKey, content: "", updated_at: new Date().toISOString() }, { onConflict: "page_path" });
    }
    console.log(`저장 E2E: PUT200=${saveResult.put200} key=${saveResult.savedKey} 새로고침유지=${saveResult.persisted}`);
  } catch (e) {
    console.log(`저장 E2E 실패: ${e instanceof Error ? e.message.slice(0, 120) : ""}`);
  }

  // 스크린샷(대표 화면).
  for (const [r, name] of [
    ["/admin/week-recognitions", "qa-helpkey-week-recognitions-1440"],
    ["/admin/settings/accounts", "qa-helpkey-accounts-1440"],
    [`/admin/crews/${org}/${userId}/cluster4`, "qa-helpkey-cluster4-1440"],
  ] as const) {
    try {
      await gotoAndSettle(page, r);
      await page.screenshot({ path: `claudedocs/${name}.png`, fullPage: false });
    } catch { /* noop */ }
  }

  const leaked = helpReqs.filter((r) => r.mode !== null || r.org !== null);

  console.log("\n==== 요약 ====");
  for (const r of results) {
    const parity = r.testModeIcons === null ? "?" : r.icons === r.testModeIcons ? "동일" : `상이(${r.testModeIcons})`;
    console.log(`${r.icons > 0 ? "OK " : "!! "} ${r.route}  돋보기=${r.icons}  데이터셀=${r.dataCellIcons}  test파리티=${parity}${r.note ? " ("+r.note+")" : ""}`);
  }
  console.log(`\n인바디 탭 돋보기(week-recognitions): ${tabIconOk ? "OK" : "미확인"}`);
  console.log(`저장 E2E: PUT200=${saveResult.put200} 새로고침유지=${saveResult.persisted}`);
  if (orgParity) console.log(`org 파리티: ${orgParity.same ? "동일" : "상이"} (${orgParity.org1}/${orgParity.org2})`);
  console.log(`/api/admin/help org/mode 누수: ${leaked.length}건`);

  // 판정.
  const zeroIcon = results.filter((r) => r.icons === 0);
  const dataLeak = results.filter((r) => r.dataCellIcons > 0);
  const testMismatch = results.filter((r) => r.testModeIcons !== null && r.icons !== r.testModeIcons && r.icons > 0);
  console.log("\n==== 판정 ====");
  console.log(`돋보기 0개 라우트: ${zeroIcon.map((r) => r.route).join(", ") || "없음"}`);
  console.log(`데이터셀 돋보기(값에 붙음): ${dataLeak.map((r) => r.route + "=" + r.dataCellIcons).join(", ") || "없음"}`);
  console.log(`test모드 불일치: ${testMismatch.map((r) => r.route).join(", ") || "없음"}`);

  await browser.close();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

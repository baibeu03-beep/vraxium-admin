import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// 모든 /admin/* 페이지에 페이지 단위 [? 도움말](AdminHelp) 버튼이 "정확히 1개" 있는지 브라우저로 전수 검증.
//   · 버튼 로케이터 = [data-admin-help-trigger="page"](안정 속성). 접근명은 "안내 있음" 등으로 바뀔 수 있어
//     이름 기반 대신 이 속성으로 특정한다. 요소 돋보기(AdminHelpIconButton)엔 이 속성이 없다.
//   · notFound(feature-off) 2곳은 0개 기대. redirect 3곳은 목적지 버튼을 이어받아 1개.
//   · 대표 신규 페이지 1곳에서 저장→새로고침 유지→org/mode 파라미터 무 까지 확인.

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

async function main() {
  // 동적 파라미터: userId/org 는 DB, crew legacyId/weekId 는 실제 목록 페이지 링크에서 추출(스키마 추측 회피).
  const { data: prof } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id, organization_slug")
    .not("organization_slug", "is", null)
    .limit(1);
  const p = prof?.[0] as { user_id: string; organization_slug: string } | undefined;
  assert(p, "동적 파라미터용 user_profiles 행을 찾지 못함");
  const org = p.organization_slug;
  // 같은 org 의 실제 user_id = 멤버상세 userId 이자 [legacy_user_id] 라우트 값(실제 UUID).
  const { data: orgUsers } = await supabaseAdmin
    .from("user_profiles").select("user_id").eq("organization_slug", org).limit(1);
  const anyUser = (orgUsers?.[0] as { user_id: string } | undefined)?.user_id ?? p.user_id;
  let legacyId = anyUser;
  const { data: wkRows } = await supabaseAdmin.from("weeks").select("id").limit(1);
  let weekId = (wkRows?.[0] as { id: string } | undefined)?.id ?? "";

  const STATIC: string[] = [
    "/admin", "/admin/dashboard", "/admin/members", "/admin/crews",
    "/admin/season-weeks", "/admin/season-participations", "/admin/official-rest-periods",
    "/admin/operation-health-check", "/admin/week-recognitions", "/admin/test-users",
    "/admin/import", "/admin/communications", "/admin/rest-management", "/admin/settings",
    "/admin/settings/accounts", "/admin/settings/edit-windows", "/admin/settings/permissions",
    "/admin/settings/line-opening-windows", "/admin/settings/process-check-windows",
    "/admin/career-projects", "/admin/periods/register", "/admin/lines/info", "/admin/lines/register",
    "/admin/line-opening/practical-career", "/admin/line-opening/practical-competency",
    "/admin/line-opening/practical-experience", "/admin/line-opening/practical-info",
    "/admin/processes/info", "/admin/processes/register", "/admin/processes/check",
    "/admin/processes/check/club", "/admin/processes/check/competency", "/admin/processes/check/experience",
    "/admin/processes/check/info", "/admin/processes/check/irregular",
    "/admin/team-parts/info", "/admin/team-parts/info/weeks", "/admin/team-parts/info/seasons",
    "/admin/team-parts/register", "/admin/club-progress/weekly", "/admin/club-progress/seasons",
    "/admin/users/app-users", "/admin/users/applicants",
    // redirect(목적지에 버튼 존재)
    "/admin/users", "/admin/applicants", "/admin/users/admin-users",
  ];
  const EXPECT_ZERO: string[] = [
    "/admin/weekly-card-finalization",
    "/admin/line-opening/line-history",
  ];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies(await makeAdminCookies());
  const page = await context.newPage();

  const helpBtn = () => page.locator('[data-admin-help-trigger="page"]');
  const results: Array<{ route: string; count: number; ok: boolean; note?: string }> = [];

  const listUser = anyUser;
  const DYNAMIC: string[] = [
    `/admin/members/${listUser}`,
    `/admin/members/${listUser}/weekly-status`,
    `/admin/crews/${org}`,
    ...(legacyId
      ? [
          `/admin/crews/${org}/${legacyId}`,
          `/admin/crews/${org}/${legacyId}/cluster2`,
          `/admin/crews/${org}/${legacyId}/cluster3`,
          `/admin/crews/${org}/${legacyId}/cluster4`,
        ]
      : []),
    ...(weekId
      ? [`/admin/team-parts/info/weeks/${weekId}`, `/admin/club-progress/weekly/${weekId}`]
      : []),
  ];
  console.log(`동적 파라미터: userId=${listUser.slice(0, 8)}… org=${org} legacyId=${legacyId || "(없음)"} weekId=${weekId || "(없음)"}`);

  async function countAt(route: string, expect: "one" | "zero") {
    try {
      await page.goto(`${baseUrl}${route}`, { waitUntil: "domcontentloaded" });
      if (expect === "one") {
        // 데이터 로딩 후에야 헤더(버튼)가 렌더되는 페이지가 많다 — 버튼 등장까지 최대 10s 대기.
        await helpBtn().first().waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
      } else {
        await page.waitForTimeout(1200);
      }
      const count = await helpBtn().count();
      const ok = expect === "one" ? count === 1 : count === 0;
      results.push({ route, count, ok, note: expect === "zero" ? "expect0(notFound)" : undefined });
    } catch (e) {
      results.push({ route, count: -1, ok: false, note: e instanceof Error ? e.message.slice(0, 80) : "err" });
    }
  }

  try {
    for (const r of STATIC) await countAt(r, "one");
    for (const r of DYNAMIC) await countAt(r, "one");
    for (const r of EXPECT_ZERO) await countAt(r, "zero");

    // ── 대표 신규 페이지 저장/유지/중립 확인 (/admin/import — 이번에 추가) ──
    const helpReqs: Array<{ mode: string | null; org: string | null; path: string | null }> = [];
    page.on("request", (req) => {
      const u = new URL(req.url());
      if (u.pathname === "/api/admin/help") {
        let bp: string | null = null;
        try { bp = req.postData() ? (JSON.parse(req.postData()!) as { path?: string }).path ?? null : null; } catch { bp = null; }
        helpReqs.push({ mode: u.searchParams.get("mode"), org: u.searchParams.get("org"), path: u.searchParams.get("path") ?? bp });
      }
    });
    const marker = `[QA-PAGEHELP ${new Date().toISOString()}] import 페이지 도움말 저장 검증`;
    await page.goto(`${baseUrl}/admin/import`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(700);
    await helpBtn().click();
    await page.getByRole("dialog").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "편집" }).click();
    const ta = page.getByRole("dialog").locator("textarea");
    await ta.waitFor({ state: "visible" });
    await ta.fill(marker);
    const put = page.waitForResponse((r) => r.url().includes("/api/admin/help") && r.request().method() === "PUT");
    await page.getByRole("button", { name: "저장" }).click();
    const putResp = await put;
    assert(putResp.ok(), `저장 PUT 실패 ${putResp.status()}`);
    const savedKey = helpReqs.find((r) => r.path)?.path;
    await page.getByRole("button", { name: "닫기" }).click();
    // 새로고침 후 유지
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(700);
    const getAgain = page.waitForResponse((r) => r.url().includes("/api/admin/help") && r.request().method() === "GET");
    await helpBtn().click();
    await page.getByRole("dialog").waitFor({ state: "visible" });
    await getAgain;
    await page.getByRole("dialog").getByText(marker.slice(0, 24), { exact: false }).waitFor({ state: "visible", timeout: 10_000 });
    const leaked = helpReqs.filter((r) => r.mode !== null || r.org !== null);

    // 정리(빈 문자열).
    if (savedKey) {
      await supabaseAdmin.from("admin_page_help_contents")
        .upsert({ page_path: savedKey, content: "", updated_at: new Date().toISOString() }, { onConflict: "page_path" });
    }

    // ── 리포트 ──
    const bad = results.filter((r) => !r.ok);
    const dup = results.filter((r) => r.count > 1);
    console.log("\n==== 커버리지 결과 ====");
    for (const r of results) {
      console.log(`${r.ok ? "OK " : "!! "} count=${r.count}  ${r.route}${r.note ? "  (" + r.note + ")" : ""}`);
    }
    console.log("\n==== 저장/유지/중립 ====");
    console.log(`저장 PUT 200 (key=${savedKey})`);
    console.log("새로고침 후 저장 내용 유지: OK");
    console.log(`/api/admin/help org/mode 파라미터 누수: ${leaked.length}건`);

    const total = results.length;
    const okCount = results.filter((r) => r.ok).length;
    console.log(`\n요약: ${okCount}/${total} 라우트 기대치 충족 · 중복(>1) ${dup.length}건 · org/mode 누수 ${leaked.length}건`);
    assert(bad.length === 0, `기대 불충족 라우트: ${bad.map((b) => `${b.route}(=${b.count})`).join(", ")}`);
    assert(dup.length === 0, `중복 버튼 라우트: ${dup.map((b) => b.route).join(", ")}`);
    assert(leaked.length === 0, "org/mode 파라미터 누수");
    console.log("\nALL PASS");
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

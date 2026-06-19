import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ADMIN_MODE_STORAGE_KEY } from "@/lib/userScopeShared";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function makeAdminCookies() {
  const { data: admins, error: adminError } = await supabaseAdmin
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  if (adminError) throw adminError;
  const email = (admins?.[0] as { email: string } | undefined)?.email;
  assert(email, "No active admin email");

  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  assert(link.properties?.email_otp && !linkError, linkError?.message ?? "generateLink failed");
  const { data: verified, error: verifyError } = await anon.auth.verifyOtp({
    email,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  assert(verified.session && !verifyError, verifyError?.message ?? "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [],
      setAll: (items) =>
        captured.push(...items.map(({ name, value }) => ({ name, value }))),
    },
  });
  await server.auth.setSession({
    access_token: verified.session.access_token,
    refresh_token: verified.session.refresh_token,
  });
  return captured.map(({ name, value }) => ({
    name,
    value,
    domain: "localhost",
    path: "/",
    httpOnly: false,
    secure: false,
    sameSite: "Lax" as const,
  }));
}

async function openSidebarBranch(page: import("playwright-core").Page, basePath: string) {
  const button = page.locator(`button[aria-controls="submenu-${basePath}"]`);
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
}

async function clickSidebarLink(
  page: import("playwright-core").Page,
  basePath: string,
  targetPath: string,
) {
  await openSidebarBranch(page, basePath);
  const link = page.locator(`a[href^="${targetPath}"]`).first();
  await link.click();
  await page.waitForURL((url) => url.pathname === targetPath);
  await page.waitForLoadState("domcontentloaded");
}

async function main() {
  const { data: markers, error: markerError } = await supabaseAdmin
    .from("test_user_markers")
    .select("user_id")
    .limit(100);
  if (markerError) throw markerError;
  const testIds = (markers ?? []).map((row) => row.user_id as string);
  const { data: profiles, error: profileError } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name")
    .in("user_id", testIds)
    .not("display_name", "is", null)
    .limit(20);
  if (profileError) throw profileError;
  assert(profiles?.length, "No named test profile");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies(await makeAdminCookies());
  const page = await context.newPage();
  const adminRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/admin/")) adminRequests.push(url.toString());
  });

  try {
    await page.goto(`${baseUrl}/admin/users/applicants?mode=test`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(1200);
    assert(new URL(page.url()).searchParams.get("mode") === "test", "applicants lost mode=test");
    assert(
      (await page.evaluate((key) => localStorage.getItem(key), ADMIN_MODE_STORAGE_KEY)) === "test",
      "URL mode=test was not persisted",
    );

    await clickSidebarLink(page, "/admin/members", "/admin/members");
    assert(new URL(page.url()).searchParams.get("mode") === "test", "members lost mode=test");
    await page.waitForTimeout(500);

    const row = page.locator("tbody tr").filter({ has: page.locator("button") }).first();
    await row.waitFor({ state: "visible", timeout: 30_000 }).catch(() => undefined);
    if ((await row.count()) === 0) {
      console.error("members page:", page.url());
      console.error((await page.locator("body").innerText()).slice(0, 4000));
      console.error("admin requests:", adminRequests.slice(-20));
    }
    assert((await row.count()) > 0, "No test member row available for list/detail browser flow");
    await row.locator("button").last().click();
    await page.waitForURL((url) => /^\/admin\/members\/[^/]+$/.test(url.pathname));
    const detailUserId = new URL(page.url()).pathname.split("/").at(-1);
    assert(detailUserId && testIds.includes(detailUserId), "members test list opened a non-test user");
    assert(new URL(page.url()).searchParams.get("mode") === "test", "member detail lost mode=test");
    await page.waitForTimeout(1200);
    await page.locator(".grid.sm\\:grid-cols-3 button").nth(2).click();
    const textarea = page.locator("textarea").last();
    await textarea.waitFor();
    const current = await textarea.inputValue();
    await textarea.fill(current);
    const saved = page.waitForResponse((response) =>
      response.url().includes(`/api/admin/members/${detailUserId}/note`),
    );
    await page
      .locator("textarea")
      .last()
      .locator("xpath=ancestor::div[contains(@class,'fixed')]//button")
      .last()
      .click();
    await saved;

    await page.goto(`${baseUrl}/admin/members`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);
    assert(new URL(page.url()).searchParams.get("mode") === "test", "stored test mode not restored");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);
    assert(new URL(page.url()).searchParams.get("mode") === "test", "refresh lost test mode");

    await clickSidebarLink(page, "/admin/processes", "/admin/processes/check");
    assert(new URL(page.url()).searchParams.get("mode") === "test", "process check lost mode=test");
    await page.waitForTimeout(1000);

    const testRequests = adminRequests.filter((url) => new URL(url).pathname.startsWith("/api/admin/"));
    assert(testRequests.length > 0, "No admin API requests captured");
    assert(
      testRequests.every((url) => new URL(url).searchParams.get("mode") === "test"),
      `Admin request without mode=test: ${testRequests.find((url) => new URL(url).searchParams.get("mode") !== "test")}`,
    );

    const toggle = page.locator("button.fixed.bottom-4.right-4");
    assert((await toggle.getAttribute("aria-pressed")) === "true", "test toggle is not ON");
    await toggle.click();
    await page.waitForTimeout(700);
    assert(new URL(page.url()).searchParams.get("mode") === null, "OFF did not switch to operating URL");
    assert(
      (await page.evaluate((key) => localStorage.getItem(key), ADMIN_MODE_STORAGE_KEY)) === "operating",
      "OFF did not persist operating mode",
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(700);
    assert(new URL(page.url()).searchParams.get("mode") === null, "operating refresh restored test mode");
    assert((await toggle.getAttribute("aria-pressed")) === "false", "operating toggle is not OFF");

    console.log("PASS browser mode=test URL priority and localStorage persistence");
    console.log("PASS applicants -> members -> detail/save -> processes/check mode continuity");
    console.log(`PASS ${testRequests.length} admin browser requests carried mode=test`);
    console.log("PASS refresh persistence and explicit OFF operating persistence");
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

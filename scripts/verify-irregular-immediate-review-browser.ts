/**
 * Browser verification for irregular "immediate review".
 *
 * It seeds one test-scope pending process_irregular_acts row, clicks the real
 * button in the browser, checks the actual HTTP response body, then verifies
 * DB/list/detail all show completed.
 *
 *   npx tsx --env-file=.env.local scripts/verify-irregular-immediate-review-browser.ts
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const getEnv = (key: string) => env.match(new RegExp(`^${key}=(.+)$`, "m"))?.[1]?.trim();

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const ORG = "encre";
const MODE = process.env.VERIFY_MODE === "operating" ? "operating" : "test";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const supabaseUrl = getEnv("NEXT_PUBLIC_SUPABASE_URL")!;
const anonKey = getEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY")!;
const serviceKey = getEnv("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

let pass = 0;
let fail = 0;
const ck = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

async function makeAdminCookies() {
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verified } = await anon.auth.verifyOtp({
    email: adminEmail,
    token: (link as any).properties.email_otp,
    type: "magiclink",
  });
  const captured: any[] = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: () => [], setAll: (items: any[]) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: (verified as any).session.access_token,
    refresh_token: (verified as any).session.refresh_token,
  });
  return captured.map((item) => ({
    name: item.name,
    value: item.value,
    domain: "localhost",
    path: "/",
    httpOnly: false,
    secure: false,
    sameSite: "Lax" as const,
  }));
}

async function main() {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
  await context.addCookies(await makeAdminCookies());
  const page = await context.newPage();
  let actId: string | null = null;

  try {
    await page.goto(`${BASE}/admin/processes/check/irregular?org=${ORG}&mode=${MODE}`, {
      waitUntil: "domcontentloaded",
    });
    const board = await page.evaluate(async (mode) => {
      const res = await fetch(`/api/admin/processes/check/irregular?org=encre&mode=${mode}`, {
        cache: "no-store",
      });
      return res.json();
    }, MODE);
    const weekId = board?.data?.week?.weekId ?? board?.data?.selectedWeekId ?? null;
    if (!weekId) {
      console.log("No test week available; skip");
      await browser.close();
      process.exit(0);
    }

    const adminRow =
      (await admin.from("admin_users").select("id,email").eq("email", adminEmail).maybeSingle()).data ??
      (await admin.from("admin_users").select("id,email").limit(1).maybeSingle()).data;
    if (!adminRow?.id) {
      console.log("No admin_users row available; skip");
      await browser.close();
      process.exit(0);
    }

    const actName = `ZZ-irr-row-${Date.now()}`;
    const future = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const inserted = await admin
      .from("process_irregular_acts")
      .insert({
        organization_slug: ORG,
        week_id: weekId,
        kind: "review_request",
        act_name: actName,
        applicant_admin_id: adminRow.id,
        applicant_admin_name: "Browser QA",
        crew_reaction: "all",
        point_a: 0,
        point_b: 0,
        point_c: 0,
        review_link: `https://cafe.naver.com/${actName}`,
        scheduled_check_at: future,
        status: "pending",
        scope_mode: MODE,
        attempt_count: 0,
      })
      .select("id")
      .single();
    if (inserted.error || !inserted.data) throw new Error(inserted.error?.message ?? "seed failed");
    actId = (inserted.data as { id: string }).id;

    await page.reload({ waitUntil: "domcontentloaded" });
    const row = page.locator("tr", { hasText: actName }).first();
    await row.waitFor({ state: "visible", timeout: 30_000 });
    const button = row.getByRole("button", { name: "즉시 검수" });
    await button.waitFor({ state: "visible", timeout: 15_000 });
    ck("[1] irregular pending row shows immediate-review button", true);

    const responsePromise = page.waitForResponse(
      (res) => res.url().includes("/api/admin/qa/run-now/process-check-row"),
      { timeout: 150_000 },
    );
    await button.click();
    await page.getByRole("alertdialog").getByRole("button", { name: "즉시 검수" }).click();
    const response = await responsePromise;
    const responseJson = await response.json().catch(() => ({}));
    ck("[2] HTTP 200", response.status() === 200, `status=${response.status()}`);
    ck(
      "[2b] HTTP body data.status=completed",
      responseJson?.data?.status === "completed" && responseJson?.data?.source === "irregular",
      JSON.stringify(responseJson?.data ?? null),
    );

    await page.reload({ waitUntil: "domcontentloaded" });
    const doneRow = page.locator("tr", { hasText: actName }).first();
    await doneRow.waitFor({ state: "visible", timeout: 30_000 });
    const rowText = await doneRow.innerText();
    const noButton = (await doneRow.getByRole("button", { name: "즉시 검수" }).count()) === 0;
    const dbRow = await admin.from("process_irregular_acts").select("status").eq("id", actId).maybeSingle();
    ck(
      "[3] list row completed, button gone, DB completed",
      rowText.includes("체크 완료") && noButton && (dbRow.data as any)?.status === "completed",
      `noButton=${noButton}/db=${(dbRow.data as any)?.status}`,
    );

    await doneRow.getByText("체크 완료").click();
    const detailCompleted = await page.getByText("체크 완료").count();
    const detailDoneTime = await page.getByText("완료 시점").count();
    ck("[4] detail modal shows completed status/history", detailCompleted > 0 && detailDoneTime > 0);
  } catch (error: any) {
    console.error(error?.stack ?? error?.message ?? error);
    fail++;
  } finally {
    if (actId) {
      await admin.from("process_check_review_recipients").delete().eq("ref_id", actId);
      await admin.from("process_point_awards").delete().eq("source", "irregular").eq("ref_id", actId);
      await admin.from("process_irregular_acts").delete().eq("id", actId);
    }
    await browser.close();
  }

  console.log(`\nResult: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

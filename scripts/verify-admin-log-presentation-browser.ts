import { mkdir } from "node:fs/promises";

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { chromium, type Page } from "playwright-core";

import { supabaseAdmin } from "../lib/supabaseAdmin";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const shotDir = "claudedocs/admin-log-presentation";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function makeAdminCookies() {
  const { data: admins, error } = await supabaseAdmin
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  if (error) throw error;
  const email = (admins?.[0] as { email?: string } | undefined)?.email;
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

async function inspectLogPresentation(page: Page, tag: string) {
  await page.getByText("로그창", { exact: true }).first().waitFor({
    state: "visible",
    timeout: 20_000,
  });
  await page.locator("[data-admin-log-timestamp]").first().waitFor({
    state: "visible",
    timeout: 20_000,
  });

  const tones = page.locator("[data-admin-log-tone]");
  const teams = page.locator('[data-admin-log-entity="team"]');
  const parts = page.locator('[data-admin-log-entity="part"]');
  const timestamps = page.locator("[data-admin-log-timestamp]");
  const toneCount = await tones.count();
  if (toneCount === 0) {
    const eventHtml = await page
      .getByText(/^(체크 신청|체크 완료|체크 취소|실행 취소)$/)
      .first()
      .evaluate((el) => el.outerHTML)
      .catch(() => "(event label not found)");
    throw new Error(`${tag}: common event label marker missing: ${eventHtml}`);
  }

  if (toneCount > 0) {
    const label = tones.first();
    const light = await label.evaluate((el) => {
      const s = getComputedStyle(el);
      return { color: s.color, background: s.backgroundColor, weight: s.fontWeight };
    });
    assert(Number(light.weight) >= 600, `${tag}: event label is not semibold`);
    assert(light.color !== light.background, `${tag}: event label contrast missing`);

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.waitForTimeout(100);
    const dark = await label.evaluate((el) => {
      const s = getComputedStyle(el);
      return { color: s.color, background: s.backgroundColor };
    });
    assert(
      light.color !== dark.color || light.background !== dark.background,
      `${tag}: dark mode style did not change`,
    );
  } else {
    await page.evaluate(() => document.documentElement.classList.add("dark"));
  }

  if ((await teams.count()) > 0 && (await parts.count()) > 0) {
    const teamStyle = await teams.first().evaluate((el) => getComputedStyle(el).backgroundColor);
    const partStyle = await parts.first().evaluate((el) => getComputedStyle(el).backgroundColor);
    assert(teamStyle !== partStyle, `${tag}: team and part styles are not distinct`);
  }
  assert(
    (await timestamps.count()) === 0 || (await timestamps.first().getAttribute("class"))?.includes("text-muted-foreground"),
    `${tag}: timestamp hierarchy missing`,
  );

  await page.screenshot({ path: `${shotDir}/${tag}-dark.png`, fullPage: true });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page.waitForTimeout(100);
  await page.screenshot({ path: `${shotDir}/${tag}-light.png`, fullPage: true });

  return {
    tones: toneCount,
    teams: await teams.count(),
    parts: await parts.count(),
    timestamps: await timestamps.count(),
  };
}

async function main() {
  await mkdir(shotDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies(await makeAdminCookies());
  const page = await context.newPage();
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  const createdAt = "2026-07-22T07:40:00.000Z";

  // 표시 전용 검증 fixture — GET 응답만 브라우저에서 대체하며 DB/API mutation은 수행하지 않는다.
  await page.route("**/api/admin/cluster4/experience/opening-logs**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: {
          logs: [
            {
              id: "exp-1",
              action: "reapply",
              periodLabel: "26년 여름 시즌 4주차",
              teamName: "비주얼랩(T)",
              partName: "무드",
              actorCrewStatus: "최고 관리자",
              actorName: "박동근",
              createdAt,
            },
            {
              id: "exp-2",
              action: "review_cancel",
              periodLabel: "26년 여름 시즌 4주차",
              teamName: "비주얼랩(T)",
              partName: "팀 총괄",
              actorCrewStatus: "에이전트",
              actorName: "관리자",
              createdAt,
            },
          ],
        },
      }),
    });
  });
  await page.route("**/api/admin/cluster4/opening-logs**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: {
          logs: [
            {
              id: "info-1",
              action: "open",
              activityTypeId: "fixture",
              activityLabel: "정보 라인",
              periodLabel: "26년 여름 시즌 4주차",
              actorName: "관리자",
              createdAt,
            },
            {
              id: "info-2",
              action: "close",
              activityTypeId: "fixture",
              activityLabel: "정보 라인",
              periodLabel: "26년 여름 시즌 4주차",
              actorName: "관리자",
              createdAt,
            },
          ],
        },
      }),
    });
  });
  await page.route("**/api/admin/cluster4/competency/opening-logs**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: {
          logs: [
            {
              id: "competency-1",
              action: "cancel",
              periodLabel: "26년 여름 시즌 4주차",
              actorName: "관리자",
              createdAt,
            },
          ],
        },
      }),
    });
  });
  await page.route("**/api/admin/processes/check**", async (route) => {
    const response = await route.fetch();
    const json = (await response.json()) as {
      success?: boolean;
      data?: { logs?: unknown[] };
    };
    const url = new URL(route.request().url());
    if (json.success && json.data && !url.searchParams.has("team")) {
      json.data.logs = [
        {
          id: "process-1",
          action: "check_requested",
          periodLabel: "26년 여름 시즌 4주차",
          teamName: url.searchParams.get("hub") === "experience" ? "비주얼랩(T)" : null,
          scopeType: url.searchParams.get("hub") === "experience" ? "PART" : null,
          partName: url.searchParams.get("hub") === "experience" ? "무드" : null,
          lineGroupName: "실무 경험 파트",
          actName: "주간 액트",
          actorName: "관리자",
          createdAt,
        },
        {
          id: "process-2",
          action: "check_rolled_back",
          periodLabel: "26년 여름 시즌 4주차",
          teamName: url.searchParams.get("hub") === "experience" ? "비주얼랩(T)" : null,
          scopeType: url.searchParams.get("hub") === "experience" ? "TEAM" : null,
          partName: null,
          lineGroupName: "실무 경험 총괄",
          actName: "총괄 액트",
          actorName: "관리자",
          createdAt,
        },
      ];
    }
    await route.fulfill({
      response,
      contentType: "application/json",
      body: JSON.stringify(json),
    });
  });

  const pages = [
    ["experience", "/admin/line-opening/practical-experience?org=encre&tab=open"],
    ["info", "/admin/line-opening/practical-info?org=encre&tab=open"],
    ["competency", "/admin/line-opening/practical-competency?org=encre&tab=open"],
    ["process-info", "/admin/processes/check/info?org=encre"],
    ["process-experience-test", "/admin/processes/check/experience?org=encre&mode=test"],
  ] as const;

  try {
    for (const [tag, path] of pages) {
      const response = await page.goto(`${baseUrl}${path}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      assert(response && response.status() < 400, `${tag}: HTTP ${response?.status()}`);
      assert(!page.url().includes("/login"), `${tag}: redirected to login`);
      const counts = await inspectLogPresentation(page, tag);
      console.log(`PASS ${tag}`, counts);
    }
    assert(failures.length === 0, failures.join("\n"));
  } finally {
    await page.unrouteAll({ behavior: "wait" }).catch(() => undefined);
    await browser.close();
  }
}

void main();

import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  LINE_OPENING_SHARED_MENU_ITEMS,
  MENU_INTEGRATED,
  MENU_ORG,
  PROCESS_CHECK_SHARED_MENU_ITEMS,
} from "@/lib/adminMenuTree";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

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

const pages = [
  ["line-opening/practical-info", "실무 정보"],
  ["line-opening/practical-experience", "실무 경험"],
  ["line-opening/practical-competency", "실무 역량"],
  ["processes/check/club", "클럽 총괄 급"],
  ["processes/check/info", "실무 정보 급"],
  ["processes/check/experience", "실무 경험 급"],
  ["processes/check/competency", "실무 역량 급"],
  ["processes/check/irregular", "변동 액트"],
] as const;
const scopes = [
  ["", "통합", "integrated"],
  ["org=encre", "엥크레", "encre"],
  ["org=oranke", "오랑캐", "oranke"],
  ["org=phalanx", "팔랑크스", "phalanx"],
] as const;

function dtoShape(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value && typeof value === "object") return Object.keys(value).sort().join(",");
  return typeof value;
}

function sourceFingerprint(value: unknown): string {
  const found: string[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (
        (/(^id$|_id$|Id$|organization)/.test(key) ||
          key === "teamName" ||
          key === "displayName") &&
        (typeof child === "string" || typeof child === "number")
      ) {
        found.push(`${key}:${String(child)}`);
      }
      visit(child);
    }
  };
  visit(value);
  return [...new Set(found)].sort().join("|");
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

async function main() {
  const integratedLine = MENU_INTEGRATED.find(
    (item) => item.kind === "branch" && item.label === "허브와 라인",
  );
  const integratedProcess = MENU_INTEGRATED.find(
    (item) => item.kind === "branch" && item.label === "허브별 프로세스",
  );
  const orgLine = MENU_ORG.find(
    (item) => item.kind === "branch" && item.label === "라인 개설",
  );
  const orgProcess = MENU_ORG.find(
    (item) => item.kind === "branch" && item.label === "프로세스 체크",
  );
  assert(integratedLine?.kind === "branch" && orgLine?.kind === "branch", "line menu missing");
  assert(
    integratedProcess?.kind === "branch" && orgProcess?.kind === "branch",
    "process menu missing",
  );
  const lineLabels = LINE_OPENING_SHARED_MENU_ITEMS.map((item) => item.label);
  const processLabels = PROCESS_CHECK_SHARED_MENU_ITEMS.map((item) => item.label);
  assert(
    JSON.stringify(integratedLine.children.slice(1, 1 + lineLabels.length).map((item) => item.label)) ===
      JSON.stringify(lineLabels) &&
      JSON.stringify(orgLine.children.map((item) => item.label)) === JSON.stringify(lineLabels),
    "line-opening menu label/order parity failed",
  );
  assert(
    JSON.stringify(integratedProcess.children.slice(1, 1 + processLabels.length).map((item) => item.label)) ===
      JSON.stringify(processLabels) &&
      JSON.stringify(orgProcess.children.map((item) => item.label)) === JSON.stringify(processLabels),
    "process-check menu label/order parity failed",
  );

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies(await makeAdminCookies());
  const page = await context.newPage();
  const failures: string[] = [];
  let businessRequests: string[] = [];
  const scopedRequestSignatures = new Map<string, string[]>();
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (
      pathname.startsWith("/api/admin/cluster4/") ||
      pathname.startsWith("/api/admin/processes/check")
    ) {
      businessRequests.push(request.url());
    }
  });

  try {
    for (const mode of ["", "mode=test"]) {
      for (const [route, pageLabel] of pages) {
        for (const [scopeQuery, scopeLabel, tab] of scopes) {
          const query = [mode, scopeQuery].filter(Boolean).join("&");
          const url = `${baseUrl}/admin/integrated/${route}${query ? `?${query}` : ""}`;
          // Unmount the previous organization page before measuring requests for the next URL.
          await page.goto("about:blank");
          businessRequests = [];
          const response = await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 60_000,
          });
          await page.waitForTimeout(3_000);
          const key = `${route} ${mode || "normal"} ${scopeLabel}`;
          if (!response || response.status() >= 400) failures.push(`${key}: HTTP ${response?.status()}`);
          if (page.url().includes("/login")) failures.push(`${key}: redirected to login`);
          const selected = page.locator(`[data-club-tab="${tab}"][aria-selected="true"]`);
          try {
            await selected.waitFor({ state: "visible", timeout: 10_000 });
          } catch {
            failures.push(`${key}: selected organization tab mismatch`);
          }
          const breadcrumb = await page.locator('nav[aria-label="현재 위치"]').innerText();
          if (!breadcrumb.includes(scopeLabel) || !breadcrumb.includes(pageLabel)) {
            failures.push(`${key}: breadcrumb mismatch (${breadcrumb})`);
          }
          const activeLink = page.locator(
            `aside a[aria-current="page"][href^="/admin/integrated/${route}"]`,
          );
          if ((await activeLink.count()) < 1) failures.push(`${key}: integrated sidebar active state mismatch`);
          if (tab === "integrated") {
            if ((await page.locator("[data-integrated-empty-content]").count()) !== 1) {
              failures.push(`${key}: integrated body is not empty`);
            }
            if ((await page.locator("[data-integrated-scoped-content]").count()) !== 0) {
              failures.push(`${key}: stale organization content remained`);
            }
            if (businessRequests.length > 0) {
              failures.push(`${key}: business API called (${businessRequests.join(", ")})`);
            }
          } else if ((await page.locator("[data-integrated-scoped-content]").count()) !== 1) {
            failures.push(`${key}: organization content was not rendered`);
          } else {
            const wrongScopedUrls = businessRequests.filter((requestUrl) => {
              const request = new URL(requestUrl);
              const requestOrg =
                request.searchParams.get("org") ??
                request.searchParams.get("organization");
              return requestOrg !== null && requestOrg !== tab;
            });
            if (wrongScopedUrls.length > 0) {
              failures.push(`${key}: wrong org in API (${wrongScopedUrls.join(", ")})`);
            }
            const orgScopedUrls = uniqueSorted(businessRequests
              .map((requestUrl) => {
                const request = new URL(requestUrl);
                const requestOrg =
                  request.searchParams.get("org") ??
                  request.searchParams.get("organization");
                request.searchParams.delete("mode");
                return requestOrg === tab
                  ? `${request.pathname}?${request.searchParams.toString()}`
                  : null;
              })
              .filter((value): value is string => value !== null));
            if (orgScopedUrls.length === 0) {
              failures.push(`${key}: no org-scoped business API request`);
            }
            scopedRequestSignatures.set(key, orgScopedUrls);
          }
        }
      }
    }

    await page.goto(`${baseUrl}/admin/integrated/line-opening/practical-info?mode=test&org=encre`);
    await page.getByRole("tab", { name: "오랑캐" }).click();
    await page.waitForURL((url) => url.searchParams.get("org") === "oranke");
    assert(page.url().includes("mode=test"), "organization switch dropped mode=test");
    await page.goBack();
    await page.waitForURL((url) => url.searchParams.get("org") === "encre");
    assert(new URL(page.url()).searchParams.get("org") === "encre", "browser back did not restore org");
    await page.goForward();
    await page.waitForURL((url) => url.searchParams.get("org") === "oranke");
    assert(new URL(page.url()).searchParams.get("org") === "oranke", "browser forward did not restore org");

    // Existing individual route and integrated route must issue the same scoped API URLs.
    for (const mode of ["", "mode=test"]) {
      for (const [route] of pages) {
        for (const [scopeQuery, scopeLabel, tab] of scopes.slice(1)) {
          await page.goto("about:blank");
          businessRequests = [];
          const query = [mode, scopeQuery].filter(Boolean).join("&");
          await page.goto(`${baseUrl}/admin/${route}?${query}`, {
            waitUntil: "domcontentloaded",
            timeout: 60_000,
          });
          await page.waitForTimeout(3_000);
          const individual = uniqueSorted(businessRequests
            .map((requestUrl) => {
              const request = new URL(requestUrl);
              const requestOrg =
                request.searchParams.get("org") ??
                request.searchParams.get("organization");
              request.searchParams.delete("mode");
              return requestOrg === tab
                ? `${request.pathname}?${request.searchParams.toString()}`
                : null;
            })
            .filter((value): value is string => value !== null));
          const key = `${route} ${mode || "normal"} ${scopeLabel}`;
          const integrated = scopedRequestSignatures.get(key) ?? [];
          const common = individual.filter((url) => integrated.includes(url));
          if (individual.length === 0 || integrated.length === 0 || common.length === 0) {
            failures.push(
              `${key}: individual/integrated did not share an org-scoped endpoint\nindividual=${JSON.stringify(individual)}\nintegrated=${JSON.stringify(integrated)}`,
            );
          }
        }
      }
    }

    const httpEndpoints = [
      {
        name: "cluster4-users",
        url: (org: string, mode: string) =>
          `/api/admin/cluster4/users?organization=${org}${mode ? "&mode=test" : ""}`,
      },
      {
        name: "cluster4-teams",
        url: (org: string, mode: string) =>
          `/api/admin/cluster4/teams?organization=${org}${mode ? "&mode=test" : ""}`,
      },
      {
        name: "cluster4-crews",
        url: (org: string, mode: string) =>
          `/api/admin/cluster4/crews?organization=${org}&status=active${mode ? "&mode=test" : ""}`,
      },
      {
        name: "process-check-club",
        url: (org: string, mode: string) =>
          `/api/admin/processes/check?hub=club&org=${org}${mode ? "&mode=test" : ""}`,
      },
      {
        name: "process-check-irregular",
        url: (org: string, mode: string) =>
          `/api/admin/processes/check/irregular?org=${org}${mode ? "&mode=test" : ""}`,
      },
    ];
    const httpSummary: Array<Record<string, string | number>> = [];
    let normalModeHasOrgDifference = false;
    for (const mode of ["", "mode=test"]) {
      for (const endpoint of httpEndpoints) {
        const rows = [];
        for (const org of ["encre", "oranke", "phalanx"]) {
          const response = await context.request.get(`${baseUrl}${endpoint.url(org, mode)}`);
          const json = await response.json();
          assert(response.ok() && json.success, `${endpoint.name} ${mode} ${org}: HTTP failure`);
          rows.push({
            org,
            shape: dtoShape(json.data),
            fingerprint: sourceFingerprint(json.data),
          });
        }
        assert(
          new Set(rows.map((row) => row.shape)).size === 1,
          `${endpoint.name} ${mode}: DTO shape differs by org`,
        );
        const distinct = new Set(rows.map((row) => row.fingerprint)).size;
        if (!mode && distinct > 1) normalModeHasOrgDifference = true;
        for (const row of rows) {
          httpSummary.push({
            endpoint: endpoint.name,
            mode: mode || "normal",
            org: row.org,
            dtoShape: row.shape,
            sourceIdentityFingerprint: fingerprint(row.fingerprint),
            sourceIdentityLength: row.fingerprint.length,
          });
        }
      }
    }
    assert(normalModeHasOrgDifference, "normal HTTP source identifiers are identical for every org");
    console.log(JSON.stringify(httpSummary, null, 2));
  } finally {
    await browser.close();
  }

  assert(failures.length === 0, failures.join("\n"));
  console.log(`PASS: ${pages.length * scopes.length * 2} integrated route/scope/mode combinations`);
}

void main();

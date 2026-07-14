import { chromium, type BrowserContext, type Page } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ADMIN_SHARED_HELP_KEYS } from "@/lib/adminSharedHelpKeys";

// /admin 공통(semantic) crew.* Help Key 공유 검증 (1차 A그룹).
//   공통 키(의미 동일한 대응 위치가 공유):
//     admin.shared.crew.name         (크루/회원 사람 이름 표 컬럼 — info/experience/career/seasonParticipations/testUsers/appUsers/weekRecognitions/editWindows)
//     admin.shared.crew.code         (크루 코드 13자리 — info cafe/crewEdit + competency manage)
//     admin.shared.crew.organization (크루 소속 클럽 표 컬럼·필터 — members/seasonParticipations/weekRecognitions/testUsers/appUsers/operationHealthCheck/editWindows/crews.manager/career detail)
//     admin.shared.crew.loginEmail   (로그인 계정 이메일 — accounts/testUsers/editWindows)
//   별도 유지(문구 비슷/같아도 의미 다름 — 전파되면 안 됨):
//     admin.settings.accounts.column.name      (관리자 계정 보유자 이름)
//     admin.users.appUsers.column.contactEmail (연락 이메일 contact_email)
//     admin.experience.manager.lines.column.org(라인의 클럽 — 크루 소속 아님)
//   검증:
//     1) 페이지 A(season-participations)에서 공통키 4종 저장(모달과 동일 PUT)
//     2) 페이지 B(test-users/app-users/members/edit-windows/line-opening)에서 "같은 공통키" GET = A 저장 내용
//     3) 별도 유지 키는 각자 값 유지(공통 내용 전파 없음)
//     4) mode=test 동일 · encre/oranke/phalanx 동일 · help 요청 org/mode 누수 없음
//   실행: npx tsx --env-file=.env.local scripts/verify-admin-shared-crew-help-keys.ts

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const K_NAME = ADMIN_SHARED_HELP_KEYS.crew.name;
const K_CODE = ADMIN_SHARED_HELP_KEYS.crew.code;
const K_ORG = ADMIN_SHARED_HELP_KEYS.crew.organization;
const K_EMAIL = ADMIN_SHARED_HELP_KEYS.crew.loginEmail;

// 별도 유지(전파 금지) 키 — 각자 고유 내용을 유지해야 한다.
const K_ADMIN_NAME = "admin.settings.accounts.column.name";
const K_CONTACT_EMAIL = "admin.users.appUsers.column.contactEmail";
const K_LINE_ORG = "admin.experience.manager.lines.column.org";

const stamp = Date.now();
const M_NAME = `[공통-이름 ${stamp}] 크루(회원)의 표시 이름 도움말.`;
const M_CODE = `[공통-코드 ${stamp}] 크루 코드 13자리 식별자 도움말.`;
const M_ORG = `[공통-클럽 ${stamp}] 크루가 소속된 클럽 도움말.`;
const M_EMAIL = `[공통-이메일 ${stamp}] 로그인 계정 이메일 도움말.`;
const D_ADMIN_NAME = "관리자-계정-이름-전용";
const D_CONTACT_EMAIL = "연락-이메일-전용";
const D_LINE_ORG = "라인-클럽-전용";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function makeAdminCookies() {
  const { data: admins } = await supabaseAdmin
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  const email = (admins?.[0] as { email: string } | undefined)?.email;
  assert(email, "No active admin email");
  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  assert(link.properties?.email_otp, "generateLink failed");
  const { data: verified } = await anon.auth.verifyOtp({
    email,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  assert(verified.session, "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
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

async function discoverOrgs(): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from("cluster4_team_halves")
    .select("organization_slug")
    .eq("is_active", true)
    .not("organization_slug", "is", null)
    .limit(50);
  const set = new Set<string>();
  for (const r of (data ?? []) as Array<{ organization_slug: string }>) set.add(r.organization_slug);
  const wanted = ["encre", "oranke", "phalanx"].filter((o) => set.has(o));
  return wanted.length ? wanted : [...set].slice(0, 3);
}

async function getHelp(page: Page, key: string): Promise<string> {
  return page.evaluate(async (k) => {
    const res = await fetch(`/api/admin/help?path=${encodeURIComponent(k)}`, { cache: "no-store" });
    const j = await res.json();
    return (j?.data?.content as string) ?? "";
  }, key);
}

async function savePut(page: Page, key: string, content: string) {
  const ok = await page.evaluate(
    async ({ k, c }) => {
      const res = await fetch("/api/admin/help", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: k, content: c }),
      });
      const j = await res.json();
      return res.ok && j?.success === true;
    },
    { k: key, c: content },
  );
  assert(ok, `저장 PUT 실패 (${key})`);
}

async function main() {
  // 시드: 공통키 비우고, 별도 유지 키에 고유값 세팅.
  await supabaseAdmin.from("admin_page_help_contents").upsert(
    [
      { page_path: K_NAME, content: "" },
      { page_path: K_CODE, content: "" },
      { page_path: K_ORG, content: "" },
      { page_path: K_EMAIL, content: "" },
      { page_path: K_ADMIN_NAME, content: D_ADMIN_NAME },
      { page_path: K_CONTACT_EMAIL, content: D_CONTACT_EMAIL },
      { page_path: K_LINE_ORG, content: D_LINE_ORG },
    ].map((r) => ({ ...r, updated_at: new Date().toISOString() })),
    { onConflict: "page_path" },
  );

  const orgs = await discoverOrgs();
  console.log(`[orgs] ${orgs.join(", ")}`);
  const browser = await chromium.launch({ headless: true });
  const cookies = await makeAdminCookies();
  async function ctxPage(): Promise<{ ctx: BrowserContext; page: Page }> {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await ctx.addCookies(cookies);
    return { ctx, page: await ctx.newPage() };
  }

  try {
    // ── 1) 페이지 A(season-participations)에서 공통키 4종 저장 + org/mode 누수 감시 ──
    {
      const { ctx, page } = await ctxPage();
      const leaked: string[] = [];
      page.on("request", (req) => {
        const u = new URL(req.url());
        if (
          u.pathname === "/api/admin/help" &&
          (u.searchParams.get("org") || u.searchParams.get("mode"))
        )
          leaked.push(req.url());
      });
      await page.goto(`${baseUrl}/admin/season-participations`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1200);
      await savePut(page, K_NAME, M_NAME);
      await savePut(page, K_CODE, M_CODE);
      await savePut(page, K_ORG, M_ORG);
      await savePut(page, K_EMAIL, M_EMAIL);
      console.log("\n[1] season-participations 에서 공통키 4종 저장 완료");
      check("A: 공통 name 재조회 반영", (await getHelp(page, K_NAME)) === M_NAME);
      check("A: 공통 organization 재조회 반영", (await getHelp(page, K_ORG)) === M_ORG);
      check("A: help 요청 org/mode 누수 없음", leaked.length === 0, leaked.slice(0, 2).join(","));
      await ctx.close();
    }

    // ── 2) 다른 페이지들에서 "같은 공통키" 조회 = A 저장 내용 ──────────────────
    const readPages: Array<{ path: string; keys: Array<[string, string, string]> }> = [
      {
        path: "/admin/test-users",
        keys: [
          [K_NAME, M_NAME, "name"],
          [K_ORG, M_ORG, "organization"],
          [K_EMAIL, M_EMAIL, "loginEmail"],
        ],
      },
      { path: "/admin/users/app-users", keys: [[K_NAME, M_NAME, "name"], [K_ORG, M_ORG, "organization"]] },
      { path: "/admin/members", keys: [[K_ORG, M_ORG, "organization"]] },
      {
        path: "/admin/settings/edit-windows",
        keys: [[K_NAME, M_NAME, "name"], [K_ORG, M_ORG, "organization"], [K_EMAIL, M_EMAIL, "loginEmail"]],
      },
      { path: "/admin/settings/accounts", keys: [[K_EMAIL, M_EMAIL, "loginEmail"]] },
      { path: "/admin/week-recognitions", keys: [[K_NAME, M_NAME, "name"], [K_ORG, M_ORG, "organization"]] },
      { path: "/admin/line-opening/practical-info", keys: [[K_CODE, M_CODE, "code"], [K_NAME, M_NAME, "name"]] },
      { path: "/admin/line-opening/practical-competency", keys: [[K_CODE, M_CODE, "code"]] },
    ];
    {
      const { ctx, page } = await ctxPage();
      console.log("\n[2] 다른 페이지에서 공통키 조회 = A 저장 내용");
      for (const rp of readPages) {
        await page.goto(`${baseUrl}${rp.path}`, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(900);
        for (const [k, expect, label] of rp.keys) {
          const got = await getHelp(page, k);
          check(`${rp.path} :: ${label}`, got === expect, got.slice(0, 30));
        }
      }
      await ctx.close();
    }

    // ── 3) 별도 유지 키는 공통 내용과 무관(전파 없음) ──────────────────────────
    {
      const { ctx, page } = await ctxPage();
      await page.goto(`${baseUrl}/admin/settings/accounts`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(800);
      const adminName = await getHelp(page, K_ADMIN_NAME);
      const contactEmail = await getHelp(page, K_CONTACT_EMAIL);
      const lineOrg = await getHelp(page, K_LINE_ORG);
      console.log("\n[3] 별도 유지 키 확인");
      check("관리자 계정 이름 ≠ 공통 name (별도 유지)", adminName === D_ADMIN_NAME && adminName !== M_NAME, adminName);
      check("연락 이메일 ≠ 공통 loginEmail (별도 유지)", contactEmail === D_CONTACT_EMAIL && contactEmail !== M_EMAIL, contactEmail);
      check("라인 클럽 ≠ 공통 organization (별도 유지)", lineOrg === D_LINE_ORG && lineOrg !== M_ORG, lineOrg);
      await ctx.close();
    }

    // ── 4) mode=test 동일 ──────────────────────────────────────────────────────
    {
      const { ctx, page } = await ctxPage();
      await page.goto(`${baseUrl}/admin/test-users?mode=test`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(900);
      check("mode=test: 공통 name = 일반 모드 내용", (await getHelp(page, K_NAME)) === M_NAME);
      check("mode=test: 공통 loginEmail = 일반 모드 내용", (await getHelp(page, K_EMAIL)) === M_EMAIL);
      await ctx.close();
    }

    // ── 5) org 변형(encre/oranke/phalanx) 동일 키·동일 내용 ───────────────────
    {
      const { ctx, page } = await ctxPage();
      for (const org of orgs) {
        await page.goto(`${baseUrl}/admin/season-participations?org=${encodeURIComponent(org)}`, {
          waitUntil: "domcontentloaded",
        });
        await page.waitForTimeout(900);
        check(`org=${org}: 공통 organization = 저장 내용`, (await getHelp(page, K_ORG)) === M_ORG);
      }
      await ctx.close();
    }

    console.log(`\n결과: ${pass} passed, ${fail} failed`);
  } finally {
    // cleanup: 공통키/별도키 비우기(별도키는 원래 빈 상태였음 — 감사 결과 저장 내용 없었음).
    await supabaseAdmin.from("admin_page_help_contents").upsert(
      [K_NAME, K_CODE, K_ORG, K_EMAIL, K_ADMIN_NAME, K_CONTACT_EMAIL, K_LINE_ORG].map((k) => ({
        page_path: k,
        content: "",
        updated_at: new Date().toISOString(),
      })),
      { onConflict: "page_path" },
    );
    await browser.close();
  }
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

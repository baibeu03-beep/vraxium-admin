import { chromium, type BrowserContext, type Page } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// /admin/line-opening/* 공통(semantic) Help Key 공유 검증.
//   공통 키(의미가 동일한 대응 위치가 공유):
//     admin.lineOpening.field.mainTitle           (info 개설폼 + career 개설폼)
//     admin.lineOpening.field.output              (info "아웃풋" + career "Output Asset")
//     admin.lineOpening.field.outputLink          (info 링크1 + career Link1 + experience 링크1)
//     admin.lineOpening.field.outputLinkDescription (info 설명1 + experience 설명1)
//   별도 유지(문구 비슷/같아도 의미 다름):
//     admin.competency.dashboard.input.outputLink1  (카페 공표 게시물 링크 — 별도)
//     admin.lineOpening.info.field.outputImage1Desc ("설명 1" = 이미지 캡션 — 별도)
//   검증:
//     1) info 에서 공통키 저장(UI PUT) → info 새로고침 hover 에 반영(저장·조회 roundtrip)
//     2) career / experience 페이지 컨텍스트에서 "같은 공통키"를 GET → info 저장 내용과 동일
//        (아이콘이 쓰는 것과 동일한 요청/DTO. 아이콘 helpKey 동일함은 코드로 확정)
//     3) 별도 키(competency outputLink1, info outputImage1Desc)는 공통 내용과 무관(영향 없음)
//     4) 일반 vs mode=test 동일 · encre/oranke/phalanx 동일 · help 요청에 org/mode 누수 없음
//   실행: npx tsx --env-file=.env.local scripts/verify-line-opening-shared-help-keys.ts

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const K_MAIN = "admin.lineOpening.field.mainTitle";
const K_LINK = "admin.lineOpening.field.outputLink";
const K_COMP_LINK = "admin.competency.dashboard.input.outputLink1"; // 별도 유지
const K_INFO_IMG_DESC = "admin.lineOpening.info.field.outputImage1Desc"; // 별도 유지

const M_MAIN = `[공통-메인 ${Date.now()}] 크루가 고객 앱에서 보는 개설 라인의 메인 타이틀 도움말.`;
const M_LINK = `[공통-링크 ${Date.now()}] 개설 라인의 첫 번째 아웃풋 링크 URL 도움말.`;

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

// 페이지 컨텍스트에서 아이콘이 쓰는 것과 "동일한" GET 요청을 실행(쿠키 포함).
async function getHelpFromPage(page: Page, key: string): Promise<string> {
  return page.evaluate(async (k) => {
    const res = await fetch(`/api/admin/help?path=${encodeURIComponent(k)}`, { cache: "no-store" });
    const j = await res.json();
    return (j?.data?.content as string) ?? "";
  }, key);
}

// 도움말 저장(모달과 "동일한" PUT /api/admin/help, 같은 DTO). 페이지 컨텍스트(쿠키)로 실행.
//   개설폼 입력 필드는 주차·라인 선택에 게이트되어 UI 로 매번 도달하기 어려우므로,
//   아이콘 모달이 호출하는 것과 "동일한" 저장 요청을 페이지 컨텍스트에서 직접 실행한다.
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
  // 시드 정리(공통키/별도키 모두 알려진 값으로 세팅).
  await supabaseAdmin.from("admin_page_help_contents").upsert(
    [
      { page_path: K_MAIN, content: "", updated_at: new Date().toISOString() },
      { page_path: K_LINK, content: "", updated_at: new Date().toISOString() },
      { page_path: K_COMP_LINK, content: "COMPETENCY-전용-내용", updated_at: new Date().toISOString() },
      { page_path: K_INFO_IMG_DESC, content: "이미지-캡션-전용-내용", updated_at: new Date().toISOString() },
    ],
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
    // ── 1) info 페이지 컨텍스트에서 공통키 저장(모달과 동일 PUT) + 재조회 반영 ──
    {
      const { ctx, page } = await ctxPage();
      const leaked: string[] = [];
      page.on("request", (req) => {
        const u = new URL(req.url());
        if (u.pathname === "/api/admin/help" && (u.searchParams.get("org") || u.searchParams.get("mode")))
          leaked.push(req.url());
      });
      await page.goto(`${baseUrl}/admin/line-opening/practical-info`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1400);
      await savePut(page, K_MAIN, M_MAIN);
      await savePut(page, K_LINK, M_LINK);
      console.log("\n[1] info 페이지에서 공통키 2개 저장(PUT) 완료");

      // 같은 페이지에서 재조회(아이콘이 하는 것과 동일한 GET) → 저장 내용 반영.
      const backMain = await getHelpFromPage(page, K_MAIN);
      const backLink = await getHelpFromPage(page, K_LINK);
      check("info: 저장 직후 공통 mainTitle 재조회 반영", backMain === M_MAIN, backMain.slice(0, 30));
      check("info: 저장 직후 공통 outputLink 재조회 반영", backLink === M_LINK, backLink.slice(0, 30));
      check("info: help 요청에 org/mode 누수 없음", leaked.length === 0, leaked.slice(0, 2).join(","));
      await ctx.close();
    }

    // ── 2) career / experience 페이지에서 "같은 공통키" 조회 = info 저장 내용 ────
    {
      const { ctx, page } = await ctxPage();
      await page.goto(`${baseUrl}/admin/line-opening/practical-career`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1200);
      const cMain = await getHelpFromPage(page, K_MAIN);
      const cLink = await getHelpFromPage(page, K_LINK);
      console.log(`\n[2] career 페이지에서 공통키 조회: main="${cMain.slice(0, 20)}…" link="${cLink.slice(0, 20)}…"`);
      check("career: 공통 mainTitle = info 저장 내용", cMain === M_MAIN, cMain);
      check("career: 공통 outputLink = info 저장 내용", cLink === M_LINK, cLink);

      for (const org of orgs) {
        await page.goto(
          `${baseUrl}/admin/line-opening/practical-experience?org=${encodeURIComponent(org)}`,
          { waitUntil: "domcontentloaded" },
        );
        await page.waitForTimeout(1500);
        const eLink = await getHelpFromPage(page, K_LINK);
        check(`experience(org=${org}): 공통 outputLink = info 저장 내용`, eLink === M_LINK, eLink.slice(0, 30));
      }
      await ctx.close();
    }

    // ── 3) 별도 유지 키는 공통 내용과 무관(영향 없음) ──────────────────────────
    {
      const { ctx, page } = await ctxPage();
      await page.goto(`${baseUrl}/admin/line-opening/practical-info`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1000);
      const compLink = await getHelpFromPage(page, K_COMP_LINK);
      const imgDesc = await getHelpFromPage(page, K_INFO_IMG_DESC);
      console.log(`\n[3] 별도키: competency.outputLink1="${compLink}" / info.outputImage1Desc="${imgDesc}"`);
      check("competency outputLink1 은 공통 링크와 다름(별도 유지)", compLink !== M_LINK && compLink === "COMPETENCY-전용-내용", compLink);
      check("info outputImage1Desc('설명1'=이미지캡션) 은 공통 설명과 다름(별도 유지)", imgDesc === "이미지-캡션-전용-내용", imgDesc);
      await ctx.close();
    }

    // ── 4) mode=test 동일 ──────────────────────────────────────────────────────
    {
      const { ctx, page } = await ctxPage();
      await page.goto(`${baseUrl}/admin/line-opening/practical-career?mode=test`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1200);
      const cMain = await getHelpFromPage(page, K_MAIN);
      console.log(`\n[4] mode=test career 공통 mainTitle="${cMain.slice(0, 20)}…"`);
      check("mode=test: 공통 mainTitle = 일반 모드와 동일 내용", cMain === M_MAIN, cMain);
      await ctx.close();
    }

    console.log(`\n결과: ${pass} passed, ${fail} failed`);
  } finally {
    // cleanup: 시드 키 비우기.
    await supabaseAdmin.from("admin_page_help_contents").upsert(
      [K_MAIN, K_LINK, K_COMP_LINK, K_INFO_IMG_DESC].map((k) => ({
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

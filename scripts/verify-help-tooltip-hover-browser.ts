import { chromium, type BrowserContext, type Page } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// Help Key hover 툴팁 수정 검증(공용 Tooltip, React state 렌더).
//   대상: /admin/line-opening/practical-info "현재 상황" 카드 돋보기(키: currentSituation.title.card).
//   검증:
//     1) 내용 있는 Key 최초 hover → 커스텀 tooltip 에 정규화·말줄임 미리보기 표시
//     2) 새로고침 직후 최초 hover → 표시(첫 hover 부터)
//     3) 같은 Key 두 번째 hover → 표시(캐시 재사용)
//     4) 내용 없는 Key → fallback "이 항목 도움말"
//     5) 일반 모드 / mode=test 동일 표시
//     6) 서로 다른 org 동일 표시(experience 페이지, org 스코프)
//     7) hover 중 API 응답 도착 → 툴팁이 fallback→실제 본문으로 즉시 갱신(응답 인위 지연)
//   실행: npx tsx --env-file=.env.local scripts/verify-help-tooltip-hover-browser.ts

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const KEY_FILLED = "admin.lineOpening.currentSituation.title.card";
const KEY_EMPTY = "admin.lineOpening.currentSituation.info.today";
const CONTENT =
  "이 항목은 크루가 고객 앱에서 확인하게 되는 <b>메인 타이틀</b>입니다.\n\n너무 긴 문장은 피해주세요. 이 뒤 문장은 말줄임표로 잘려야 정상입니다. 계속 이어지는 아주 긴 설명 문장.";
const EXPECT_PREFIX = "이 항목은 크루가 고객 앱에서";

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
  const orgs = [...set];
  return orgs.length ? orgs : ["phalanx"];
}

// "현재 상황" 카드 돋보기(첫 번째) hover → role=tooltip 텍스트 반환.
async function hoverCardTip(page: Page): Promise<string> {
  const title = page.getByText("현재 상황", { exact: true }).first();
  await title.waitFor({ state: "visible", timeout: 15_000 });
  const trigger = title.getByRole("button", { name: "이 항목 도움말" }).first();
  await trigger.hover();
  // Tooltip openDelay(200ms) + fetch 여유.
  await page.waitForTimeout(900);
  const tip = page.getByRole("tooltip");
  if ((await tip.count()) === 0) return "(no-tooltip)";
  return (await tip.first().innerText()).trim();
}

async function moveAway(page: Page) {
  await page.mouse.move(5, 5);
  await page.waitForTimeout(300);
}

async function main() {
  await supabaseAdmin
    .from("admin_page_help_contents")
    .upsert(
      [
        { page_path: KEY_FILLED, content: CONTENT, updated_at: new Date().toISOString() },
        { page_path: KEY_EMPTY, content: "   \n  ", updated_at: new Date().toISOString() }, // 공백만 → fallback
      ],
      { onConflict: "page_path" },
    );
  console.log(`[seed] ${KEY_FILLED}=(${CONTENT.length}자), ${KEY_EMPTY}=(공백만)`);

  const orgs = await discoverOrgs();
  console.log(`[orgs] ${orgs.join(", ")}`);

  const browser = await chromium.launch({ headless: true });
  const cookies = await makeAdminCookies();

  async function freshContext(): Promise<{ ctx: BrowserContext; page: Page }> {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    return { ctx, page };
  }

  try {
    // ── 1) 내용 있는 Key 최초 hover (새 컨텍스트=모듈캐시 콜드) ─────────────────
    {
      const { ctx, page } = await freshContext();
      await page.goto(`${baseUrl}/admin/line-opening/practical-info`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);
      const tip = await hoverCardTip(page);
      console.log(`\n[1] 최초 hover tooltip = "${tip}"`);
      check("내용 미리보기 표시", tip.startsWith(EXPECT_PREFIX), tip);
      check("말줄임표(…)로 잘림", tip.endsWith("…"), tip);
      check("HTML 태그 미노출", !/[<>]/.test(tip), tip);
      check("줄바꿈 미노출(한 줄)", !tip.includes("\n"), JSON.stringify(tip));
      await ctx.close();
    }

    // ── 2) 새로고침 직후 최초 hover ────────────────────────────────────────────
    {
      const { ctx, page } = await freshContext();
      await page.goto(`${baseUrl}/admin/line-opening/practical-info`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1200);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1200);
      const tip = await hoverCardTip(page);
      console.log(`[2] 새로고침 후 첫 hover = "${tip.slice(0, 30)}…"`);
      check("새로고침 직후 첫 hover 에 내용 표시", tip.startsWith(EXPECT_PREFIX), tip);
      // ── 3) 같은 Key 두 번째 hover(같은 페이지, 캐시 재사용) ───────────────────
      await moveAway(page);
      const tip2 = await hoverCardTip(page);
      check("두 번째 hover 에도 내용 표시", tip2.startsWith(EXPECT_PREFIX), tip2);
      await ctx.close();
    }

    // ── 4) 내용 없는 Key → fallback ────────────────────────────────────────────
    {
      const { ctx, page } = await freshContext();
      await page.goto(`${baseUrl}/admin/line-opening/practical-info`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);
      const today = page.getByText("오늘 날짜", { exact: true }).first();
      await today.waitFor({ state: "visible", timeout: 10_000 });
      await today.getByRole("button", { name: "이 항목 도움말" }).first().hover();
      await page.waitForTimeout(900);
      const tip = page.getByRole("tooltip");
      const txt = (await tip.count()) ? (await tip.first().innerText()).trim() : "(none)";
      console.log(`[4] 공백만 Key tooltip = "${txt}"`);
      check("공백만 내용 → fallback '이 항목 도움말'", txt === "이 항목 도움말", txt);
      await ctx.close();
    }

    // ── 5) 일반 모드 vs mode=test 동일 ─────────────────────────────────────────
    {
      const { ctx, page } = await freshContext();
      await page.goto(`${baseUrl}/admin/line-opening/practical-info?mode=test`, {
        waitUntil: "domcontentloaded",
      });
      await page.waitForTimeout(1500);
      const tip = await hoverCardTip(page);
      console.log(`[5] mode=test tooltip = "${tip.slice(0, 30)}…"`);
      check("mode=test 에서도 동일 내용 표시", tip.startsWith(EXPECT_PREFIX), tip);
      await ctx.close();
    }

    // ── 6) 서로 다른 org 동일(experience, org 스코프) — 카드 키가 아닌 공통 키 확인은 5장 참고.
    //      여기선 org 파라미터가 help 요청에 새지 않고, 페이지가 org별로 같은 툴팁 동작을 하는지 스모크.
    {
      const { ctx, page } = await freshContext();
      const leaked: string[] = [];
      page.on("request", (req) => {
        const u = new URL(req.url());
        if (u.pathname === "/api/admin/help" && (u.searchParams.get("org") || u.searchParams.get("mode")))
          leaked.push(req.url());
      });
      for (const org of orgs.slice(0, 3)) {
        await page.goto(
          `${baseUrl}/admin/line-opening/practical-info?org=${encodeURIComponent(org)}`,
          { waitUntil: "domcontentloaded" },
        );
        await page.waitForTimeout(1400);
        const tip = await hoverCardTip(page);
        console.log(`[6] org=${org} tooltip = "${tip.slice(0, 20)}…"`);
        check(`org=${org} 동일 내용 표시`, tip.startsWith(EXPECT_PREFIX), tip);
        await moveAway(page);
      }
      check("help 요청에 org/mode 파라미터 누수 없음", leaked.length === 0, leaked.slice(0, 2).join(", "));
      await ctx.close();
    }

    // ── 7) hover 중 응답 도착 시 즉시 갱신(응답 500ms 지연) ─────────────────────
    {
      const { ctx, page } = await freshContext();
      await page.route("**/api/admin/help**", async (route) => {
        if (route.request().method() === "GET") await new Promise((r) => setTimeout(r, 700));
        await route.continue();
      });
      await page.goto(`${baseUrl}/admin/line-opening/practical-info`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);
      const title = page.getByText("현재 상황", { exact: true }).first();
      await title.waitFor({ state: "visible", timeout: 15_000 });
      const trigger = title.getByRole("button", { name: "이 항목 도움말" }).first();
      await trigger.hover();
      // Tooltip 은 200ms 후 열림 — 이때 fetch(700ms)는 아직 미완 → fallback 이어야.
      await page.waitForTimeout(350);
      const early = (await page.getByRole("tooltip").count())
        ? (await page.getByRole("tooltip").first().innerText()).trim()
        : "(none)";
      // 응답 도착 후 → 실제 본문으로 갱신(툴팁 계속 열린 채).
      await page.waitForTimeout(900);
      const late = (await page.getByRole("tooltip").count())
        ? (await page.getByRole("tooltip").first().innerText()).trim()
        : "(none)";
      console.log(`[7] 지연 중 tooltip="${early}"  →  응답 후="${late.slice(0, 24)}…"`);
      check("응답 전에는 fallback 표시", early === "이 항목 도움말", early);
      check("hover 유지 중 응답 도착하면 실제 본문으로 즉시 갱신", late.startsWith(EXPECT_PREFIX), late);
      await ctx.close();
    }

    console.log(`\n결과: ${pass} passed, ${fail} failed`);
  } finally {
    // cleanup: 시드 키 비우기.
    await supabaseAdmin
      .from("admin_page_help_contents")
      .upsert(
        [
          { page_path: KEY_FILLED, content: "", updated_at: new Date().toISOString() },
          { page_path: KEY_EMPTY, content: "", updated_at: new Date().toISOString() },
        ],
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

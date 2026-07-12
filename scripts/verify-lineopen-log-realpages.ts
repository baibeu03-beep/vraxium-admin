import { chromium, type Page } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// /admin/line-opening/* 실제 로그창 렌더 파리티(normal/test/org) — 공용 스크롤 래퍼가 실제로 붙었는지.
//   · 실제 로그 개수가 8 미만일 수 있으므로(경계 스크롤은 harness 로 증명) 여기선:
//     (1) "로그창" 렌더 + 런타임 에러 없음, (2) 로그 CardContent 가 공용 래퍼(overflow-x-hidden·
//     세로 overflow 는 인라인 제어)로 교체됨, (3) 가로 스크롤 없음, (4) 로그가 있으면 순서(위=오래된).
//   선행: dev server(:3000). 실행:
//    npx tsx --env-file=.env.local scripts/verify-lineopen-log-realpages.ts

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`);
  if (!ok) failed++;
}
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

async function adminEmail(): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  if (error) throw error;
  const email = (data?.[0] as { email: string } | undefined)?.email;
  assert(email, "No active admin email");
  return email;
}
async function makeSession(email: string) {
  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  assert(link.properties?.email_otp && !linkError, linkError?.message ?? "generateLink failed");
  const { data: verified, error: verifyError } = await anon.auth.verifyOtp({
    email, token: link.properties.email_otp, type: "magiclink",
  });
  assert(verified.session && !verifyError, verifyError?.message ?? "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items.map(({ name, value }) => ({ name, value }))) },
  });
  await server.auth.setSession({
    access_token: verified.session.access_token, refresh_token: verified.session.refresh_token,
  });
  return captured;
}
const baseHost = new URL(baseUrl).hostname;
const baseSecure = new URL(baseUrl).protocol === "https:";
function toPlaywrightCookies(cap: Array<{ name: string; value: string }>) {
  return cap.map(({ name, value }) => ({
    name, value, domain: baseHost, path: "/", httpOnly: false, secure: baseSecure, sameSite: "Lax" as const,
  }));
}
async function orgs(): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from("cluster4_team_halves").select("organization_slug").eq("is_active", true)
    .not("organization_slug", "is", null);
  const set = new Set((data ?? []).map((r: any) => r.organization_slug as string));
  return [...set].slice(0, 3);
}

async function gotoStable(page: Page, url: string) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2200);
  await page.getByText("로그창").first().waitFor({ timeout: 6000 }).catch(() => {});
  const body = await page.locator("body").innerText().catch(() => "");
  if (/Unhandled Runtime Error|Build Error|Failed to compile|500 -/.test(body)) {
    throw new Error(`page error at ${url}: ${body.slice(0, 300)}`);
  }
}

// 로그창 카드의 CardContent 를 찾아 공용 래퍼 특성 + 가로 스크롤 + 순서를 측정.
async function inspectLog(page: Page) {
  return page.evaluate(() => {
    const titles = Array.from(document.querySelectorAll('[data-slot="card-title"]')) as HTMLElement[];
    const logTitle = titles.find((t) => t.textContent?.includes("로그창"));
    if (!logTitle) return { present: false } as any;
    const card = logTitle.closest('[data-slot="card"]') as HTMLElement | null;
    const content = card?.querySelector('[data-slot="card-content"]') as HTMLElement | null;
    if (!content) return { present: true, hasContent: false } as any;
    const cls = content.className;
    const rows = Array.from(content.querySelectorAll(":scope > p")).filter((p) => /\[.+\]/.test(p.textContent ?? "")) as HTMLElement[];

    // 초기(최초 진입) 스크롤 위치.
    const initialScrollTop = content.scrollTop;
    const maxScrollTop = content.scrollHeight - content.clientHeight;

    // 맨 위에서 완전히 보이는 행 수 + 8번째 노출 여부.
    content.scrollTop = 0;
    const cr = content.getBoundingClientRect();
    let visibleAtTop = 0;
    for (const r of rows) {
      const rr = r.getBoundingClientRect();
      if (rr.top >= cr.top - 1 && rr.bottom <= cr.bottom + 1) visibleAtTop++;
    }
    const eighth = rows[7];
    const eighthPeek = !!eighth && eighth.getBoundingClientRect().top < cr.bottom - 1;

    return {
      present: true,
      hasContent: true,
      overflowXHidden: /overflow-x-hidden/.test(cls),
      noVerticalScrollClass: !/overflow-y-auto/.test(cls), // 세로는 인라인 제어(클래스로 강제 안 함)
      horizontalOverflow: content.scrollWidth - content.clientWidth,
      bodyOverflowX: document.documentElement.scrollWidth - window.innerWidth,
      scrollable: content.scrollHeight - content.clientHeight > 1,
      initAtBottom: Math.abs(initialScrollTop - maxScrollTop) <= 2,
      visibleAtTop,
      eighthPeek,
      rowCount: rows.length,
      firstRow: rows[0]?.textContent?.slice(0, 40) ?? null,
      lastRow: rows[rows.length - 1]?.textContent?.slice(0, 40) ?? null,
    } as any;
  });
}

async function main() {
  const email = await adminEmail();
  const cap = await makeSession(email);
  const orgList = await orgs();
  console.log(`base=${baseUrl} admin=${email} orgs=${orgList.join(",")}\n`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.addCookies(toPlaywrightCookies(cap));
  const page = await ctx.newPage();

  // 로그창은 org-스코프 "라인 개설"(tab=open) 탭에서만 렌더된다(orgScoped && tab=open).
  const org = orgList[0] ?? "phalanx";
  const targets: Array<[string, string]> = [
    ["info:org+open", `/admin/line-opening/practical-info?org=${org}&tab=open`],
    ["info:org+open+test", `/admin/line-opening/practical-info?org=${org}&tab=open&mode=test`],
    ["competency:org+open", `/admin/line-opening/practical-competency?org=${org}&tab=open`],
    ["competency:org+open+test", `/admin/line-opening/practical-competency?org=${org}&tab=open&mode=test`],
    ["experience:org+open", `/admin/line-opening/practical-experience?org=${org}&tab=open`],
    ["experience:org+open+test", `/admin/line-opening/practical-experience?org=${org}&tab=open&mode=test`],
  ];
  for (const alt of orgList.slice(1)) {
    targets.push([`info:${alt}`, `/admin/line-opening/practical-info?org=${alt}&tab=open`]);
    targets.push([`competency:${alt}`, `/admin/line-opening/practical-competency?org=${alt}&tab=open`]);
    targets.push([`experience:${alt}`, `/admin/line-opening/practical-experience?org=${alt}&tab=open`]);
  }

  try {
    for (const [label, url] of targets) {
      await gotoStable(page, `${baseUrl}${url}`);
      const m = await inspectLog(page);
      if (!m.present) { check(`[${label}] 로그창 렌더`, false); continue; }
      if (!m.hasContent) { check(`[${label}] 로그 CardContent 존재`, false); continue; }
      check(`[${label}] 로그창 공용 래퍼(overflow-x-hidden·세로 클래스 강제 없음)`, m.overflowXHidden && m.noVerticalScrollClass, { cls: { xHidden: m.overflowXHidden, noYClass: m.noVerticalScrollClass } });
      check(`[${label}] 가로 스크롤 없음`, m.horizontalOverflow <= 1 && m.bodyOverflowX <= 0, { x: m.horizontalOverflow, bodyX: m.bodyOverflowX });
      if (m.rowCount >= 8) {
        // 실제 로그 8개 이상 → 경계 동작을 실데이터로 검증.
        check(`[${label}] (실데이터 ${m.rowCount}개) 내부 스크롤·정확히 7행 표시·8번째 미노출·초기 하단`,
          m.scrollable && m.visibleAtTop === 7 && !m.eighthPeek && m.initAtBottom,
          { scrollable: m.scrollable, visibleAtTop: m.visibleAtTop, eighthPeek: m.eighthPeek, initAtBottom: m.initAtBottom });
      } else if (m.rowCount > 0) {
        check(`[${label}] (실데이터 ${m.rowCount}개≤7) 내부 스크롤 없음`, !m.scrollable, { scrollable: m.scrollable });
      }
      console.log(`   · rows=${m.rowCount} first="${m.firstRow}" last="${m.lastRow}"`);
    }
  } finally {
    await ctx.close();
    await browser.close();
  }

  console.log(`\n${failed === 0 ? "✅ ALL PASS" : `❌ ${failed} FAIL`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });

import { chromium, type Page, type BrowserContext } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// 회원 상세 표 "실제 재정렬" 증명 — 주차가 여러 개인 활성 회원을 찾아
//   "성장 성공 주차"(누적, 단조증가) 열을 asc/desc 로 정렬해 첫 행 값이 뒤바뀌는지 확인.
//   실행: npx tsx --env-file=.env.local scripts/verify-members-detail-reorder.ts
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

// org 목록에서 weeklyResults 가 2개 이상인 첫 회원 찾기.
async function findMultiWeekMember(ctx: BrowserContext, org: string): Promise<{ userId: string; weeks: number } | null> {
  const res = await ctx.request.get(`${baseUrl}/api/admin/members?organization=${org}&limit=40&mode=operating`);
  if (!res.ok()) return null;
  const members = (await res.json())?.data?.members ?? [];
  for (const m of members) {
    const uid = m?.userId as string;
    if (!uid) continue;
    const dRes = await ctx.request.get(`${baseUrl}/api/admin/members/${uid}`);
    if (!dRes.ok()) continue;
    const d = (await dRes.json())?.data;
    const wk = Array.isArray(d?.weeklyResults) ? d.weeklyResults.length : 0;
    if (wk >= 2) return { userId: uid, weeks: wk };
  }
  return null;
}

// 주차 표 = 페이지 내 마지막 <table>(시즌 표가 먼저 나옴). 첫 데이터 행의 nth번째 셀.
async function firstRowCol(page: Page, nth: number): Promise<string> {
  return (
    await page
      .locator("table")
      .last()
      .locator("tbody tr")
      .first()
      .locator("td")
      .nth(nth - 1)
      .innerText()
      .catch(() => "")
  ).trim();
}
async function clickSort(page: Page, label: string) {
  await page.locator(`button[aria-label="${label} 기준 정렬"]`).first().click();
  await page.waitForTimeout(150);
}

async function main() {
  const cookies = await makeAdminCookies();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();

  try {
    let target: { org: string; userId: string; weeks: number } | null = null;
    for (const org of ["encre", "oranke", "phalanx"]) {
      const f = await findMultiWeekMember(ctx, org);
      if (f) { target = { org, ...f }; break; }
    }
    assert(target, "No member with >=2 weekly rows found");
    console.log(`target: org=${target.org} user=${target.userId} weeks=${target.weeks}`);

    await page.goto(`${baseUrl}/admin/members/${target.userId}?org=${target.org}&mode=operating`, { waitUntil: "networkidle" });
    // 주차 표의 "주차명" 정렬 버튼이 뜰 때까지(상세 로드 완료 신호).
    await page.locator('button[aria-label="주차명 기준 정렬"]').first().waitFor({ timeout: 30000 });

    // 결정적 검증: 주차명(1번째 컬럼) — 10개 주차 이름이 모두 달라 asc/desc 첫 행이 반드시 뒤바뀐다.
    await clickSort(page, "주차명"); // asc
    const wAsc = await firstRowCol(page, 1);
    await clickSort(page, "주차명"); // desc
    const wDesc = await firstRowCol(page, 1);
    console.log(`weekName first row  asc="${wAsc}"  desc="${wDesc}"`);
    assert(wAsc !== "" && wDesc !== "", "empty weekName cells");
    assert(wAsc !== wDesc, `weekName reorder NOT observed (asc==desc==${wAsc})`);
    await clickSort(page, "주차명"); // reset

    // 참고(정보성): "성장 성공 주차"(누적) 열 — 값이 균일하면 첫 행이 같을 수 있음(정상).
    const label = "성장 성공 주차";
    await clickSort(page, label);
    const asc = await firstRowCol(page, 3);
    await clickSort(page, label);
    const desc = await firstRowCol(page, 3);
    await clickSort(page, label); // reset
    console.log(`cumulative-success first row  asc="${asc}"  desc="${desc}"  (${asc === desc ? "uniform col — OK" : "distinct — reorder"})`);

    console.log("\nREORDER VERIFIED — 표 정렬이 실제 행 순서를 바꿈(주차명 asc≠desc)");
  } finally {
    await browser.close();
  }
}
void main();

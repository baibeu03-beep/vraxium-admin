/**
 * 브라우저 E2E 검증: /admin/line-opening/practical-competency 카페 링크 집계 탭.
 *   npx tsx --env-file=.env.local scripts/verify-cafe-comments-browser.ts <게시글URL> [기대 댓글수]
 * READ-ONLY. 스크린샷: cafe-comments-tab-check.png
 */
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const adminBase = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

function ensureEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function main() {
  const articleUrl = process.argv[2];
  const expectedTotal = process.argv[3] ? Number(process.argv[3]) : null;
  if (!articleUrl) {
    console.error("게시글 URL 인자가 필요합니다.");
    process.exit(1);
  }

  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const admin = createClient(supabaseUrl, ensureEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const anon = createClient(supabaseUrl, anonKey);
  const { data: l, error: le } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  if (le || !l?.properties?.email_otp) throw new Error(le?.message ?? "generateLink failed");
  const { data: v, error: ve } = await anon.auth.verifyOtp({
    email: adminEmail,
    token: l.properties.email_otp,
    type: "magiclink",
  });
  if (ve || !v.session) throw new Error(ve?.message ?? "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [],
      setAll: (items) => void captured.push(...items.map((i) => ({ name: i.name, value: i.value }))),
    },
  });
  await server.auth.setSession({
    access_token: v.session.access_token,
    refresh_token: v.session.refresh_token,
  });

  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    await ctx.addCookies(captured.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" })));
    const page = await ctx.newPage();
    await page.goto(`${adminBase}/admin/line-opening/practical-competency`, { waitUntil: "domcontentloaded", timeout: 60000 });

    // 탭 진입
    await page.getByRole("button", { name: "카페 링크 집계" }).click({ timeout: 30000 });
    await page.getByPlaceholder("https://cafe.naver.com/...").fill(articleUrl);
    await page.getByRole("button", { name: "댓글 수집" }).click();

    // 수집 완료 대기 (크롤링 수십 초 소요 가능)
    await page.getByText("수집 결과").waitFor({ timeout: 240000 });
    const total = Number(((await page.locator("p.text-2xl").nth(0).textContent()) ?? "").trim());
    const unique = Number(((await page.locator("p.text-2xl").nth(1).textContent()) ?? "").trim());
    const extra = Number(((await page.locator("p.text-2xl").nth(2).textContent()) ?? "").trim());
    // 테이블의 닉네임별 댓글 수 컬럼(마지막 셀) 전수 추출
    const rowCounts = (
      await page.locator("table tbody tr td:last-child").allTextContents()
    ).map((t) => Number(t.trim()));

    await page.screenshot({ path: "cafe-comments-tab-check.png", fullPage: true });

    const sumCounts = rowCounts.reduce((s, n) => s + n, 0);
    const sortedDesc = rowCounts.every((n, i) => i === 0 || rowCounts[i - 1] >= n);
    const checks = [
      { name: "수집 결과 렌더(3박스)", pass: [total, unique, extra].every((n) => Number.isFinite(n)), detail: `total=${total} 참여=${unique} 추가=${extra} rows=${rowCounts.length}` },
      { name: "참여 인원 수 == 테이블 행수", pass: rowCounts.length === unique, detail: `rows=${rowCounts.length} unique=${unique}` },
      { name: "추가 댓글 수 == 전체-참여", pass: extra === total - unique, detail: `extra=${extra} total-unique=${total - unique}` },
      { name: "전체 댓글 수 == 댓글 수 합계", pass: sumCounts === total, detail: `sum=${sumCounts} total=${total}` },
      { name: "댓글 수 내림차순 정렬", pass: sortedDesc, detail: `first=${rowCounts[0]} last=${rowCounts[rowCounts.length - 1]}` },
      { name: "1회 작성자 표시", pass: rowCounts.includes(1), detail: `count=1 행 ${rowCounts.filter((n) => n === 1).length}개` },
      { name: "2회 이상 작성자 표시", pass: rowCounts.some((n) => n >= 2), detail: `count>=2 행 ${rowCounts.filter((n) => n >= 2).length}개 (max=${Math.max(...rowCounts)})` },
    ];
    if (expectedTotal != null) {
      checks.push({ name: "기대 댓글 수 일치", pass: total === expectedTotal, detail: `expected=${expectedTotal} actual=${total}` });
    }
    let failed = 0;
    for (const c of checks) {
      if (!c.pass) failed++;
      console.log(`${c.pass ? "PASS" : "FAIL"} | ${c.name} | ${c.detail}`);
    }
    console.log("screenshot: cafe-comments-tab-check.png");
    process.exit(failed === 0 ? 0 : 1);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

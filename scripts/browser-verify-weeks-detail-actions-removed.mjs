// `/admin/team-parts/info/weeks/[weekId]` — [주차 검수]·[실행 취소] 제거 후 화면 확인(브라우저).
//   · 두 버튼과 연결된 도움말 아이콘이 없다
//   · 남은 wrapper/여백이 레이아웃을 깨지 않는다(관리 주차 줄 높이·가로 스크롤 없음)
//   · 조회/오픈 확인 등 나머지 기능은 그대로다
//   · 일반 / mode=test 가 동일하게 보인다
// 실행: node scripts/browser-verify-weeks-detail-actions-removed.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const U = get("NEXT_PUBLIC_SUPABASE_URL");
const A = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const S = get("SUPABASE_SERVICE_ROLE_KEY");
const EMAIL = "vanuatu.golden@gmail.com";
const ORG = "encre";

let fail = 0;
const ck = (l, ok, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};

async function cookies() {
  const sb = createClient(U, S);
  const b = createClient(U, A);
  const { data: l } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const { data: v } = await b.auth.verifyOtp({ email: EMAIL, token: l.properties.email_otp, type: "magiclink" });
  const cap = [];
  const sv = createServerClient(U, A, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await sv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/" }));
}

async function main() {
  const sb = createClient(U, S);
  const { data: wk } = await sb
    .from("weeks")
    .select("id,week_number")
    .eq("season_key", "2026-summer")
    .eq("week_number", 3)
    .single();
  const weekId = wk.id;

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  await ctx.addCookies(await cookies());
  const page = await ctx.newPage();

  for (const [label, q] of [["일반", ""], ["mode=test", "&mode=test"]]) {
    console.log(`\n▶ ${label}`);
    await page.goto(`${BASE}/admin/team-parts/info/weeks/${weekId}?club=${ORG}${q}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("[data-managed-week]", { timeout: 90000 });
    await page
      .waitForFunction(() => !document.body.innerText.includes("불러오는 중"), null, { timeout: 40000 })
      .catch(() => {});
    await page.waitForTimeout(500);

    ck("[주차 검수] 버튼 없음", (await page.locator("[data-review-button]").count()) === 0);
    ck("[실행 취소] 없음", (await page.locator("[data-ac-week-review]").count()) === 0);
    ck("검수 준비 모달 없음", (await page.locator("[data-review-readiness-modal]").count()) === 0);
    const helpKeys = await page.evaluate(() =>
      [...document.querySelectorAll("[data-help-key]")].map((n) => n.getAttribute("data-help-key")),
    );
    ck(
      "도움말 action.review / action.reviewRevert 아이콘 없음",
      !helpKeys.some((k) => k && (k.endsWith("activity.action.review") || k.endsWith("activity.action.reviewRevert"))),
      `help icons=${helpKeys.length}`,
    );
    // 본문 텍스트에서도 액션 문구가 사라졌는지(라벨 잔존 방지).
    const managedText = await page.locator("[data-managed-week]").innerText();
    ck("관리 주차 줄에 '주차 검수'·'실행 취소' 문구 없음", !/주차 검수|실행 취소/.test(managedText), JSON.stringify(managedText.replace(/\n/g, " ").slice(0, 70)));

    // 레이아웃 — 빈 wrapper/깨진 정렬 없음.
    const box = await page.locator("[data-managed-week]").boundingBox();
    ck("관리 주차 카드 높이 정상(한 줄 유지)", box.height > 30 && box.height < 130, `h=${Math.round(box.height)}`);
    const emptyWrappers = await page.evaluate(() => {
      const sec = document.querySelector("[data-managed-week]");
      return [...sec.querySelectorAll("div")].filter(
        (d) => d.children.length === 0 && d.textContent.trim() === "",
      ).length;
    });
    ck("관리 주차 카드 안 빈 div 0개", emptyWrappers === 0, `empty=${emptyWrappers}`);
    const hScroll = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    ck("가로 스크롤 없음", !hScroll);

    // 나머지 기능 유지.
    ck("오픈 확인 버튼 유지", (await page.locator("[data-open-confirm-button]").count()) === 1);
    ck("초기화 버튼 유지", (await page.locator("[data-hub-reset-button]").count()) === 1);
    ck("관리 주차명 표시", (await page.locator("[data-managed-week-name]").innerText()).trim().length > 0);
    ck("현재 주차 배너 유지", (await page.locator("[data-current-week]").count()) === 1);
    ck("탭(액트 체크/라인 개설) 유지", (await page.locator("[data-tab]").count()) >= 2);

    await page.screenshot({
      path: `claudedocs/weeks-detail-actions-removed-${label === "일반" ? "normal" : "test"}.png`,
      fullPage: false,
    });
  }

  await browser.close();
  console.log(`\n결과: ${fail === 0 ? "전부 통과" : `${fail}건 실패`}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

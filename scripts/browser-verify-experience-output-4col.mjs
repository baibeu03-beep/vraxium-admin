// 브라우저 검증(비파괴) — 실무 경험 [팀 총괄] '아웃풋 링크 & 이미지' 1행 4열 레이아웃 확인.
//   각 카테고리(도출/분석/견문/관리/확장) 섹션 내부가 [링크][링크설명][이미지][이미지설명] 4열로
//   같은 행(top 근접)에 배치되는지 실측 + 스크린샷. org × mode(operating/test) 전수.
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
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE), brow = createClient(URL_, ANON);
const EMAIL = "vanuatu.golden@gmail.com";
const ORGS = process.env.VERIFY_ORG ? [process.env.VERIFY_ORG] : ["encre"];
const ALL_MODES = [{ key: "operating", qs: "" }, { key: "test", qs: "&mode=test" }];
const MODES = process.env.VERIFY_MODE ? ALL_MODES.filter((m) => m.key === process.env.VERIFY_MODE) : ALL_MODES;

let pass = 0, fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = [];
const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1600 } });
await context.addCookies(cookies);
const page = await context.newPage();

const gotoAndReady = async (url) => {
  for (let a = 0; a < 4; a++) {
    try { await page.goto(url, { waitUntil: "domcontentloaded" }); } catch { await page.waitForTimeout(900); continue; }
    const ok = await page.waitForSelector('[data-slot="select-trigger"].w-56', { timeout: 15000 }).then(() => true).catch(() => false);
    if (ok) { await page.waitForTimeout(800); return; }
    await page.waitForTimeout(900);
  }
  throw new Error("part Select 트리거 미등장");
};
const openSelect = async () => { await page.locator('[data-slot="select-trigger"].w-56').first().click({ timeout: 10000 }); await page.waitForTimeout(400); };
const pickOption = async (t) => { await page.locator('[data-slot="select-item"]', { hasText: t }).first().click({ timeout: 10000 }); await page.waitForTimeout(1500); };

for (const org of ORGS) {
  for (const m of MODES) {
    const tag = `${org}/${m.key}`;
    try {
      const weekQs = process.env.VERIFY_WEEK ? `&week=${encodeURIComponent(process.env.VERIFY_WEEK)}` : "";
      await gotoAndReady(`${BASE}/admin/line-opening/practical-experience?org=${org}&tab=open${m.qs}${weekQs}`);
      await openSelect();
      const hasOverall = await page.locator('[data-slot="select-item"]', { hasText: "팀 총괄" }).count();
      if (!hasOverall) { await page.keyboard.press("Escape"); ck(`[${tag}] 팀 총괄 옵션 없음(스킵)`, true); continue; }
      await pickOption("팀 총괄");

      // '아웃풋 링크 & 이미지' 섹션으로 스크롤.
      await page.evaluate(() => {
        const h = Array.from(document.querySelectorAll("p")).find((p) => (p.textContent || "").includes("아웃풋 링크"));
        if (h) h.scrollIntoView({ block: "start" });
      });
      await page.waitForTimeout(400);

      // 섹션 내 각 카테고리 블록: 4열 그리드가 lg에서 1행(모든 셀 top 근접)인지 측정.
      //   그리드 컨테이너 = lg:grid-cols-[...] 를 가진 div. 그 직접 자식 4개의 top 이 근접해야 1행.
      const res = await page.evaluate(() => {
        const grids = Array.from(document.querySelectorAll('div[class*="grid-cols-[minmax(240px,1.1fr)"]'));
        return grids.map((g) => {
          const kids = Array.from(g.children);
          const tops = kids.map((k) => Math.round(k.getBoundingClientRect().top));
          const cols = window.getComputedStyle(g).gridTemplateColumns;
          const min = Math.min(...tops), max = Math.max(...tops);
          return { n: kids.length, delta: max - min, colCount: cols.split(" ").length, cols };
        });
      });
      ck(`[${tag}] 아웃풋 4열 그리드 존재(카테고리 수)`, res.length >= 1, `grids=${res.length}`);
      const allSingleRow = res.every((r) => r.n === 4 && r.colCount === 4 && r.delta <= 3);
      ck(`[${tag}] 각 섹션 4셀·1행(top Δ≤3px)·4트랙`, allSingleRow, JSON.stringify(res.map((r) => ({ n: r.n, d: r.delta, c: r.colCount }))));
      // 트랙 폭(px) 검증 — 이미지 열은 콘텐츠 고정(≈200px: 박스160+gap8+아이콘32), 나머지는 fr.
      //   원칙: 이미지 열이 가장 좁고(fr 아님), 이미지 설명 열이 가장 넓으며, 링크/링크설명은 충분(≥220px).
      if (res[0]) {
        const w = res[0].cols.split(" ").map((s) => parseFloat(s)); // [링크, 링크설명, 이미지, 이미지설명]
        const [link, linkDesc, image, imageDesc] = w;
        const imageFixed = image >= 195 && image <= 215; // w-40 콘텐츠 고정
        const imageNarrowest = image < link && image < linkDesc && image < imageDesc;
        const descWidest = imageDesc >= link && imageDesc >= linkDesc && imageDesc >= image;
        const linksRoomy = link >= 220 && linkDesc >= 200;
        const okWidths = w.length === 4 && imageFixed && imageNarrowest && descWidest && linksRoomy;
        ck(`[${tag}] 트랙 폭: 이미지 고정≈200·설명 최광·링크 충분`, okWidths, `px=[link:${Math.round(link)}, linkDesc:${Math.round(linkDesc)}, image:${Math.round(image)}, imageDesc:${Math.round(imageDesc)}]`);
      }

      await page.screenshot({ path: resolve(adminRoot, "claudedocs", `exp-output-4col-${org}-${m.key}.png`), fullPage: true }).catch(() => {});
    } catch (e) {
      ck(`[${tag}] 실행 오류`, false, e?.message ?? String(e));
    }
  }
}
await browser.close();
console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);

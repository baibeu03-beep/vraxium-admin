// 실제 렌더된 체크박스 end-to-end 토글 검증 — 계정 관리 생성 폼(초대 이메일 토글).
//   실 HTTP 화면에서 .admin-checkbox 클릭 → (1) 박스 accent 채움 (2) 인접 라벨 텍스트가
//   accent 강조색으로 바뀌는지(checkedTextClass 배선)까지 확인. operating + mode=test.
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

let pass = 0, fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = [];
const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1200 } });
await context.addCookies(cookies);
const page = await context.newPage();
page.setDefaultNavigationTimeout(120000);

async function run(mode) {
  const tag = mode ? "test" : "operating";
  // 실무 정보 라인(/admin/lines/info) 의 "허브 필터" 드롭다운 = 정적 허브 체크박스(데이터 무관).
  await page.goto(`${BASE}/admin/lines/info?org=encre${mode ? "&mode=test" : ""}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const filterBtn = page.getByRole("button", { name: "허브 필터" }).first();
  if (await filterBtn.count().catch(() => 0)) { await filterBtn.click().catch(() => {}); await page.waitForTimeout(600); }
  // 실제 렌더된 첫 .admin-checkbox 를 찾아 라벨 색 변화까지 확인.
  const result = await page.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll(".admin-checkbox"));
    if (!boxes.length) return { count: 0 };
    // 라벨 텍스트 span 을 가진 체크박스 우선 선택.
    const withLabel = boxes.find((b) => b.closest("label")?.querySelector("span"));
    const box = withLabel || boxes[0];
    const label = box.closest("label")?.querySelector("span") || box.closest("label");
    const read = () => ({
      boxBg: getComputedStyle(box).backgroundColor,
      labelColor: label ? getComputedStyle(label).color : null,
      labelWeight: label ? getComputedStyle(label).fontWeight : null,
      checked: box.checked,
    });
    const before = read();
    box.click();
    const after = read();
    return { count: boxes.length, before, after };
  });
  ck(`[${tag}] 실제 .admin-checkbox 렌더됨`, result.count > 0, `n=${result.count}`);
  if (result.count > 0) {
    const { before, after } = result;
    ck(`[${tag}] 클릭 시 checked 상태 토글`, before.checked !== after.checked, `${before.checked}→${after.checked}`);
    ck(`[${tag}] 클릭 시 박스 배경(accent 채움) 변화`, before.boxBg !== after.boxBg, `${before.boxBg} → ${after.boxBg}`);
    if (before.labelColor && after.labelColor) {
      const colorOrWeight = before.labelColor !== after.labelColor || before.labelWeight !== after.labelWeight;
      ck(`[${tag}] 클릭 시 라벨 강조(색 또는 굵기) 변화`, colorOrWeight,
        `color ${before.labelColor}→${after.labelColor} · weight ${before.labelWeight}→${after.labelWeight}`);
    }
  }
  await page.screenshot({ path: resolve(adminRoot, "claudedocs", `checkbox-realtoggle-${tag}.png`) });
}

try {
  await run(false);
  await run(true);
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
} finally {
  await browser.close();
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

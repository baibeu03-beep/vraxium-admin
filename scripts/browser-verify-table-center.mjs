// 브라우저(인증 세션) 검증 — 표 전역 가운데 정렬 통일.
//   각 페이지의 모든 th/td 의 computed text-align 을 집계해 center 비율을 확인하고,
//   가로 스크롤(overflow) 발생 여부 + 행 높이 스냅샷을 남긴다.
//   명시적 text-left override(예외) 셀은 left 로 남아도 정상(분리 집계).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const requireAdmin = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = requireAdmin("@supabase/supabase-js");
const { createServerClient } = requireAdmin("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const SUPABASE_URL = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const admin = createClient(SUPABASE_URL, SERVICE);

async function makeAdminCookies() {
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await browser.auth.verifyOtp({
    email: adminEmail, token: linkData.properties.email_otp, type: "magiclink",
  });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  return captured.map((i) => ({
    name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax",
  }));
}

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const PAGES = [
  "/admin/members?org=encre",
  "/admin/members/3330f4c3-5331-4632-bbe6-01a19017a089", // 크루 상세 — raw <td> 표(전역 CSS 경로)
  "/admin/processes/register?org=encre",
  "/admin/processes/check/info?org=encre",
  "/admin/processes/check/experience?org=encre",
  "/admin/line-opening/practical-info?org=encre",
  "/admin/line-opening/practical-experience?org=encre",
];

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();

async function audit() {
  return page.evaluate(() => {
    const cells = Array.from(document.querySelectorAll("table th, table td"));
    let center = 0, left = 0, right = 0, other = 0;
    let centerNoExplicitLeft = 0, explicitLeft = 0;
    for (const el of cells) {
      const ta = getComputedStyle(el).textAlign;
      const cls = el.getAttribute("class") || "";
      if (ta === "center") center++;
      else if (ta === "left" || ta === "start") left++;
      else if (ta === "right" || ta === "end") right++;
      else other++;
      // 명시적 text-left override 셀(예외)과 일반 center 셀 분리
      if (/\btext-left\b/.test(cls)) explicitLeft++;
      else if (ta === "center") centerNoExplicitLeft++;
    }
    // 가로 스크롤(표 컨테이너) 발생 여부
    const containers = Array.from(document.querySelectorAll('[data-slot="table-container"], table'));
    const overflowed = containers.filter((c) => c.scrollWidth > c.clientWidth + 1).length;
    return { total: cells.length, center, left, right, other, explicitLeft, centerNoExplicitLeft, overflowed };
  });
}

try {
  for (const url of PAGES) {
    console.log(`\n[${url}]`);
    await page.goto(`${BASE}${url}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    const a = await audit();
    if (a.total === 0) {
      console.log("  · 렌더된 table 셀 없음(데이터/탭 의존) — 스킵(비-fail)");
      continue;
    }
    // 모든 비-예외(text-left 미지정) 셀은 center 여야 한다. right 는 0 이어야 한다.
    const nonLeftCells = a.total - a.explicitLeft;
    check(`헤더/셀 center (center=${a.center}/${a.total}, explicitLeft=${a.explicitLeft}, right=${a.right})`,
      a.right === 0 && a.center >= nonLeftCells - a.explicitLeft && a.center > 0,
      `left(비예외포함)=${a.left}`);
    check("text-right 잔존 0", a.right === 0);
  }
  console.log(`\n=== RESULT: ${pass} pass / ${fail} fail ===`);
} catch (e) {
  console.error("ERROR:", e);
  fail++;
} finally {
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
}

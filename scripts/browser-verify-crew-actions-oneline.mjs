// 브라우저(인증) 검증 — 크루 목록 "바로가기" 컬럼 버튼이 한 줄(가로)로 배치되어
//   각 행 height 가 일반 행 수준으로 줄었는지 확인한다.
//   · 액션 셀의 모든 버튼/링크가 동일 offsetTop(= 한 줄) 인지
//   · 행 height 가 과거 다단(wrap) 대비 낮은지(대략 < 64px)
//   · encre/oranke/phalanx (mode=test) + 일반 모드 동일
// 사용법: node scripts/browser-verify-crew-actions-oneline.mjs
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

// 첫 데이터 행의 액션 셀을 측정한다.
async function measure(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("tbody tr"));
    // 데이터 행(액션 링크가 있는 행)만
    const dataRow = rows.find((r) => r.querySelector('a[href*="/cluster2"], a[href*="/admin/crews/"]'));
    if (!dataRow) return { found: false };
    const cells = Array.from(dataRow.querySelectorAll("td"));
    const actionCell = cells[cells.length - 1];
    const flex = actionCell.querySelector("div");
    const kids = flex ? Array.from(flex.children) : [];
    // 한 줄 판정: 컨테이너 높이가 가장 큰 버튼 높이와 사실상 같으면 한 줄.
    //   (버튼마다 높이가 달라 center 정렬 시 top 좌표는 몇 px 어긋난다 → top 동일성으로 판정하면 안 됨)
    const kidHeights = kids.map((k) => k.getBoundingClientRect().height);
    const tallestKid = Math.round(Math.max(0, ...kidHeights));
    const flexHeight = flex ? Math.round(flex.getBoundingClientRect().height) : 0;
    return {
      found: true,
      rowHeight: Math.round(dataRow.getBoundingClientRect().height),
      buttonCount: kids.length,
      flexHeight,
      tallestKid,
      singleLine: flexHeight <= tallestKid + 4, // 한 줄이면 컨테이너 ≈ 최대 버튼 높이
      flexWrap: flex ? getComputedStyle(flex).flexWrap : "(no flex)",
      actionCellWidth: Math.round(actionCell.getBoundingClientRect().width),
      flexScrollWidth: flex ? flex.scrollWidth : 0,
    };
  });
}

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();

const CASES = [
  ["encre (mode=test)", "/admin/crews/encre?mode=test", "qa-crew-actions-encre-test.png"],
  ["oranke (mode=test)", "/admin/crews/oranke?mode=test", "qa-crew-actions-oranke-test.png"],
  ["phalanx (mode=test)", "/admin/crews/phalanx?mode=test", "qa-crew-actions-phalanx-test.png"],
  ["encre (일반 모드)", "/admin/crews/encre", "qa-crew-actions-encre-normal.png"],
];

try {
  for (const [label, path, shot] of CASES) {
    console.log(`\n[${label}] ${path}`);
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    await page.waitForSelector("tbody tr", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);
    const m = await measure(page);
    if (!m.found) {
      check("데이터 행 존재", false, "액션 링크 있는 행 미발견(빈 목록일 수 있음)");
      await page.screenshot({ path: resolve(adminRoot, "claudedocs", shot), fullPage: false });
      continue;
    }
    check("액션 버튼 한 줄(컨테이너≈최대버튼 높이)", m.singleLine, `flexH=${m.flexHeight}px, tallest=${m.tallestKid}px, buttons=${m.buttonCount}`);
    check("flex-nowrap 적용", m.flexWrap === "nowrap", m.flexWrap);
    check("행 height 축소(< 64px)", m.rowHeight < 64, `${m.rowHeight}px`);
    console.log(`     · 버튼수=${m.buttonCount} · 셀폭=${m.actionCellWidth}px · flexScrollWidth=${m.flexScrollWidth}px`);
    await page.screenshot({ path: resolve(adminRoot, "claudedocs", shot), fullPage: false });
    console.log(`     · screenshot → claudedocs/${shot}`);
  }
  console.log(`\n=== RESULT: ${pass} pass / ${fail} fail ===`);
} catch (e) {
  console.error("ERROR:", e);
  fail++;
} finally {
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
}

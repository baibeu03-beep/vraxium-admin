// 브라우저 검증 — /admin/line-opening/* 콘텐츠 폭 ~70~75%(1920px 기준) + 좌우 균형.
//   layout.tsx(max-w-[1400px] 가운데 정렬)가 모든 하위 페이지/탭에 적용되는지 측정.
//   표시 전용 측정 — DB/저장/API 무접촉.
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
const ORG = "oranke";

async function makeAdminCookies() {
  const admin = createClient(SUPABASE_URL, SERVICE);
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

const VIEWPORT_W = 1920;
const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: VIEWPORT_W, height: 1200 } });
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();

// 대상 페이지(하위 탭 포함). [waitText]=렌더 확인용 텍스트.
const targets = [
  { path: `/admin/line-opening/practical-info?org=${ORG}`, label: "practical-info(manage)", wait: "라인 관리" },
  { path: `/admin/line-opening/practical-info?org=${ORG}&tab=open`, label: "practical-info(open)", wait: "라인 개설" },
  { path: `/admin/line-opening/practical-experience?org=${ORG}`, label: "practical-experience(manage)", wait: "라인 관리" },
  { path: `/admin/line-opening/practical-experience?org=${ORG}&tab=open`, label: "practical-experience(open)", wait: "라인 개설" },
  { path: `/admin/line-opening/practical-career?org=${ORG}`, label: "practical-career", wait: "라인" },
  { path: `/admin/line-opening/practical-competency?org=${ORG}`, label: "practical-competency", wait: "라인" },
  { path: `/admin/line-opening/line-history`, label: "line-history", wait: "라인 개설 이력" },
];

try {
  for (const t of targets) {
    await page.goto(`${BASE}${t.path}`, { waitUntil: "domcontentloaded" });
    try {
      await page.waitForFunction(`document.body.innerText.includes(${JSON.stringify(t.wait)})`, undefined, { timeout: 30000 });
    } catch { /* 일부 페이지는 로딩만 — 측정은 계속 */ }

    // <main> 내부 첫 자식(=layout wrapper div)의 박스 측정.
    const m = await page.evaluate(`(() => {
      const main = document.querySelector('main');
      if (!main) return null;
      const wrapper = main.firstElementChild;
      if (!wrapper) return null;
      const r = wrapper.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(window.innerWidth - r.right), width: Math.round(r.width), vw: window.innerWidth };
    })()`);
    if (!m) { check(`${t.label} 측정`, false, "main/wrapper 없음"); continue; }

    const pct = Math.round((m.width / m.vw) * 100);
    // 콘텐츠 폭 ≈ max-w-[1400px] → 1920 기준 ~73%. 68~78% 허용.
    const widthOk = m.width <= 1410 && pct >= 68 && pct <= 78;
    // 좌우 여백 균형: wrapper 가 main 안에서 가운데 정렬 — main 기준 좌우 여백 차이 작아야.
    //   (left 는 sidebar+padding 포함 절대값이라, main 내부 균형은 별도로 측정)
    const balance = await page.evaluate(`(() => {
      const main = document.querySelector('main');
      const wrapper = main.firstElementChild;
      const mr = main.getBoundingClientRect();
      const wr = wrapper.getBoundingClientRect();
      const padL = Math.round(wr.left - mr.left);
      const padR = Math.round(mr.right - wr.right);
      return { padL, padR, diff: Math.abs(padL - padR) };
    })()`);
    const balanceOk = balance.diff <= 4; // mx-auto 가운데 정렬 → 좌우 여백 동일(반올림 오차 허용)

    check(`${t.label}`, widthOk && balanceOk,
      `width=${m.width}px (${pct}% of ${m.vw}) · main내 좌여백=${balance.padL} 우여백=${balance.padR}`);
  }
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
} finally {
  await browser.close();
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);

// 브라우저(인증 세션) 검증 — 어드민 전역 타이포그래피 확대 + 가로 스크롤 어포던스.
//   · th/td 의 computed font-size 를 집계해 헤더/본문이 실제로 커졌는지 확인.
//   · 공통 Table 컨테이너에 가로 스크롤 어포던스(Fade/힌트) 가 배선됐는지 확인.
//   · 오버플로가 실제로 있는 표에서 fade 가 나타나는지(스크롤 후 좌측 fade on) 확인.
//   · 각 페이지 스크린샷을 claudedocs/ 에 남긴다.
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

// [label, url, screenshot-slug]
const PAGES = [
  ["Dashboard", "/admin", "type-dashboard"],
  ["크루 목록(members)", "/admin/members?org=encre", "type-members"],
  ["활동 관리(check/info)", "/admin/processes/check/info?org=encre", "type-check-info"],
  ["주차 검수(week-recognitions)", "/admin/week-recognitions?org=encre", "type-week-recognitions"],
  ["라인 개설(practical-info)", "/admin/line-opening/practical-info?org=encre", "type-line-opening"],
  ["설정/등록(processes/register)", "/admin/processes/register?org=encre", "type-register"],
];

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();

// 표 폰트 + 어포던스 측정
async function audit() {
  return page.evaluate(() => {
    const px = (el, prop) => parseFloat(getComputedStyle(el)[prop]) || 0;
    const ths = Array.from(document.querySelectorAll("table th"));
    const tds = Array.from(document.querySelectorAll("table td"));
    const med = (arr) => {
      if (!arr.length) return 0;
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };
    const thFont = med(ths.map((e) => px(e, "fontSize")));
    const tdFont = med(tds.map((e) => px(e, "fontSize")));
    const bodyFont = px(document.body, "fontSize");

    // 공통 어포던스 컨테이너
    const containers = Array.from(document.querySelectorAll('[data-slot="table-container"]'));
    // fade 오버레이(pointer-events-none absolute … gradient) 존재 여부: 각 컨테이너 자식 div 2개(fade)
    const withFades = containers.filter((c) => {
      const overlays = Array.from(c.children).filter(
        (ch) => ch.tagName === "DIV" && /gradient/.test(getComputedStyle(ch).backgroundImage),
      );
      return overlays.length >= 2;
    }).length;
    const overflowed = Array.from(document.querySelectorAll("table")).filter(
      (t) => t.scrollWidth > t.clientWidth + 1,
    ).length;
    return {
      thCount: ths.length, tdCount: tds.length,
      thFont, tdFont, bodyFont,
      containers: containers.length, withFades, overflowed,
    };
  });
}

try {
  for (const [label, url, slug] of PAGES) {
    console.log(`\n[${label}] ${url}`);
    try {
      await page.goto(`${BASE}${url}`, { waitUntil: "networkidle", timeout: 30000 });
    } catch {
      await page.goto(`${BASE}${url}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    }
    await page.waitForTimeout(1200);
    await page.screenshot({ path: resolve(adminRoot, "claudedocs", `qa-${slug}.png`), fullPage: false });
    const a = await audit();
    console.log(`  · body=${a.bodyFont}px, th(med)=${a.thFont}px (${a.thCount}), td(med)=${a.tdFont}px (${a.tdCount}), containers=${a.containers}, fades=${a.withFades}, overflowed=${a.overflowed}`);

    // body 폰트 = 20px(text-base 신규 기준). 16±1 이면 스케일 미적용.
    check(`body 폰트 확대(≥18px)`, a.bodyFont >= 18, `${a.bodyFont}px`);
    if (a.thCount > 0) {
      // th = text-sm = 17.5px. 15 미만이면 헤더 미확대.
      check(`헤더(th) ≥16px`, a.thFont >= 16, `${a.thFont}px`);
      check(`셀(td) ≥16px`, a.tdFont >= 16, `${a.tdFont}px`);
    } else {
      console.log("  · 렌더된 table 없음(데이터/탭 의존) — 표 검사 스킵");
    }
    if (a.containers > 0) {
      check(`어포던스 컨테이너 fade 배선(${a.withFades}/${a.containers})`, a.withFades === a.containers);
      // 오버플로 표에서 스크롤 → 좌측 fade 활성화 확인
      if (a.overflowed > 0) {
        const leftFadeOn = await page.evaluate(() => {
          const c = Array.from(document.querySelectorAll('[data-slot="table-container"]'))
            .find((el) => {
              const t = el.querySelector("table");
              return t && t.scrollWidth > t.clientWidth + 1;
            });
          if (!c) return null;
          const scroller = c.querySelector(":scope > div");
          scroller.scrollLeft = 80;
          const leftFade = Array.from(c.children).find(
            (ch) => ch.tagName === "DIV" && /gradient/.test(getComputedStyle(ch).backgroundImage)
              && getComputedStyle(ch).left === "0px",
          );
          return leftFade ? getComputedStyle(leftFade).opacity : null;
        });
        await page.waitForTimeout(300);
        const opacityNow = await page.evaluate(() => {
          const c = Array.from(document.querySelectorAll('[data-slot="table-container"]'))
            .find((el) => {
              const t = el.querySelector("table");
              return t && t.scrollWidth > t.clientWidth + 1;
            });
          const leftFade = Array.from(c.children).find(
            (ch) => ch.tagName === "DIV" && /gradient/.test(getComputedStyle(ch).backgroundImage)
              && getComputedStyle(ch).left === "0px",
          );
          return leftFade ? getComputedStyle(leftFade).opacity : null;
        });
        check(`오버플로 표: 스크롤 후 좌측 fade 활성`, opacityNow === "1", `opacity=${opacityNow}`);
      } else {
        console.log("  · 오버플로 표 없음 — fade 활성 검사 스킵(정상: 필요할 때만 표시)");
      }
    }
  }
  console.log(`\n=== RESULT: ${pass} pass / ${fail} fail ===`);
} catch (e) {
  console.error("ERROR:", e);
  fail++;
} finally {
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
}

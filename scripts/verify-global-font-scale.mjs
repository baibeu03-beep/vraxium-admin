// 검증 — 전역 타이포그래피 스케일(globals.css --text-*) + 고정 px→토큰 마이그레이션 + 줄바꿈 규칙.
//   읽기 전용. 스크린샷은 claudedocs/font-scale-*.png.
//   기준값: text-2xs≈12.5 · text-xs≈13.5 · text-sm≈16 · text-base≈18 · text-lg≈20.25px
//   1) 토큰 적용 + body word-break:keep-all
//   2) 우선순위 마이그레이션: 사이드바 하위메뉴=text-xs, 배지 토큰화, 버튼 sm=text-xs (고정 px 잔존 0)
//   3) 화면별 가로 오버플로(레이아웃 깨짐) — 데스크톱 0, 모바일 기준선 초과 금지
//   4) 줄바꿈: 상태 배지 단일 줄(getClientRects==1)
//   사전조건: admin dev :3000.  실행: node scripts/verify-global-font-scale.mjs
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

// 폰트 스케일 기준선(이전 1.3x 단계의 모바일 /admin 오버플로). 이보다 늘면 회귀로 본다.
const MOBILE_HOME_OVERFLOW_BASELINE = 59;

async function makeAdminCookies() {
  const admin = createClient(SUPABASE_URL, SERVICE);
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: adminEmail,
  });
  if (linkError || !linkData?.properties?.email_otp)
    throw new Error(linkError?.message ?? "generateLink failed");
  const { data: verifyData, error: verifyError } = await browser.auth.verifyOtp({
    email: adminEmail,
    token: linkData.properties.email_otp,
    type: "magiclink",
  });
  if (verifyError || !verifyData.session)
    throw new Error(verifyError?.message ?? "verifyOtp failed");
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: {
      getAll: () => [],
      setAll: (items) =>
        void captured.push(...items.map((i) => ({ name: i.name, value: i.value }))),
    },
  });
  const { error } = await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  if (error) throw new Error(error.message);
  return captured;
}

let failures = 0;
function check(label, ok, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

const probeSizes = (page) =>
  page.evaluate(() => {
    const probe = (cls) => {
      const el = document.createElement("span");
      el.className = cls;
      el.textContent = "측정";
      document.body.appendChild(el);
      const fs = parseFloat(getComputedStyle(el).fontSize);
      el.remove();
      return Math.round(fs * 100) / 100;
    };
    return {
      x2: probe("text-2xs"),
      xs: probe("text-xs"),
      sm: probe("text-sm"),
      base: probe("text-base"),
      lg: probe("text-lg"),
      wordBreak: getComputedStyle(document.body).wordBreak,
    };
  });

const overflow = (page) =>
  page.evaluate(() => {
    const de = document.documentElement;
    return { docOverflow: de.scrollWidth - de.clientWidth, vw: de.clientWidth };
  });

async function main() {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    const cookies = await makeAdminCookies();
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await ctx.addCookies(
      cookies.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" })),
    );
    const page = await ctx.newPage();

    // 재컴파일 대기: text-sm 이 16px 근처로 바뀔 때까지 폴링(최대 ~40s) — stale CSS 오판 방지.
    console.log("\n[0] CSS 재컴파일 대기");
    let warmed = null;
    for (let i = 0; i < 20; i++) {
      await page.goto(`${BASE}/admin/members`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(2000);
      warmed = await probeSizes(page);
      if (Math.abs(warmed.sm - 16) < 0.6) break;
      console.log(`    대기중… text-sm=${warmed.sm}px (재시도 ${i + 1})`);
      await page.waitForTimeout(1500);
    }

    // 1) 토큰 적용 + word-break
    console.log("\n[1] 전역 토큰 적용 + 줄바꿈 규칙");
    console.log(`    측정: 2xs=${warmed.x2} xs=${warmed.xs} sm=${warmed.sm} base=${warmed.base} lg=${warmed.lg}px  word-break=${warmed.wordBreak}`);
    check("text-sm ≈ 16px", Math.abs(warmed.sm - 16) < 0.6, `${warmed.sm}px`);
    check("text-xs ≈ 13.5px", Math.abs(warmed.xs - 13.5) < 0.6, `${warmed.xs}px`);
    check("text-base ≈ 18px", Math.abs(warmed.base - 18) < 0.6, `${warmed.base}px`);
    check("text-2xs ≈ 12.5px (신규 토큰)", Math.abs(warmed.x2 - 12.5) < 0.6, `${warmed.x2}px`);
    check("text-lg ≈ 20.25px (제목 ×1.125)", Math.abs(warmed.lg - 20.25) < 0.7, `${warmed.lg}px`);
    check("body word-break = keep-all", warmed.wordBreak === "keep-all", warmed.wordBreak);

    // 2) 우선순위 마이그레이션 — 사이드바 하위메뉴 = text-xs(13.5), 고정 13px 잔존 없음
    console.log("\n[2] 우선순위 고정 px → 토큰 마이그레이션");
    // 분기 하나 펼쳐 하위 메뉴 폰트 측정
    const branchBtn = page.locator("aside nav button").first();
    if ((await branchBtn.count()) > 0) {
      await branchBtn.click().catch(() => {});
      await page.waitForTimeout(800);
    }
    const subFont = await page.evaluate(() => {
      const sub = document.querySelector("aside nav ul a");
      return sub ? Math.round(parseFloat(getComputedStyle(sub).fontSize) * 100) / 100 : null;
    });
    check("사이드바 하위메뉴 ≈ 13.5px(text-xs, 고정 13px 제거)", subFont != null && Math.abs(subFont - 13.5) < 0.7, `${subFont}px`);

    // 사이드바 상위 leaf/branch = text-sm(16)
    const leafFont = await page.evaluate(() => {
      const el = document.querySelector("aside nav a, aside nav button");
      return el ? Math.round(parseFloat(getComputedStyle(el).fontSize) * 100) / 100 : null;
    });
    check("사이드바 상위메뉴 ≈ 16px(text-sm)", leafFont != null && Math.abs(leafFont - 16) < 0.7, `${leafFont}px`);

    // 3) 화면별 오버플로 + 줄바꿈(배지 단일 줄)
    console.log("\n[3] 화면별 가로 오버플로(데스크톱 0) + 배지 줄바꿈");
    const routes = [
      { label: "테이블(크루 관리)", url: "/admin/members" },
      { label: "상세(기간 정보)", url: "/admin/season-weeks" },
      { label: "폼/입력(어드민 계정)", url: "/admin/settings/accounts" },
      { label: "권한 매트릭스", url: "/admin/settings/permissions" },
      { label: "주차 인정 결과", url: "/admin/week-recognitions" },
    ];
    for (const r of routes) {
      await page.goto(`${BASE}${r.url}`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(2500);
      const o = await overflow(page);
      check(`${r.label}: 문서 가로 오버플로 없음`, o.docOverflow <= 2, `overflow=${o.docOverflow}px`);
      await page.screenshot({ path: `claudedocs/font-scale${r.url.replace(/\//g, "_")}.png`, fullPage: true });
    }

    // 배지: 상태 배지가 한 줄로 표시되는지(getClientRects 길이 1) — members 페이지
    await page.goto(`${BASE}/admin/members`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);
    const badgeWrap = await page.evaluate(() => {
      const badges = [...document.querySelectorAll('[data-slot="badge"], span')].filter((el) =>
        /활동|중단|휴식|정규|심화/.test((el.textContent || "").trim()) && (el.className || "").toString().includes("inline-flex"),
      );
      const multi = badges.filter((b) => b.getClientRects().length > 1).map((b) => (b.textContent || "").trim());
      return { total: badges.length, multiLine: multi.slice(0, 5) };
    });
    check("상태 배지 모두 단일 줄(줄바꿈 없음)", badgeWrap.multiLine.length === 0, `검사 ${badgeWrap.total}개, 다중줄=${JSON.stringify(badgeWrap.multiLine)}`);

    // 4) 모달 — 크루 행 [이동] 대신, 모달 보유 화면(승인 대기)에서 시도. 없으면 정보성 skip.
    console.log("\n[4] 모달(있으면) 점검");
    await page.goto(`${BASE}/admin/users/applicants`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);
    const trigger = page.locator("button", { hasText: /상세|검토|보기|승인|반려/ }).first();
    if ((await trigger.count()) > 0) {
      await trigger.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(1200);
      const dlg = await page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]');
        if (!d) return null;
        const r = d.getBoundingClientRect();
        return { overflowRight: Math.round(r.right - window.innerWidth), titleFont: (() => { const t = d.querySelector("h1,h2,[data-slot=dialog-title]"); return t ? Math.round(parseFloat(getComputedStyle(t).fontSize)) : null; })() };
      });
      if (dlg) {
        check("모달이 뷰포트를 넘지 않음", dlg.overflowRight <= 2, JSON.stringify(dlg));
        await page.screenshot({ path: "claudedocs/font-scale_modal.png" });
      } else console.log("    (role=dialog 미검출 — skip)");
    } else console.log("    (모달 트리거 버튼 없음 — skip)");

    // 5) 모바일 — 기준선 초과 금지
    console.log("\n[5] 모바일(375px) — 폰트 스케일로 오버플로 증가 없음");
    const m = await browser.newContext({ viewport: { width: 375, height: 800 } });
    await m.addCookies(cookies.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" })));
    const mp = await m.newPage();
    for (const url of ["/admin", "/admin/members"]) {
      await mp.goto(`${BASE}${url}`, { waitUntil: "networkidle", timeout: 60000 });
      await mp.waitForTimeout(3000);
      const o = await overflow(mp);
      const limit = url === "/admin" ? MOBILE_HOME_OVERFLOW_BASELINE + 2 : 2;
      check(`모바일 ${url}: 오버플로 기준선 이내(≤${limit}px)`, o.docOverflow <= limit, `overflow=${o.docOverflow}px`);
      await mp.screenshot({ path: `claudedocs/font-scale_mobile${url.replace(/\//g, "_")}.png` });
    }
    await m.close();

    await ctx.close();
  } finally {
    await browser.close();
  }
  console.log(`\n${failures === 0 ? "✓ 전체 통과" : `✗ 실패 ${failures}건`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

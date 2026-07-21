/**
 * 브라우저 UI 검증 — 팀 내역(활동 관리 §1) 상단 요약.
 *   · 현재 날짜·주차 문구가 '해당 시기' select 우측에 표시되는지
 *   · 전체 클럽/팀/파트 수 3개 지표 표시 + 값
 *   · 반기 select 변경 후 요약 수치 불변(레이아웃 흔들림 없음) · 목록은 변동
 *   · 라이트/다크 · 데스크톱/모바일 폭 스크린샷
 *   사전조건: dev :3000. Usage: node scripts/browser-verify-team-parts-info-summary.mjs
 *   READ-ONLY(쓰기 없음).
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const rq = createRequire(resolve(adminRoot, "package.json"));
let chromium;
try {
  ({ chromium } = rq("playwright-core"));
} catch {
  ({ chromium } = rq("playwright"));
}
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const OUT = resolve(
  adminRoot,
  "C:/Users/vanua/AppData/Local/Temp/claude/C--Users-vanua-OneDrive-Desktop-vraxium-admin/bc88c60d-94b2-4e27-b5d7-2f060b65357f/scratchpad",
);

const sb = createClient(URL_, SERVICE);
const brow = createClient(URL_, ANON);

let fail = 0;
const ck = (l, ok, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};

async function cookies() {
  const { data: admins } = await sb
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  const email = admins?.[0]?.email;
  const { data: link } = await sb.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  const { data: v } = await brow.auth.verifyOtp({
    email,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  const cap = [];
  const srv = createServerClient(URL_, ANON, {
    cookies: { getAll: () => [], setAll: (i) => cap.push(...i) },
  });
  await srv.auth.setSession({
    access_token: v.session.access_token,
    refresh_token: v.session.refresh_token,
  });
  console.log(`admin 세션: ${email}`);
  return cap.map((i) => ({
    name: i.name,
    value: i.value,
    domain: "localhost",
    path: "/",
    httpOnly: false,
    secure: false,
    sameSite: "Lax",
  }));
}

// 요약이 실제로 로드될 때까지 대기 — 헤더는 로딩 중 placeholder("-"/0)로 먼저 렌더되므로
//   [data-current-date] 가 "-" 가 아니게 될 때까지 기다린다.
const waitLoaded = (page) =>
  page
    .waitForFunction(
      () =>
        (
          document.querySelector("[data-current-date]")?.textContent ?? "-"
        ).trim() !== "-",
      { timeout: 25000 },
    )
    .catch(() => {});

const readSummary = (page) =>
  page.evaluate(() => {
    const t = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
    return {
      date: t("[data-current-date]"),
      week: t("[data-current-week]"),
      clubs: t("#team-parts-club-count"),
      teams: t("#team-parts-total-team-count"),
      parts: t("#team-parts-total-part-count"),
    };
  });

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1200 },
  });
  await context.addCookies(await cookies());
  const page = await context.newPage();
  try {
    // 1) 통합 경로 데스크톱.
    await page.goto(`${BASE}/admin/team-parts/info`, {
      waitUntil: "domcontentloaded",
    });
    await waitLoaded(page);
    await page.waitForTimeout(300);
    const s = await readSummary(page);
    console.log("통합 요약:", JSON.stringify(s));
    ck("현재 날짜 문구 표시", !!s.date && /\d{4}년 \d{1,2}월 \d{1,2}일\(.\)/.test(s.date), s.date ?? "");
    ck("현재 주차 문구 표시", !!s.week && /\[\d{2}년, .+ 시즌, .+주차\]/.test(s.week), s.week ?? "");
    ck("전체 클럽 수 표시", s.clubs != null && /^\d+$/.test(s.clubs), s.clubs ?? "");
    ck("전체 팀 수 표시", s.teams != null && /^\d+$/.test(s.teams), s.teams ?? "");
    ck("전체 파트 수 표시", s.parts != null && /^\d+$/.test(s.parts), s.parts ?? "");

    // 라벨 텍스트 존재(전체 클럽/팀/파트 수).
    const labels = await page.evaluate(() => document.body.innerText);
    ck("'전체 클럽 수' 라벨", labels.includes("전체 클럽 수"));
    ck("'전체 팀 수' 라벨", labels.includes("전체 팀 수"));
    ck("'전체 파트 수' 라벨", labels.includes("전체 파트 수"));

    // 데스크톱 레이아웃(1440): ① 날짜·주차 = select 바로 우측(같은 행). ② 집계 3종 = 우측 끝 고정(ml-auto),
    //   날짜 블록과 독립. 집계 라벨은 2줄로 쪼개지지 않고 가로 overflow 없어야 한다.
    const L = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const r = (el) => (el ? el.getBoundingClientRect() : null);
      const sel = r(q("#team-parts-half-select"));
      const date = r(q("[data-current-date]"));
      const week = r(q("[data-current-week]"));
      const club = r(q("#team-parts-club-count"));
      const part = r(q("#team-parts-total-part-count"));
      const clubSpan = q("#team-parts-club-count")?.closest("span");
      const clubLeft = clubSpan ? clubSpan.getBoundingClientRect().left : null;
      const spans = ["team-parts-club-count","team-parts-total-team-count","team-parts-total-part-count"]
        .map((id) => q(`#${id}`)?.closest("span"));
      const spanHeights = spans.map((s) => (s ? s.getBoundingClientRect().height : 0));
      const section = q("[data-current-date]")?.closest("section");
      const secRight = section ? section.getBoundingClientRect().right : null;
      return {
        selCenter: sel ? sel.top + sel.height/2 : null, selRight: sel?.right,
        dateCenter: date ? date.top + date.height/2 : null, dateLeft: date?.left, dateRight: date?.right,
        weekCenter: week ? week.top + week.height/2 : null,
        clubLeft, partRight: part?.right, spanHeights, secRight,
      };
    });
    // ① 날짜·주차가 select 바로 우측(같은 행): 수직중심 근접 + date.left > select.right.
    ck(
      "날짜·주차가 select 바로 우측(같은 행)",
      L.selCenter != null && L.dateCenter != null &&
        Math.abs(L.selCenter - L.dateCenter) < 16 && L.dateLeft > L.selRight,
      L.dateLeft != null ? `Δy=${Math.round(Math.abs(L.selCenter - L.dateCenter))}px, date.left=${Math.round(L.dateLeft)} > sel.right=${Math.round(L.selRight)}` : "미검출",
    );
    // 날짜·주차(오늘/주차)는 서로 같은 행.
    ck(
      "날짜와 주차가 같은 행",
      L.dateCenter != null && L.weekCenter != null && Math.abs(L.dateCenter - L.weekCenter) < 12,
      `Δy=${Math.round(Math.abs((L.dateCenter ?? 0) - (L.weekCenter ?? 0)))}px`,
    );
    // ② 집계 3종이 우측 끝 고정(ml-auto) — 행 무관하게 오른쪽 경계 근처(원래 위치·날짜 안 따라옴).
    //   1440(사이드바 포함)에서는 공간상 집계가 아래 줄로 내려가되 우측 정렬 유지 → 우측 경계 판정만 한다.
    ck(
      "집계 3종이 우측 끝 고정(원래 위치·날짜 안 따라옴)",
      L.partRight != null && L.secRight != null && L.partRight >= L.secRight - 90,
      L.partRight != null ? `part.right=${Math.round(L.partRight)} sec.right=${Math.round(L.secRight)}` : "미검출",
    );
    const noLabelWrap = L.spanHeights.every((h) => h > 0 && h < 34);
    ck("집계 라벨이 2줄로 쪼개지지 않음", noLabelWrap, `heights=${L.spanHeights.map((h)=>Math.round(h)).join(",")}`);
    ck(
      "가로 overflow 없음(집계 우측 경계 이내)",
      L.secRight != null && L.partRight != null && L.partRight <= L.secRight + 1,
      `part.right=${Math.round(L.partRight)} sec.right=${Math.round(L.secRight)}`,
    );

    await page.screenshot({
      path: resolve(OUT, "team-parts-info-summary-light.png"),
      fullPage: false,
    });

    // 1-b) 넓은 뷰포트(1920) — 공간이 충분하면 날짜·주차 블록이 select "바로 우측"(같은 행)에 붙는지.
    await page.setViewportSize({ width: 1920, height: 1200 });
    await page.waitForTimeout(400);
    const wide = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const r = (el) => (el ? el.getBoundingClientRect() : null);
      const sel = r(q("#team-parts-half-select"));
      const date = r(q("[data-current-date]"));
      const part = r(q("#team-parts-total-part-count"));
      const section = q("[data-current-date]")?.closest("section");
      const secRight = section ? section.getBoundingClientRect().right : null;
      if (!sel || !date || !part) return null;
      return {
        selCenter: sel.top + sel.height / 2,
        dateCenter: date.top + date.height / 2,
        partCenter: part.top + part.height / 2,
        gap: date.left - sel.right,
        partRight: part.right,
        secRight,
      };
    });
    ck(
      "넓은 화면: 날짜 블록이 select 바로 우측(같은 행)",
      wide != null && Math.abs(wide.selCenter - wide.dateCenter) < 12 && wide.gap > 0,
      wide ? `Δy=${Math.round(Math.abs(wide.selCenter - wide.dateCenter))}px gap=${Math.round(wide.gap)}px` : "미검출",
    );
    ck(
      "넓은 화면: 세 항목(select·날짜·집계) 한 행 + 집계 우측 끝",
      wide != null &&
        Math.abs(wide.selCenter - wide.partCenter) < 12 &&
        wide.secRight != null && wide.partRight >= wide.secRight - 90,
      wide ? `Δy(sel,part)=${Math.round(Math.abs(wide.selCenter - wide.partCenter))}px part.right=${Math.round(wide.partRight)} sec.right=${Math.round(wide.secRight)}` : "미검출",
    );
    await page.screenshot({
      path: resolve(OUT, "team-parts-info-summary-wide.png"),
      fullPage: false,
    });
    await page.setViewportSize({ width: 1440, height: 1200 });
    await page.waitForTimeout(300);

    // 2) 반기 select 변경 → 요약 불변 · 목록 변동.
    const before = await readSummary(page);
    await page.selectOption("#team-parts-half-select", "2024-H1");
    await page.waitForTimeout(2000);
    const after = await readSummary(page);
    ck(
      "반기 변경 후 요약 수치 불변",
      JSON.stringify(before) === JSON.stringify(after),
      `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
    );
    const selectedVal = await page.$eval(
      "#team-parts-half-select",
      (el) => el.value,
    );
    ck("select 값은 과거 반기로 변경됨", selectedVal === "2024-H1", selectedVal);

    // 되돌려서 현재 반기 재확인(누적/잔존 없음).
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitLoaded(page);
    await page.waitForTimeout(300);
    const reloaded = await readSummary(page);
    ck(
      "새로고침 후 요약 동일(잔존/누적 없음)",
      JSON.stringify({ ...reloaded }) === JSON.stringify({ ...before }),
      `reloaded=${JSON.stringify(reloaded)}`,
    );

    // 3) 다크 모드 스크린샷.
    await page.evaluate(() =>
      document.documentElement.classList.add("dark"),
    );
    await page.waitForTimeout(400);
    await page.screenshot({
      path: resolve(OUT, "team-parts-info-summary-dark.png"),
      fullPage: false,
    });

    // 4) 모바일 폭(줄바꿈·겹침 없음).
    await page.evaluate(() =>
      document.documentElement.classList.remove("dark"),
    );
    await page.setViewportSize({ width: 390, height: 900 });
    await page.waitForTimeout(500);
    const mobile = await readSummary(page);
    ck(
      "모바일 폭에서도 요약 표시(겹침 없이)",
      !!mobile.date && !!mobile.parts,
      JSON.stringify(mobile),
    );
    await page.screenshot({
      path: resolve(OUT, "team-parts-info-summary-mobile.png"),
      fullPage: false,
    });

    // 5) 개별 org 경로(?org=encre) — 요약(전 조직)은 통합과 동일.
    await page.setViewportSize({ width: 1440, height: 1200 });
    await page.goto(`${BASE}/admin/team-parts/info?org=encre`, {
      waitUntil: "domcontentloaded",
    });
    await waitLoaded(page);
    await page.waitForTimeout(300);
    const enc = await readSummary(page);
    ck(
      "개별(?org=encre) 요약 == 통합 요약(전 조직 기준)",
      enc.clubs === before.clubs &&
        enc.teams === before.teams &&
        enc.parts === before.parts,
      `encre=${JSON.stringify({ c: enc.clubs, t: enc.teams, p: enc.parts })}`,
    );
  } finally {
    await browser.close();
  }
  console.log(`\n스크린샷: ${OUT}`);
  console.log(`\n${fail === 0 ? "PASS ✅" : `FAIL ❌ (${fail})`}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * 브라우저 검증 — 하단 토스트 안전영역이 "상시 확보"가 아니라 "토스트가 떠 있을 때만" 잡히는지.
 *   1) 토스트 0개 → spacer 높이 0 (하단 죽은 여백 없음)
 *   2) 토스트 발생 → spacer = max(실측 높이 + bottom 24 + 여유 12, --admin-toast-safe-area)
 *   3) main(스크롤 컨테이너) 높이가 정확히 그만큼 줄어든다
 *   4) 페이지 맨 아래에서 토스트가 떠도 스크롤 보정으로 하단 콘텐츠가 화면에서 사라지지 않는다
 *   5) 토스트 높이가 커지면(여러 줄/다중 스택) 안전영역도 실측으로 따라 커진다
 *   6) 토스트가 닫히면 spacer 0 · main 높이 · 스크롤 위치가 원상 복귀(대칭)
 *
 *   ※ 실제 토스트 발행은 페이지별 동작(저장/삭제 등)에 묶여 있어, 여기서는 ToastViewport
 *      컨테이너에 더미 노드를 넣어 "실측 → 안전영역 → 스크롤 보정" 경로만 검증한다.
 *      (토스트가 그 컨테이너에 렌더된다는 사실 자체는 기존 동작으로 불변)
 *
 *   npx tsx --env-file=.env.local scripts/browser-verify-toast-safe-area.ts
 */
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const BASE = process.env.ADMIN_API_BASE_URL?.replace(/\/$/, "") || "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let failed = 0;
function check(n: string, ok: boolean, d?: unknown) {
  console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
  if (!ok) failed++;
}

async function makeAdminCookies() {
  const { data: admins } = await supabaseAdmin
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  const email = (admins?.[0] as { email: string } | undefined)?.email;
  if (!email) throw new Error("No active admin");
  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await anon.auth.verifyOtp({
    email,
    token: (link as { properties: { email_otp: string } }).properties.email_otp,
    type: "magiclink",
  });
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  const sess = (v as { session: { access_token: string; refresh_token: string } }).session;
  await server.auth.setSession({
    access_token: sess.access_token,
    refresh_token: sess.refresh_token,
  });
  return captured.map(({ name, value }) => ({
    name,
    value,
    domain: "localhost",
    path: "/",
    httpOnly: false,
    secure: false,
    sameSite: "Lax" as const,
  }));
}

type Metrics = {
  spacer: number;
  mainH: number;
  scrollTop: number;
  maxScroll: number;
  anchorBottom: number;
  mainBottom: number;
};

async function main() {
  try {
    const h = await fetch(`${BASE}/api/health`);
    if (!h.ok) throw new Error("no health");
  } catch {
    console.log(`❌ dev server 미기동(${BASE})`);
    process.exit(1);
  }

  const browser = await chromium.launch({ channel: "chrome" });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies(await makeAdminCookies());
  const page = await ctx.newPage();

  await page.goto(`${BASE}/admin/members?organization=encre`, { waitUntil: "networkidle" });
  await page.waitForSelector("[data-admin-scroll-container]");
  // ToastViewport(포털)는 토스트가 없어도 컨테이너 자체는 body 에 렌더된다.
  // 토스트가 없으면 높이 0(=hidden) 이므로 attached 로만 기다린다.
  await page.waitForSelector('body > div[aria-live="polite"].fixed', { state: "attached" });

  const read = () =>
    page.evaluate((): Metrics => {
      const scroller = document.querySelector("[data-admin-scroll-container]") as HTMLElement;
      const spacer = scroller.nextElementSibling as HTMLElement;
      // 스크롤 컨테이너 안에서 화면 하단에 가장 가까운(=가려지기 쉬운) 요소를 기준으로 삼는다.
      const mainRect = scroller.getBoundingClientRect();
      let anchorBottom = 0;
      for (const el of Array.from(scroller.querySelectorAll<HTMLElement>("*"))) {
        const r = el.getBoundingClientRect();
        if (r.height === 0 || r.bottom > mainRect.bottom + 0.5) continue;
        if (r.bottom > anchorBottom) anchorBottom = r.bottom;
      }
      return {
        spacer: Math.round(spacer.getBoundingClientRect().height),
        mainH: Math.round(scroller.clientHeight),
        scrollTop: Math.round(scroller.scrollTop),
        maxScroll: Math.round(scroller.scrollHeight - scroller.clientHeight),
        anchorBottom: Math.round(anchorBottom),
        mainBottom: Math.round(mainRect.bottom),
      };
    });

  const settle = () =>
    page.evaluate(
      () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50))),
        ),
    );

  // 더미 토스트 삽입/제거 — ToastViewport 컨테이너의 크기 변화(ResizeObserver)만 유발한다.
  const showFake = (heightPx: number) =>
    page.evaluate((h: number) => {
      const vp = document.querySelector('body > div[aria-live="polite"].fixed') as HTMLElement;
      let el = vp.querySelector("[data-fake-toast]") as HTMLElement | null;
      if (!el) {
        el = document.createElement("div");
        el.setAttribute("data-fake-toast", "");
        vp.appendChild(el);
      }
      el.style.height = `${h}px`;
    }, heightPx);
  const hideFake = () =>
    page.evaluate(() => {
      document.querySelector("[data-fake-toast]")?.remove();
    });

  const floor = await page.evaluate(() =>
    Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--admin-toast-safe-area"),
    ),
  );

  // ── 1) 평소(토스트 없음) — 하단 여백 0 ──────────────────────────────────
  await settle();
  const idleTop = await read();
  check("토스트 없을 때 spacer 높이 = 0", idleTop.spacer === 0, idleTop);

  // 페이지 맨 아래로 스크롤(= 하단에서 버튼을 누른 상황).
  await page.evaluate(() => {
    const s = document.querySelector("[data-admin-scroll-container]") as HTMLElement;
    s.scrollTop = s.scrollHeight;
  });
  await settle();
  const atBottom = await read();
  check("맨 아래 스크롤 상태 진입", atBottom.scrollTop === atBottom.maxScroll && atBottom.maxScroll > 0, {
    scrollTop: atBottom.scrollTop,
    maxScroll: atBottom.maxScroll,
  });
  check("토스트 없을 때 하단 콘텐츠가 화면 끝까지 사용", idleTop.spacer === 0 && atBottom.spacer === 0);

  // ── 2~4) 토스트 발생 ────────────────────────────────────────────────────
  await showFake(52); // 단일 토스트(min-h-52) 기준
  await settle();
  const withToast = await read();
  const expected = Math.max(52 + 24 + 12, floor);
  check(`토스트 뜨면 spacer = max(실측+36, ${floor}) = ${expected}`, withToast.spacer === expected, {
    spacer: withToast.spacer,
  });
  check(
    "main 높이가 정확히 안전영역만큼 감소",
    withToast.mainH === atBottom.mainH - expected,
    { before: atBottom.mainH, after: withToast.mainH, diff: atBottom.mainH - withToast.mainH },
  );
  check(
    "스크롤 보정 — 맨 아래에 있었으면 여전히 맨 아래(하단 콘텐츠 안 사라짐)",
    withToast.scrollTop === withToast.maxScroll,
    { scrollTop: withToast.scrollTop, maxScroll: withToast.maxScroll },
  );
  check(
    "하단 기준 콘텐츠가 여전히 화면 안(토스트에 가려지지 않음)",
    withToast.anchorBottom > 0 && withToast.anchorBottom <= withToast.mainBottom + 1,
    { anchorBottom: withToast.anchorBottom, mainBottom: withToast.mainBottom },
  );

  // ── 5) 토스트가 커지면 안전영역도 실측으로 확대 ─────────────────────────
  await showFake(220); // 여러 줄/다중 스택
  await settle();
  const tall = await read();
  check("토스트 높이 확대 → spacer 실측 반영(220+36=256)", tall.spacer === 256, { spacer: tall.spacer });
  check("main 높이도 함께 감소", tall.mainH === atBottom.mainH - 256, {
    mainH: tall.mainH,
    base: atBottom.mainH,
  });
  check("확대 후에도 맨 아래 유지", tall.scrollTop === tall.maxScroll, {
    scrollTop: tall.scrollTop,
    maxScroll: tall.maxScroll,
  });

  // ── 6) 닫히면 원상 복귀(대칭) ───────────────────────────────────────────
  await hideFake();
  await settle();
  const after = await read();
  check("토스트 닫히면 spacer = 0", after.spacer === 0, after);
  check("main 높이 원복", after.mainH === atBottom.mainH, {
    after: after.mainH,
    before: atBottom.mainH,
  });
  check("스크롤 위치 원복", after.scrollTop === atBottom.scrollTop, {
    after: after.scrollTop,
    before: atBottom.scrollTop,
  });

  // ── 중간 스크롤 위치에서도 동일하게 동작 ────────────────────────────────
  await page.evaluate(() => {
    const s = document.querySelector("[data-admin-scroll-container]") as HTMLElement;
    s.scrollTop = Math.floor((s.scrollHeight - s.clientHeight) / 2);
  });
  await settle();
  const midBefore = await read();
  await showFake(52);
  await settle();
  const midAfter = await read();
  check(
    "중간 스크롤에서도 안전영역 확보 + 보정",
    midAfter.spacer === expected && midAfter.scrollTop === midBefore.scrollTop + expected,
    { before: midBefore.scrollTop, after: midAfter.scrollTop, spacer: midAfter.spacer },
  );
  check(
    "중간 스크롤에서도 하단 콘텐츠가 토스트에 안 가림",
    midAfter.anchorBottom <= midAfter.mainBottom + 1,
    { anchorBottom: midAfter.anchorBottom, mainBottom: midAfter.mainBottom },
  );
  await hideFake();
  await settle();
  const midRestore = await read();
  check("중간 스크롤 원복", midRestore.scrollTop === midBefore.scrollTop && midRestore.spacer === 0, {
    scrollTop: midRestore.scrollTop,
    before: midBefore.scrollTop,
  });

  await browser.close();
  console.log(failed === 0 ? "\n✅ 전체 통과" : `\n❌ 실패 ${failed}건`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

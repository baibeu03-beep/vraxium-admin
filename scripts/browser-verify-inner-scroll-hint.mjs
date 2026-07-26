// 표 내부 세로 스크롤 UX 검증 — "스크롤 이동은 표 바깥에서 해주세요." 배지 + 공통 스크롤바.
//   (1) 긴 표(내부 스크롤 가능) → 휠 돌려도 배지 안 뜸 / 내부 스크롤만 정상 동작
//   (2) 짧은 표(내부 스크롤 불가) → 휠 시 배지 표시 · 상단 우측(헤더 행 높이 안) · 자동 소멸 · 연속 휠 연장
//   (3) 필터 적용해 행 수가 줄면 → 배지 표시로 전환
//   (4) 필터 해제로 다시 길어지면 → 배지 안 뜸
//   (5) 페이지 중간(스크롤해야 보이는) 표에서도 동일 동작
//   (6) 한 페이지 여러 표 — 휠을 돌린 그 표에서만 표시(표 간 간섭 없음)
//   (7) 좌측 사이드바 스크롤바 = 표 내부 스크롤바와 동일 계약, 페이지 스크롤바는 미변경
// ⚠ 이 앱의 페이지 스크롤 컨테이너는 window 가 아니라 main[data-admin-scroll-container].
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
  const b = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await b.auth.verifyOtp({
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
const shown = (op) => op != null && Number(op) > 0.9;
const hidden = (op) => op != null && Number(op) < 0.1;

const browser = await chromium.launch({ channel: "chromium", headless: process.env.HEADLESS === "1" });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();

const goto = async (url) => {
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
  } catch {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  }
  await page.waitForTimeout(3500);
};

// 세로 내부 스크롤 영역(.sticky-head-region) 표 인벤토리 + 배지 상태(보이는 표만).
const inventory = () =>
  page.evaluate(() => {
    const out = [];
    document.querySelectorAll('[data-slot="table-container"]').forEach((c, i) => {
      const sc = c.querySelector(":scope > div.sticky-head-region");
      if (!sc) return;
      const cr = c.getBoundingClientRect();
      const sr = sc.getBoundingClientRect();
      const badge = Array.from(c.children).find(
        (ch) => ch.tagName === "DIV" && ch.textContent && ch.textContent.includes("표 바깥에서"),
      );
      const br = badge ? badge.getBoundingClientRect() : null;
      const headRow = sc.querySelector("thead tr");
      const hr = headRow ? headRow.getBoundingClientRect() : null;
      out.push({
        index: i,
        visible: Boolean((sc.offsetParent || sc.getClientRects().length) && sr.height >= 20),
        rows: sc.querySelectorAll("tbody tr").length,
        scrollH: sc.scrollHeight,
        clientH: sc.clientHeight,
        vScrollable: sc.scrollHeight - sc.clientHeight > 1,
        scrollTop: sc.scrollTop,
        badgeMounted: Boolean(badge),
        badgeOpacity: badge ? getComputedStyle(badge).opacity : null,
        badgeZ: badge ? getComputedStyle(badge).zIndex : null,
        badgeText: badge ? badge.textContent.trim() : null,
        badgeCenterDx: br ? Math.round(br.left + br.width / 2 - (cr.left + cr.width / 2)) : null,
        badgeTopGap: br ? Math.round(br.top - cr.top) : null,
        badgeRightGap: br ? Math.round(cr.right - br.right) : null,
        // 헤더 행 아래(=본문 행 영역)로 내려가지 않았는지 — "제목 바로 아래/헤더 근처" 요구.
        badgeWithinHeaderBand: br && hr ? br.bottom <= hr.bottom + 1 : null,
        badgeInsideTable: br ? br.top >= cr.top - 1 && br.bottom <= cr.bottom + 1 : null,
        docTop: Math.round(sr.top + (document.querySelector("main[data-admin-scroll-container]")?.scrollTop ?? 0)),
      });
    });
    return out;
  });

const at = async (idx) => (await inventory()).find((t) => t.index === idx);
// 서버 재조회(필터/페이지 변경)는 지연이 있어 조건이 만족될 때까지 폴링한다.
const waitFor = async (pred, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    const inv = await inventory();
    if (pred(inv)) return inv;
    if (Date.now() - t0 > ms) return inv;
    await page.waitForTimeout(500);
  }
};
const pageScrollTop = () =>
  page.evaluate(() => document.querySelector("main[data-admin-scroll-container]")?.scrollTop ?? window.scrollY);

// 표 중앙으로 커서를 옮기고 실제 휠 입력(코드가 가로채지 않음 — 관찰만).
// 반환값 = 휠 직전의 페이지 스크롤 위치(scrollIntoView 로 인한 이동은 제외하고 비교하기 위함).
const wheelOver = async (idx, dy = 200) => {
  await page.evaluate((i) => {
    document.querySelectorAll('[data-slot="table-container"]')[i]
      .querySelector(":scope > div.sticky-head-region")
      .scrollIntoView({ block: "center" });
  }, idx);
  await page.waitForTimeout(600);
  const pt = await page.evaluate((i) => {
    const r = document.querySelectorAll('[data-slot="table-container"]')[i]
      .querySelector(":scope > div.sticky-head-region").getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, idx);
  await page.mouse.move(pt.x, pt.y);
  // 프로그램적 스크롤 직후에는 hit-test 갱신에 한 프레임 이상 걸린다 — 휠 전에 안정화 대기.
  await page.waitForTimeout(400);
  const pageBefore = await pageScrollTop();
  await page.mouse.wheel(0, dy);
  await page.waitForTimeout(500); // opacity transition(300ms) 완료 대기
  return pageBefore;
};

try {
  // ── (1) 긴 표 ────────────────────────────────────────────────────────────────
  console.log("\n[1] 긴 표 — /admin/members?org=encre");
  await goto(`${BASE}/admin/members?org=encre`);
  let inv = await inventory();
  console.log("  ", JSON.stringify(inv.map(({ index, rows, scrollH, clientH, vScrollable }) => ({ index, rows, scrollH, clientH, vScrollable }))));
  const longIdx = inv.find((t) => t.vScrollable && t.visible)?.index;
  check("긴 표: 내부 세로 스크롤 가능(scrollHeight > clientHeight)", longIdx !== undefined,
    longIdx !== undefined ? `${inv[0].scrollH}>${inv[0].clientH}` : "없음");
  check("배지 DOM 은 세로 스크롤 영역 표에 마운트됨", inv[0]?.badgeMounted === true);
  if (longIdx !== undefined) {
    const before = await wheelOver(longIdx);
    const t = await at(longIdx);
    check("긴 표에서 휠 → 안내 배지 표시 안 됨", hidden(t.badgeOpacity), `opacity=${t.badgeOpacity}`);
    check("긴 표에서 휠 → 내부 세로 스크롤만 정상 진행", t.scrollTop > 0, `scrollTop=${t.scrollTop}`);
    check("휠 개입 없음(페이지 강제 스크롤 미발생)", (await pageScrollTop()) === before,
      `pageScrollTop ${before}→${await pageScrollTop()}`);
    await page.screenshot({ path: resolve(adminRoot, "claudedocs", "qa-innerscroll-1-long.png") });
  }

  // ── (3) 필터로 행 수 축소 ────────────────────────────────────────────────────
  console.log("\n[3] 필터 적용으로 행 수 축소 — 같은 표");
  const search = page.locator('input[placeholder*="부분검색"]').first();
  check("검색(필터) 입력창 존재", (await search.count()) > 0);
  const term = await page.evaluate((i) => {
    const c = document.querySelectorAll('[data-slot="table-container"]')[i];
    for (const td of c.querySelectorAll("tbody tr:first-child td")) {
      const t = td.textContent.trim();
      if (t.length >= 2 && t.length <= 12 && !/^\d+$/.test(t)) return t;
    }
    return null;
  }, longIdx);
  console.log(`   필터어: ${JSON.stringify(term)}`);
  await search.fill(term ?? "가");
  await search.press("Enter");
  inv = await waitFor((v) => v.some((t) => t.visible && !t.vScrollable));
  console.log("  ", JSON.stringify(inv.map(({ index, rows, scrollH, clientH, vScrollable }) => ({ index, rows, scrollH, clientH, vScrollable }))));
  const filteredIdx = inv.find((t) => !t.vScrollable && t.visible)?.index;
  check("필터 후 행 수 감소 → 내부 스크롤 불가 상태", filteredIdx !== undefined,
    filteredIdx !== undefined ? `rows=${inv.find((t) => t.index === filteredIdx).rows}` : "여전히 스크롤 가능");
  if (filteredIdx !== undefined) {
    check("휠 전에는 배지 숨김", hidden((await at(filteredIdx)).badgeOpacity));
    const before = await wheelOver(filteredIdx);
    const t = await at(filteredIdx);
    check("필터로 짧아진 표에서 휠 → 배지 표시", shown(t.badgeOpacity), `opacity=${t.badgeOpacity}`);
    check("휠 미개입(window.scrollBy 등 강제 페이지 이동 없음)", (await pageScrollTop()) === before,
      `pageScrollTop ${before}→${await pageScrollTop()}`);
    await page.screenshot({ path: resolve(adminRoot, "claudedocs", "qa-innerscroll-3-filtered.png") });
  }

  // ── (4) 필터 해제 ────────────────────────────────────────────────────────────
  console.log("\n[4] 필터 해제 — 다시 길어짐");
  const reset = page.locator('button:has-text("초기화")').first();
  if (await reset.count()) await reset.click();
  else { await search.fill(""); await search.press("Enter"); }
  inv = await waitFor((v) => v.some((t) => t.visible && t.vScrollable));
  console.log("  ", JSON.stringify(inv.map(({ index, rows, scrollH, clientH, vScrollable }) => ({ index, rows, scrollH, clientH, vScrollable }))));
  const backIdx = inv.find((t) => t.vScrollable && t.visible)?.index;
  check("필터 해제 후 다시 내부 스크롤 가능", backIdx !== undefined,
    backIdx !== undefined ? `${inv[0].scrollH}>${inv[0].clientH}` : "복구 실패");
  if (backIdx !== undefined) {
    await wheelOver(backIdx);
    const t = await at(backIdx);
    check("필터 해제 후 휠 → 배지 표시 안 됨", hidden(t.badgeOpacity), `opacity=${t.badgeOpacity}`);
    check("내부 세로 스크롤 정상", t.scrollTop > 0, `scrollTop=${t.scrollTop}`);
  }

  // ── (2) 짧은 표(자연 상태) + 배지 형태/타이밍 ────────────────────────────────
  console.log("\n[2] 짧은 표(원래 짧음) — /admin/applicants?org=encre");
  await goto(`${BASE}/admin/applicants?org=encre`);
  inv = await inventory();
  console.log("  ", JSON.stringify(inv.map(({ index, rows, scrollH, clientH, vScrollable }) => ({ index, rows, scrollH, clientH, vScrollable }))));
  const shortIdx = inv.find((t) => !t.vScrollable && t.visible)?.index;
  check("짧은 표: 내부 스크롤 불가(scrollHeight <= clientHeight)", shortIdx !== undefined,
    shortIdx !== undefined ? `${inv[0].scrollH}<=${inv[0].clientH} rows=${inv[0].rows}` : "없음");
  if (shortIdx !== undefined) {
    check("휠 전 배지 숨김", hidden((await at(shortIdx)).badgeOpacity));
    await wheelOver(shortIdx);
    const t = await at(shortIdx);
    check("휠 → 배지 표시", shown(t.badgeOpacity), `opacity=${t.badgeOpacity}`);
    check("문구 = '스크롤 이동은 표 바깥에서 해주세요.'",
      t.badgeText === "스크롤 이동은 표 바깥에서 해주세요.", t.badgeText);
    check("위치 = 표 상단 우측(헤더 행 밴드 안 · 표 안)",
      t.badgeTopGap >= 0 && t.badgeTopGap < 16 && t.badgeRightGap > 0 && t.badgeRightGap < 40 &&
        t.badgeWithinHeaderBand && t.badgeInsideTable,
      `topGap=${t.badgeTopGap}px rightGap=${t.badgeRightGap}px headerBand=${t.badgeWithinHeaderBand} inside=${t.badgeInsideTable}`);
    check("sticky thead(z-30)/corner(z-40) 위에 표시(z ≥ 50)", Number(t.badgeZ) >= 50, `z=${t.badgeZ}`);
    const style = await page.evaluate((i) => {
      const c = document.querySelectorAll('[data-slot="table-container"]')[i];
      const badge = Array.from(c.children).find((ch) => ch.textContent?.includes("표 바깥에서"));
      const cs = getComputedStyle(badge);
      return { pointerEvents: cs.pointerEvents, position: cs.position, bg: cs.backgroundColor, color: cs.color,
        radius: cs.borderRadius, fontSize: cs.fontSize, transition: cs.transitionDuration };
    }, shortIdx);
    console.log("   배지 스타일:", JSON.stringify(style));
    check("반투명 배경(불투명 경고색 아님)",
      /\/\s*0?\.\d+\s*\)/.test(style.bg) || /rgba\([^)]*,\s*0?\.\d+\s*\)/.test(style.bg), style.bg);
    check("muted 텍스트 · pill · 작은 글씨 · 클릭 차단",
      style.pointerEvents === "none" && style.position === "absolute" && parseFloat(style.radius) >= 100,
      `pe=${style.pointerEvents} pos=${style.position} r=${style.radius} fs=${style.fontSize}`);
    await page.screenshot({ path: resolve(adminRoot, "claudedocs", "qa-innerscroll-2-short-badge.png") });

    // 커서를 움직여도 배지가 따라오지 않는다(표 기준 고정).
    const dxBefore = t.badgeCenterDx;
    const pt = await page.evaluate((i) => {
      const r = document.querySelectorAll('[data-slot="table-container"]')[i]
        .querySelector(":scope > div.sticky-head-region").getBoundingClientRect();
      return { x: Math.round(r.left + 40), y: Math.round(r.top + 30) };
    }, shortIdx);
    await page.mouse.move(pt.x, pt.y);
    await page.waitForTimeout(250);
    check("커서를 따라다니지 않음(위치 불변)", (await at(shortIdx)).badgeCenterDx === dxBefore,
      `dx ${dxBefore}→${(await at(shortIdx)).badgeCenterDx}`);

    // 연속 휠 → 깜빡임 없이 연장. 먼저 새로 휠을 돌려 t0 를 확정한 뒤 타임라인을 100ms 간격으로 샘플링.
    await page.mouse.move(pt.x + 120, pt.y + 60);
    await page.waitForTimeout(300);
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(1200);
    const beforeRewheel = (await at(shortIdx)).badgeOpacity;
    await page.mouse.wheel(0, 200); // 연속(재)휠 — 여기서 꺼졌다 켜지면 깜빡임
    const samples = [];
    for (let i = 0; i < 16; i++) {
      await page.waitForTimeout(100);
      samples.push(Number((await at(shortIdx)).badgeOpacity));
    }
    console.log("   재휠 후 100ms 간격 opacity:", samples.map((v) => v.toFixed(2)).join(" "));
    check("재휠 직전 표시 유지", shown(beforeRewheel), `opacity=${beforeRewheel}`);
    check("재휠 후 1.5s 구간 내내 깜빡임 없음(중간에 꺼짐 없음)",
      samples.slice(0, 14).every((v) => v > 0.9), samples.slice(0, 14).map((v) => v.toFixed(2)).join(" "));
    check("첫 휠 기준 1.8s 를 넘겨도 유지 = 타이머 연장됨", samples[9] > 0.9, `t≈2.2s opacity=${samples[9]}`);
    await page.waitForTimeout(1200);
    check("마지막 휠 이후 ≈1.8s 경과 → 자동 소멸", hidden((await at(shortIdx)).badgeOpacity),
      `opacity=${(await at(shortIdx)).badgeOpacity}`);

    const toasts = await page.evaluate(() =>
      document.querySelectorAll('[data-sonner-toast],[data-radix-toast-root],ol[data-sonner-toaster] li').length);
    check("토스트 미사용", toasts === 0, `toastNodes=${toasts}`);
  }

  // ── (5) 페이지 중간(스크롤해야 보이는) 표 ───────────────────────────────────
  console.log("\n[5] 페이지 중간 표 — /admin/official-rest-periods?org=encre");
  await goto(`${BASE}/admin/official-rest-periods?org=encre`);
  inv = await inventory();
  console.log("  ", JSON.stringify(inv.map(({ index, rows, vScrollable, docTop }) => ({ index, rows, vScrollable, docTop }))));
  const midIdx = inv.find((t) => !t.vScrollable && t.visible)?.index;
  const midTop = midIdx !== undefined ? inv.find((t) => t.index === midIdx).docTop : null;
  check("첫 화면 아래(페이지 중간/하단)에 위치한 표", midIdx !== undefined && midTop > 900, `docTop=${midTop}px`);
  if (midIdx !== undefined) {
    await wheelOver(midIdx);
    const t = await at(midIdx);
    check("페이지 중간 표에서도 휠 → 배지 표시", shown(t.badgeOpacity), `opacity=${t.badgeOpacity}`);
    check("배지가 화면 전체가 아니라 그 표 상단 우측에 위치",
      t.badgeInsideTable && t.badgeWithinHeaderBand && t.badgeRightGap > 0 && t.badgeRightGap < 40,
      `inside=${t.badgeInsideTable} headerBand=${t.badgeWithinHeaderBand} rightGap=${t.badgeRightGap}`);
    await page.screenshot({ path: resolve(adminRoot, "claudedocs", "qa-innerscroll-5-midpage.png") });
  }

  // ── (6) 한 페이지 여러 표 ────────────────────────────────────────────────────
  console.log("\n[6] 여러 표 — /admin/week-recognitions?org=encre (탭 2개 · 세로 스크롤 표 2개)");
  await goto(`${BASE}/admin/week-recognitions?org=encre`);
  inv = await inventory();
  console.log("  ", JSON.stringify(inv.map(({ index, visible, rows, vScrollable }) => ({ index, visible, rows, vScrollable }))));
  check("한 페이지에 세로 스크롤 영역 표 2개 이상 마운트", inv.length >= 2, `count=${inv.length}`);
  const tabA = inv.find((t) => t.visible);
  if (tabA) {
    await wheelOver(tabA.index);
    let after = await inventory();
    const hitA = after.find((t) => t.index === tabA.index);
    check(`탭A 표(#${tabA.index}, ${hitA.vScrollable ? "스크롤 가능" : "스크롤 불가"}) 휠 결과 일치`,
      hitA.vScrollable ? hidden(hitA.badgeOpacity) : shown(hitA.badgeOpacity), `opacity=${hitA.badgeOpacity}`);
    check("같은 페이지의 다른 표 배지는 숨김 유지",
      after.filter((t) => t.index !== tabA.index).every((t) => hidden(t.badgeOpacity)),
      after.filter((t) => t.index !== tabA.index).map((t) => `#${t.index}:${t.badgeOpacity}`).join(" "));

    // 다른 탭으로 전환 → 그 표에서 독립적으로 판정되는지
    const otherTab = page.locator('button:has-text("주차 인정 기준")').first();
    if (await otherTab.count()) {
      await otherTab.click();
      await page.waitForTimeout(3500);
      inv = await inventory();
      console.log("   탭B:", JSON.stringify(inv.map(({ index, visible, rows, vScrollable }) => ({ index, visible, rows, vScrollable }))));
      const tabB = inv.find((t) => t.visible && t.index !== tabA.index) ?? inv.find((t) => t.visible);
      if (tabB) {
        await wheelOver(tabB.index);
        after = await inventory();
        const hitB = after.find((t) => t.index === tabB.index);
        check(`탭B 표(#${tabB.index}, ${hitB.vScrollable ? "스크롤 가능" : "스크롤 불가"}) 휠 결과 일치`,
          hitB.vScrollable ? hidden(hitB.badgeOpacity) : shown(hitB.badgeOpacity), `opacity=${hitB.badgeOpacity}`);
        check("탭A 표 배지는 여전히 숨김(표 간 간섭 없음)",
          after.filter((t) => t.index !== tabB.index).every((t) => hidden(t.badgeOpacity)),
          after.filter((t) => t.index !== tabB.index).map((t) => `#${t.index}:${t.badgeOpacity}`).join(" "));

        // 같은 페이지에서 "마지막 페이지"로 이동해 보이는 표를 짧게 만든 뒤 배타 표시 확인.
        const next = page.locator('button[aria-label="다음 페이지"]:visible').first();
        for (let i = 0; i < 60; i++) {
          if (!(await next.count()) || !(await next.isEnabled())) break;
          try { await next.click({ timeout: 4000 }); } catch { break; }
          await page.waitForTimeout(350);
        }
        await page.waitForTimeout(1500);
        inv = await inventory();
        const lastIdx = inv.find((t) => t.visible && !t.vScrollable)?.index;
        console.log("   마지막 페이지:", JSON.stringify(inv.map(({ index, visible, rows, vScrollable }) => ({ index, visible, rows, vScrollable }))));
        check("페이지 이동으로 보이는 표가 짧아짐(내부 스크롤 불가)", lastIdx !== undefined,
          lastIdx !== undefined ? `#${lastIdx} rows=${inv.find((t) => t.index === lastIdx).rows}` : "여전히 스크롤 가능");
        if (lastIdx !== undefined) {
          await wheelOver(lastIdx);
          after = await inventory();
          check("여러 표 중 휠을 돌린 그 표에서만 배지 표시",
            shown(after.find((t) => t.index === lastIdx).badgeOpacity) &&
              after.filter((t) => t.index !== lastIdx).every((t) => hidden(t.badgeOpacity)),
            after.map((t) => `#${t.index}:${t.badgeOpacity}`).join(" "));
          await page.screenshot({ path: resolve(adminRoot, "claudedocs", "qa-innerscroll-6-multi.png") });
        }
      }
    }
  }

  // ── (7) 사이드바 스크롤바 = 표 내부 스크롤바 동일 계약 ───────────────────────
  console.log("\n[7] 좌측 사이드바 스크롤바");
  await goto(`${BASE}/admin/members?org=encre`);
  const bars = await page.evaluate(() => {
    const nav = document.querySelector("nav.admin-thin-scroll");
    const region = document.querySelector("div.sticky-head-region");
    const main = document.querySelector("main[data-admin-scroll-container]");
    const box = (el) => (el ? { gutter: el.offsetWidth - el.clientWidth, scrollable: el.scrollHeight - el.clientHeight > 1 } : null);
    const rules = [];
    for (const sheet of document.styleSheets) {
      let list; try { list = sheet.cssRules; } catch { continue; }
      for (const r of list ?? []) {
        if (r.selectorText && /::-webkit-scrollbar/.test(r.selectorText)) {
          rules.push({ sel: r.selectorText.replace(/\s+/g, " "), css: r.style.cssText });
        }
      }
    }
    // 클래스별 · 스크롤바 부위별 선언을 병합(빌드가 셀렉터 목록을 분해해도 비교 가능).
    const CLASSES = [".admin-thin-scroll", ".admin-table-scroll", ".sticky-head-region"];
    const merged = {};
    for (const cls of CLASSES) {
      merged[cls] = {};
      for (const r of rules) {
        for (const one of r.sel.split(",").map((s) => s.trim())) {
          if (!one.startsWith(cls + ":")) continue;
          const part = one.slice(cls.length);
          merged[cls][part] = ((merged[cls][part] ?? "") + " " + r.css).trim();
        }
      }
      for (const k of Object.keys(merged[cls])) {
        merged[cls][k] = merged[cls][k].split(";").map((s) => s.trim()).filter(Boolean).sort().join("; ");
      }
    }
    return { navHasClass: Boolean(nav), nav: box(nav), region: box(region), main: box(main),
      bodyScrollbar: window.innerWidth - document.documentElement.clientWidth, rules, merged };
  });
  console.log("   nav:", JSON.stringify(bars.nav), "table:", JSON.stringify(bars.region),
    "page(main):", JSON.stringify(bars.main), "body:", bars.bodyScrollbar);
  const thin = bars.merged[".admin-thin-scroll"], head = bars.merged[".sticky-head-region"];
  Object.keys(thin).sort().forEach((k) => console.log(`   ${k}\n     사이드바: ${thin[k]}\n     표내부  : ${head[k]}`));
  const same = (part) => thin[part] && thin[part] === head[part];
  check("사이드바 nav 에 공통 클래스 .admin-thin-scroll 적용", bars.navHasClass);
  check("사이드바 실제 세로 스크롤 발생", bars.nav?.scrollable === true);
  check("사이드바 스크롤바 실측 폭 6px", bars.nav?.gutter === 6, `gutter=${bars.nav?.gutter}px`);
  check("표 내부 세로 스크롤바 실측 폭 6px(동일 두께)", bars.region?.gutter === 6, `gutter=${bars.region?.gutter}px`);
  check("페이지 스크롤 컨테이너(main)는 미변경(기본 폭)", bars.main?.gutter !== 6,
    `main gutter=${bars.main?.gutter}px scrollable=${bars.main?.scrollable}`);
  check("body/html/전역 셀렉터에는 스크롤바 규칙 없음(페이지 스크롤바 미변경)",
    !bars.rules.some((r) => /(^|[\s,])(body|html|\*)(::|:|\s|,|$)/.test(r.sel)),
    bars.rules.filter((r) => /(^|[\s,])(body|html|\*)/.test(r.sel)).map((r) => r.sel).join(" | ") || "없음");
  check("두께 선언 동일(::-webkit-scrollbar)", same("::-webkit-scrollbar") && /width: 6px/.test(thin["::-webkit-scrollbar"] ?? ""),
    thin["::-webkit-scrollbar"]);
  check("thumb(radius+muted 색) 선언 동일", same("::-webkit-scrollbar-thumb") && /999px/.test(thin["::-webkit-scrollbar-thumb"] ?? ""),
    thin["::-webkit-scrollbar-thumb"]);
  check("hover 선언 동일", same(":hover::-webkit-scrollbar-thumb"), thin[":hover::-webkit-scrollbar-thumb"]);
  check("active 선언 동일", same(":active::-webkit-scrollbar-thumb"), thin[":active::-webkit-scrollbar-thumb"]);
  check("트랙 투명 선언 동일", same("::-webkit-scrollbar-track"), thin["::-webkit-scrollbar-track"]);
  check("화살표 버튼 숨김 선언 동일", same("::-webkit-scrollbar-button"), thin["::-webkit-scrollbar-button"]);
  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "qa-innerscroll-7-sidebar.png"), clip: { x: 0, y: 0, width: 340, height: 900 } });

  console.log(`\n=== RESULT: ${pass} pass / ${fail} fail ===`);
} catch (e) {
  console.error("ERROR:", e);
  fail++;
} finally {
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
}

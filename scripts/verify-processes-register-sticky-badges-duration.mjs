/**
 * /admin/processes/register — 요약 셀 내부 간격(고정 라벨 열 + 콘텐츠 값 열) / 앞 두 열 고정 /
 * 값 배지 색 안정성(허브 급·체크 대상·카페) / "소요 시간(m)" 한 줄 표시 검증 (READ-ONLY).
 *   npx tsx --env-file=.env.local scripts/verify-processes-register-sticky-badges-duration.mjs
 */
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const email = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const E = (n) => { const v = process.env[n]; if (!v) throw new Error("miss " + n); return v; };
async function cookies() {
  const su = E("NEXT_PUBLIC_SUPABASE_URL"), ak = E("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const admin = createClient(su, E("SUPABASE_SERVICE_ROLE_KEY")), anon = createClient(su, ak);
  const { data: l } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await anon.auth.verifyOtp({ email, token: l.properties.email_otp, type: "magiclink" });
  const cap = [];
  const s = createServerClient(su, ak, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await s.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" }));
}

const R = {};
let fails = 0;
const fail = (m) => { fails++; console.log("  FAIL:", m); };

// 표의 컬럼 인덱스(PROC_COLUMNS 순서)
const COL = { hub: 0, actName: 1, lineGroup: 2, duration: 3, checkTarget: 9, cafe: 10 };
// 배지 적용 컬럼 / 미적용 컬럼
const BADGE_COLS = { hub: COL.hub, checkTarget: COL.checkTarget, cafe: COL.cafe };

async function main() {
  const ck = await cookies();
  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await ctx.addCookies(ck);
    const page = await ctx.newPage();
    await page.goto(`${baseUrl}/admin/processes/register`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=전체 액트 수");
    await page.waitForSelector("table tbody tr");
    await page.waitForTimeout(600);

    // ── 1) 요약: 바깥은 전체 폭 유지 · 셀 내부는 [고정 라벨 열 | 콘텐츠 값 열] ──
    const LEFT = ["전체 액트 수", "전체 라인급 수", "총합 소요 시간"];
    const RIGHT = ["필수 포인트 총합", "우수 포인트 총합", "최대 포인트 총합"];
    R.summary = await page.evaluate(({ LEFT, RIGHT }) => {
      const cellOf = (t) => [...document.querySelectorAll("*")].find(
        (e) => e.children.length === 2 && String(e.className).includes("rounded-md")
          && String(e.className).includes("bg-background/50") && e.textContent.trim().startsWith(t));
      const first = cellOf(LEFT[0]);
      const box = first?.parentElement?.parentElement;
      const parent = box?.parentElement;
      const bw = box ? box.getBoundingClientRect().width : 0;
      const pw = parent ? parent.getBoundingClientRect().width : 0;
      const geom = (t) => {
        const cell = cellOf(t);
        if (!cell) return null;
        const cr = cell.getBoundingClientRect();
        const [labelEl, valueEl] = cell.children;
        const lr = labelEl.getBoundingClientRect(), vr = valueEl.getBoundingClientRect();
        // 라벨 span 은 트랙에 stretch 되므로 bounding rect 가 아니라 **실제 콘텐츠 끝**을 봐야
        // 트랙 초과(라벨이 gap 을 잡아먹고 값과 붙는 상태)를 잡아낸다.
        const range = document.createRange();
        range.selectNodeContents(labelEl);
        const contentW = range.getBoundingClientRect().width;
        return {
          label: t,
          cellW: Math.round(cr.width),
          labelTrackW: Math.round(lr.width),
          labelContentW: Math.round(contentW),
          valueStart: Math.round(vr.left - cr.left),                    // 박스 기준 값 시작 x
          gapAfterLabel: Math.round(vr.left - (lr.left + contentW)),    // 라벨 콘텐츠 끝 ↔ 값 시작
          slackAfterValue: Math.round(cr.right - vr.right),             // 값 끝 ↔ 박스 오른쪽 여백
          overflowsTrack: contentW > lr.width + 0.5,
        };
      };
      const trips = [...document.querySelectorAll("*")]
        .filter((e) => String(e.className).includes("grid-cols-[repeat(3,minmax(2.75rem,max-content))]"));
      const tripLefts = trips.map((t) => [...t.children].map((c) => Math.round(c.getBoundingClientRect().left)));
      return {
        boxW: Math.round(bw), parentW: Math.round(pw), fillPct: pw ? Math.round((bw / pw) * 100) : 0,
        colWidths: box ? [...box.children].map((c) => Math.round(c.getBoundingClientRect().width)) : [],
        left: LEFT.map(geom), right: RIGHT.map(geom),
        tripCount: trips.length, tripLefts,
      };
    }, { LEFT, RIGHT });
    // 바깥 컨테이너 = 전체 폭 유지, 두 열 균등
    if (R.summary.fillPct < 99) fail(`summary box no longer full-width (${R.summary.fillPct}%)`);
    if (Math.abs(R.summary.colWidths[0] - R.summary.colWidths[1]) > 2) fail(`columns not equal: ${R.summary.colWidths}`);
    // 셀 내부: 같은 그룹 3행의 값 시작 위치 동일 · 라벨과 값이 박스 양끝까지 벌어지지 않음
    for (const [name, rows] of [["left", R.summary.left], ["right", R.summary.right]]) {
      if (rows.some((r) => !r)) { fail(`${name}: summary cell not found`); continue; }
      const starts = [...new Set(rows.map((r) => r.valueStart))];
      if (starts.length !== 1) fail(`${name}: value start x differs across rows ${JSON.stringify(rows.map((r) => r.valueStart))}`);
      for (const r of rows) {
        if (r.overflowsTrack) fail(`${name} "${r.label}": label content ${r.labelContentW}px overflows track ${r.labelTrackW}px`);
        if (r.gapAfterLabel < 8) fail(`${name} "${r.label}": label almost touches value (gap ${r.gapAfterLabel}px)`);
        if (r.gapAfterLabel > 64) fail(`${name} "${r.label}": gap after label ${r.gapAfterLabel}px too wide`);
        // 값이 박스 오른쪽 끝까지 밀려나 있으면(=여백 거의 0) justify-between 잔재.
        if (r.slackAfterValue < 24) fail(`${name} "${r.label}": value pushed to box right edge (slack ${r.slackAfterValue}px)`);
      }
    }
    if (R.summary.tripCount !== 3) fail(`point triplets ${R.summary.tripCount} != 3`);
    {
      const [a, b, c] = R.summary.tripLefts;
      const same = a && b && c && a.every((x, i) => x === b[i] && x === c[i]);
      R.summary.abcAligned = !!same;
      if (!same) fail(`A/B/C columns not aligned across point rows: ${JSON.stringify(R.summary.tripLefts)}`);
    }

    // ── 2) 앞 두 열 고정 ────────────────────────────────────────────────────
    const scroller = page.locator(".admin-table-scroll").last();
    await scroller.evaluate((el) => { el.scrollLeft = 0; });
    await page.waitForTimeout(150);
    const before = await page.evaluate((COL) => {
      const th = [...document.querySelectorAll("thead th")];
      const td = [...document.querySelectorAll("tbody tr")][0].children;
      const r = (el) => { const b = el.getBoundingClientRect(); return { left: Math.round(b.left), w: Math.round(b.width) }; };
      return {
        headHub: r(th[COL.hub]), headAct: r(th[COL.actName]), headLine: r(th[COL.lineGroup]),
        bodyHub: r(td[COL.hub]), bodyAct: r(td[COL.actName]),
      };
    }, COL);
    // 가로로 충분히 스크롤
    await scroller.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await page.waitForTimeout(300);
    R.sticky = await page.evaluate((COL) => {
      const th = [...document.querySelectorAll("thead th")];
      const tds = [...document.querySelectorAll("tbody tr")][0].children;
      const info = (el) => {
        const cs = getComputedStyle(el);
        const b = el.getBoundingClientRect();
        return {
          position: cs.position, left: cs.left, zIndex: cs.zIndex,
          width: Math.round(b.width), x: Math.round(b.left),
          bg: cs.backgroundColor,
          borderRight: cs.borderRightWidth,
          boxShadow: cs.boxShadow !== "none",
        };
      };
      const host = document.querySelector(".admin-table-scroll");
      return {
        scrollLeft: Math.round(host.scrollLeft),
        cssVarCol1W: getComputedStyle(host).getPropertyValue("--sticky-col-1-w").trim(),
        headHub: info(th[COL.hub]), headAct: info(th[COL.actName]), headLine: info(th[COL.lineGroup]),
        bodyHub: info(tds[COL.hub]), bodyAct: info(tds[COL.actName]),
        hostLeft: Math.round(host.getBoundingClientRect().left),
      };
    }, COL);
    R.stickyBefore = before;
    const s = R.sticky;
    if (s.scrollLeft < 50) fail(`table did not scroll horizontally (scrollLeft=${s.scrollLeft})`);
    for (const [k, v] of Object.entries({ headHub: s.headHub, headAct: s.headAct, bodyHub: s.bodyHub, bodyAct: s.bodyAct })) {
      if (v.position !== "sticky") fail(`${k}: position ${v.position} != sticky`);
    }
    if (s.headHub.left !== "0px") fail(`headHub left ${s.headHub.left} != 0px`);
    if (s.bodyHub.left !== "0px") fail(`bodyHub left ${s.bodyHub.left} != 0px`);
    // left 는 서브픽셀 반올림 차이가 있으므로 수치 비교(±0.5px).
    const px = (v) => parseFloat(v);
    if (Math.abs(px(s.headAct.left) - px(s.cssVarCol1W)) > 0.5) fail(`headAct left ${s.headAct.left} != --sticky-col-1-w ${s.cssVarCol1W}`);
    if (Math.abs(px(s.bodyAct.left) - px(s.cssVarCol1W)) > 0.5) fail(`bodyAct left ${s.bodyAct.left} != --sticky-col-1-w ${s.cssVarCol1W}`);
    // 헤더/본문 좌우 위치 일치
    if (Math.abs(s.headHub.x - s.bodyHub.x) > 1) fail(`hub head/body x mismatch ${s.headHub.x} vs ${s.bodyHub.x}`);
    if (Math.abs(s.headAct.x - s.bodyAct.x) > 1) fail(`actName head/body x mismatch ${s.headAct.x} vs ${s.bodyAct.x}`);
    if (Math.abs(s.headHub.width - s.bodyHub.width) > 1) fail("hub head/body width mismatch");
    if (Math.abs(s.headAct.width - s.bodyAct.width) > 1) fail("actName head/body width mismatch");
    // 고정 밴드가 컨테이너 왼쪽에 붙어 있는지 + 3번째 열이 그 뒤로 지나갔는지
    if (Math.abs(s.bodyHub.x - s.hostLeft) > 2) fail(`hub not pinned to container left (${s.bodyHub.x} vs ${s.hostLeft})`);
    if (s.headLine.x >= s.headAct.x + s.headAct.width - 1) fail("3rd column (소속 라인 급) did not scroll under the sticky band");
    // 헤더 z-index > 본문 sticky z-index
    if (Number(s.headHub.zIndex) <= Number(s.bodyHub.zIndex)) fail(`header z-index ${s.headHub.zIndex} <= body ${s.bodyHub.zIndex}`);
    // 불투명 배경 (alpha 없음)
    for (const [k, v] of Object.entries({ headHub: s.headHub, headAct: s.headAct, bodyHub: s.bodyHub, bodyAct: s.bodyAct })) {
      if (/rgba\([^)]*,\s*0(\.\d+)?\)/.test(v.bg)) fail(`${k}: transparent sticky bg ${v.bg}`);
    }
    // 두 번째 열 오른쪽 경계 구분(경계선 또는 그림자)
    if (parseFloat(s.bodyAct.borderRight) <= 0 && !s.bodyAct.boxShadow) fail("no boundary (border/shadow) on 2nd sticky column");
    // hover 상태에서 고정 셀 배경이 행과 일치
    R.hover = await page.evaluate((COL) => {
      const tr = document.querySelectorAll("tbody tr")[0];
      tr.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      const other = tr.children[COL.duration];
      const hub = tr.children[COL.hub];
      return { rowCell: getComputedStyle(other).backgroundColor, stickyCell: getComputedStyle(hub).backgroundColor };
    }, COL);
    await page.screenshot({ path: "claudedocs/qa-proc-sticky-2col.png", clip: { x: 0, y: 0, width: 1440, height: 900 } });

    // ── 3) 값 배지 — 같은 값 = 같은 색 (정렬 전/후) ─────────────────────────
    const readBadges = () => page.evaluate((BADGE_COLS) => {
      const out = {};
      for (const key of Object.keys(BADGE_COLS)) out[key] = {};
      for (const tr of document.querySelectorAll("tbody tr")) {
        for (const [key, idx] of Object.entries(BADGE_COLS)) {
          const badge = tr.children[idx]?.querySelector('[data-slot="badge"]');
          if (!badge) continue;
          const t = badge.textContent.trim();
          const cs = getComputedStyle(badge);
          (out[key][t] = out[key][t] ?? []).push(`${cs.backgroundColor}|${cs.color}|${cs.borderColor}`);
        }
      }
      return out;
    }, BADGE_COLS);
    const pass1 = await readBadges();
    // 소속 라인 급 순 정렬 → 행 순서가 바뀌어도 색이 값을 따라가는지
    await page.locator('button[aria-label="소속 라인 급 정렬"]').click();
    await page.waitForTimeout(300);
    const pass2 = await readBadges();
    R.badges = {};
    for (const cat of Object.keys(BADGE_COLS)) {
      const values = new Set([...Object.keys(pass1[cat]), ...Object.keys(pass2[cat])]);
      const map = {};
      for (const v of values) {
        const all = [...(pass1[cat][v] ?? []), ...(pass2[cat][v] ?? [])];
        const uniq = [...new Set(all)];
        map[v] = { rows: all.length, distinctStyles: uniq.length, style: uniq[0] };
        if (uniq.length !== 1) fail(`${cat} "${v}": ${uniq.length} distinct badge styles (must be 1)`);
      }
      // 서로 다른 값이 같은 색을 쓰는지(참고용 — 팔레트가 좁으면 충돌 가능, 실패로 보진 않음)
      R.badges[cat] = map;
      if (values.size === 0) fail(`${cat}: no badges rendered`);
    }
    // 배지 줄바꿈 없음
    R.badgeNowrap = await page.evaluate(() =>
      [...document.querySelectorAll('tbody [data-slot="badge"]')].every((b) => getComputedStyle(b).whiteSpace === "nowrap"));
    if (!R.badgeNowrap) fail("badge whiteSpace != nowrap");
    // 라이트/다크 모두에서 배지 글자 대비(WCAG AA 4.5:1) 확보 — 테마 토글 후 재측정.
    const contrastScan = () => page.evaluate((BADGE_COLS) => {
      const lum = (c) => {
        const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      // computed color 가 lab()/oklch() 로 나오므로 문자열 파싱 대신 캔버스에 실제로 칠해 읽는다.
      const cv = document.createElement("canvas");
      cv.width = cv.height = 1;
      const px = cv.getContext("2d", { willReadFrequently: true });
      const parse = (s) => {
        px.clearRect(0, 0, 1, 1);
        px.fillStyle = "#ffffff";
        px.fillRect(0, 0, 1, 1); // 알파가 있어도 흰 배경 위 합성색으로 평가
        px.fillStyle = s;
        px.fillRect(0, 0, 1, 1);
        const d = px.getImageData(0, 0, 1, 1).data;
        return [d[0], d[1], d[2]];
      };
      const worst = {};
      for (const tr of document.querySelectorAll("tbody tr")) {
        for (const [key, idx] of Object.entries(BADGE_COLS)) {
          const b = tr.children[idx]?.querySelector('[data-slot="badge"]');
          if (!b) continue;
          const cs = getComputedStyle(b);
          const L1 = lum(parse(cs.color)), L2 = lum(parse(cs.backgroundColor));
          const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
          const t = b.textContent.trim();
          if (!worst[key] || ratio < worst[key].ratio) worst[key] = { value: t, ratio: Math.round(ratio * 100) / 100 };
        }
      }
      return worst;
    }, BADGE_COLS);
    R.contrastLight = await contrastScan();
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.waitForTimeout(300);
    R.contrastDark = await contrastScan();
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.waitForTimeout(200);
    for (const [theme, m] of [["light", R.contrastLight], ["dark", R.contrastDark]]) {
      for (const [cat, v] of Object.entries(m)) {
        if (!Number.isFinite(v.ratio)) fail(`${theme}/${cat} "${v.value}": contrast not measurable (${v.ratio})`);
        else if (v.ratio < 4.5) fail(`${theme}/${cat} "${v.value}": contrast ${v.ratio} < 4.5`);
      }
    }

    // 소속 라인 급 = 배지 미적용(일반 텍스트) 확인
    R.lineGroupPlain = await page.evaluate((idx) =>
      [...document.querySelectorAll("tbody tr")].every((tr) => !tr.children[idx]?.querySelector('[data-slot="badge"]')), COL.lineGroup);
    if (!R.lineGroupPlain) fail("소속 라인 급 must stay plain text (badge found)");

    // ── 4) "소요 시간(m)" 한 줄 ──────────────────────────────────────────────
    R.duration = await page.evaluate(() => {
      const th = [...document.querySelectorAll("thead th")].find((e) => e.textContent.includes("소요 시간(m)"));
      if (!th) return null;
      const label = [...th.querySelectorAll("span")].find((s) => s.textContent.trim() === "소요 시간(m)");
      const lr = label.getBoundingClientRect();
      const lineH = parseFloat(getComputedStyle(label).lineHeight) || 20;
      const btn = th.querySelector("button[aria-label]");
      const headHeights = [...document.querySelectorAll("thead th")].map((e) => Math.round(e.getBoundingClientRect().height));
      return {
        headerText: th.textContent.trim(), ariaLabel: btn?.getAttribute("aria-label"),
        labelH: Math.round(lr.height), lineH: Math.round(lineH), oneLine: lr.height < lineH * 1.6,
        whiteSpace: getComputedStyle(th).whiteSpace,
        thWidth: Math.round(th.getBoundingClientRect().width),
        maxHeadH: Math.max(...headHeights), thH: Math.round(th.getBoundingClientRect().height),
      };
    });
    if (!R.duration) fail('header "소요 시간(m)" not found');
    else {
      if (!R.duration.oneLine) fail(`"소요 시간(m)" wrapped (h=${R.duration.labelH}, line=${R.duration.lineH})`);
      if (R.duration.ariaLabel !== "소요 시간(m) 정렬") fail(`aria-label = "${R.duration.ariaLabel}"`);
      if (R.duration.thH > R.duration.maxHeadH) fail("duration header taller than other headers");
    }
    // 좁은 폭에서도 한 줄 유지
    for (const w of [1280, 1024]) {
      await page.setViewportSize({ width: w, height: 1000 });
      await page.waitForTimeout(250);
      const one = await page.evaluate(() => {
        const th = [...document.querySelectorAll("thead th")].find((e) => e.textContent.includes("소요 시간(m)"));
        const label = [...th.querySelectorAll("span")].find((s) => s.textContent.trim() === "소요 시간(m)");
        const lh = parseFloat(getComputedStyle(label).lineHeight) || 20;
        return label.getBoundingClientRect().height < lh * 1.6;
      });
      R[`duration@${w}`] = one;
      if (!one) fail(`${w}: "소요 시간(m)" wrapped`);
    }

    await ctx.close();
  } finally {
    await browser.close();
  }
  console.log("\n" + JSON.stringify(R, null, 2));
  console.log(`\n${fails === 0 ? "PASS" : "FAIL"}: ${fails} failures`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });

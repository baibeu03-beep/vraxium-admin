// 브라우저 검증 — /admin/line-opening 공통 UI 수정(팀 탭 "팀" 접미/active 강조/aria, 권장 다음 단계
//   help key 잘림, 개설 주차 드롭다운 폭, 주차 라벨 "26년, 여름 시즌, N주차 · 개설 대상" 통일).
//   experience 허브(?tab=open)의 파트장 입력 카드에서 검증. operating + mode=test, 3개 조직 전수.
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
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL"),
  ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE),
  brow = createClient(URL_, ANON);
const EMAIL = "vanuatu.golden@gmail.com";
const ORGS = ["encre", "oranke", "phalanx"];

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

const WEEK_RE = /\d{2}년,\s.+?\s시즌,\s\d+주차/; // "26년, 여름 시즌, 3주차"

async function verify(org, mode) {
  const tag = `${org}${mode ? "/test" : "/operating"}`;
  const url = `${BASE}/admin/line-opening/practical-experience?org=${org}&tab=open${mode ? "&mode=test" : ""}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  // 팀 탭(파트장 입력 카드) 로드 대기 — 최대 12s. 없으면 데이터(시드) 부재로 판단.
  await page
    .waitForFunction(() => document.querySelectorAll('[role="tablist"] button[role="tab"]').length > 0, { timeout: 12000 })
    .catch(() => {});
  await page.waitForTimeout(1200);

  // ── 팀 탭: 텍스트가 "팀"으로 끝남 + "팀 팀" 중복 없음 + role=tab + aria-selected 존재 ──
  const tabInfo = await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('[role="tablist"] button[role="tab"]'));
    return tabs.map((b) => ({
      text: (b.textContent || "").replace(/🔒/g, "").trim(),
      selected: b.getAttribute("aria-selected"),
      disabled: b.getAttribute("aria-disabled"),
    }));
  });
  ck(`[${tag}] 팀 탭 존재(role=tab)`, tabInfo.length >= 1, `n=${tabInfo.length}`);
  const allEndWithTeam = tabInfo.length > 0 && tabInfo.every((t) => /팀$/.test(t.text));
  ck(`[${tag}] 모든 팀 탭이 "팀"으로 끝남`, allEndWithTeam, tabInfo.map((t) => t.text).join(" | "));
  const noDupe = tabInfo.every((t) => !/팀\s*팀$/.test(t.text));
  ck(`[${tag}] "팀 팀" 중복 없음`, noDupe);
  const oneSelected = tabInfo.filter((t) => t.selected === "true").length === 1;
  ck(`[${tag}] 정확히 1개 탭 aria-selected=true`, oneSelected,
    `sel=[${tabInfo.filter((t)=>t.selected==="true").map((t)=>t.text).join(",")}]`);
  const nonSelFalse = tabInfo.filter((t) => t.selected !== "true").every((t) => t.selected === "false");
  ck(`[${tag}] 비선택 탭 aria-selected=false`, nonSelFalse);

  // 선택 탭 시각 강조: 배경/글자색이 비선택과 다름(computed style 비교).
  const styleDiff = await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('[role="tablist"] button[role="tab"]'));
    const sel = tabs.find((b) => b.getAttribute("aria-selected") === "true");
    const non = tabs.find((b) => b.getAttribute("aria-selected") === "false" && b.getAttribute("aria-disabled") !== "true");
    if (!sel) return { ok: false, reason: "no selected" };
    const cs = (el) => { const s = getComputedStyle(el); return { bg: s.backgroundColor, color: s.color, weight: s.fontWeight }; };
    const s = cs(sel), n = non ? cs(non) : null;
    return { ok: !n || (s.bg !== n.bg && (s.color !== n.color || s.weight !== n.weight)), s, n };
  });
  ck(`[${tag}] 선택 탭이 비선택과 시각적으로 구분(bg+색/굵기)`, styleDiff.ok,
    `sel=${JSON.stringify(styleDiff.s)} non=${JSON.stringify(styleDiff.n)}`);

  // ── 개설 주차 드롭다운: 라벨 포맷 통일 + "개설 대상"(띄어쓰기) + 잘림 없음(scrollWidth<=clientWidth) ──
  const weekSel = await page.evaluate((reSrc) => {
    const re = new RegExp(reSrc);
    const sels = Array.from(document.querySelectorAll("select"));
    // 개설 주차 셀렉트 = 옵션 텍스트가 주차 포맷과 매칭되는 첫 셀렉트.
    for (const s of sels) {
      const opts = Array.from(s.options).map((o) => o.textContent.trim());
      if (opts.some((o) => re.test(o))) {
        return {
          found: true,
          opts,
          selectedText: s.options[s.selectedIndex]?.textContent.trim() ?? "",
          clientW: s.clientWidth,
          scrollW: s.scrollWidth,
        };
      }
    }
    return { found: false };
  }, WEEK_RE.source);
  ck(`[${tag}] 개설 주차 드롭다운 발견`, weekSel.found);
  if (weekSel.found) {
    const allFmt = weekSel.opts.every((o) => WEEK_RE.test(o));
    ck(`[${tag}] 모든 주차 옵션이 "NN년, 시즌, N주차" 포맷`, allFmt,
      `ex="${weekSel.opts[0]}"`);
    const noOldFmt = weekSel.opts.every((o) => !/\sW\d/.test(o) && !/개설대상/.test(o));
    ck(`[${tag}] 구포맷(W#/개설대상 붙임) 없음`, noOldFmt);
    const hasTargetSpace = !weekSel.opts.some((o) => /개설/.test(o)) ||
      weekSel.opts.some((o) => /· 개설 대상/.test(o));
    ck(`[${tag}] "개설 대상" 띄어쓰기 적용`, hasTargetSpace,
      weekSel.opts.find((o)=>/개설/.test(o)) ?? "(개설 옵션 없음)");
    ck(`[${tag}] 선택 문구 잘림 없음(scrollW<=clientW+2)`, weekSel.scrollW <= weekSel.clientW + 2,
      `client=${weekSel.clientW} scroll=${weekSel.scrollW} · "${weekSel.selectedText}"`);
  }

  // ── 파트 드롭다운에서 "팀 총괄" 선택(React onChange 정상 트리거) → 액션 컬럼 노출 → help key 잘림 검사 ──
  // 파트 <select> = 옵션에 "팀 총괄"을 가진 셀렉트. Playwright selectOption 으로 실제 이벤트 발생.
  const partSelector = await page.evaluate(() => {
    const sels = Array.from(document.querySelectorAll("select"));
    for (let i = 0; i < sels.length; i++) {
      if (Array.from(sels[i].options).some((o) => o.textContent.trim() === "팀 총괄")) return i;
    }
    return -1;
  });
  if (partSelector >= 0) {
    const sel = page.locator("select").nth(partSelector);
    await sel.selectOption({ label: "팀 총괄" }).catch(() => {});
    // 액션 컬럼(초기화 버튼) 렌더 대기.
    await page
      .waitForFunction(() => Array.from(document.querySelectorAll("button")).some((b) => /^초기화$/.test((b.textContent || "").trim())), { timeout: 12000 })
      .catch(() => {});
    await page.waitForTimeout(800);
    const clip = await page.evaluate(() => {
      // 액션 컬럼 = "초기화" 버튼(항상 존재)의 세로 버튼 그룹 컨테이너(flex-col).
      const resetBtn = Array.from(document.querySelectorAll("button")).find((b) => /^초기화$/.test((b.textContent || "").trim()));
      if (!resetBtn) return { ok: false, reason: "no-action-column" };
      let col = resetBtn.closest("div");
      while (col && !/flex-col/.test(col.className)) col = col.parentElement;
      col = col || resetBtn.closest("div");
      const colRect = col.getBoundingClientRect();
      const btns = Array.from(col.querySelectorAll("button"));
      const overflow = btns
        .map((b) => ({ r: b.getBoundingClientRect(), t: (b.textContent || "").trim().slice(0, 6) || "icon" }))
        .filter((x) => x.r.width > 0 && (x.r.right > colRect.right + 1 || x.r.left < colRect.left - 1));
      return {
        ok: overflow.length === 0,
        colWidth: Math.round(colRect.width),
        overflow: overflow.map((o) => `${o.t}@${Math.round(o.r.right)}>${Math.round(colRect.right)}`),
        btnCount: btns.length,
      };
    });
    ck(`[${tag}] 팀 총괄 액션/help key 컬럼 내 완전 표시(잘림 없음)`, clip.ok,
      clip.ok ? `col w=${clip.colWidth} btns=${clip.btnCount}` : `overflow=[${(clip.overflow || []).join(", ")}] reason=${clip.reason || ""}`);

    await page.screenshot({ path: resolve(adminRoot, "claudedocs", `lineopening-ui-${org}${mode ? "-test" : ""}.png`), fullPage: false });
  } else {
    ck(`[${tag}] 파트 드롭다운 "팀 총괄" 옵션 존재`, false, "옵션 없음(팀 미로드)");
  }
}

try {
  for (const org of ORGS) await verify(org, false);
  await verify("encre", true); // mode=test 대표 1건
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
  try { await page.screenshot({ path: resolve(adminRoot, "claudedocs", "lineopening-ui-error.png"), fullPage: true }); } catch {}
} finally {
  await browser.close();
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

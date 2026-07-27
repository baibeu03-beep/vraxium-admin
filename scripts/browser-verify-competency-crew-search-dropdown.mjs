// 검증 — /admin/integrated/line-opening/practical-competency [해당 크루] 크루 검색 드롭다운 레이어링.
//   증상: 검색 결과가 아래 표(승인 명단) 뒤로 가려지고, 표가 없을 땐 카드 경계에서 잘렸다.
//   원인 ① Card(components/ui/card.tsx) base 클래스의 overflow-hidden → 카드 안 absolute 메뉴가 잘림.
//        ② 조상에 stacking context 가 하나도 없어 메뉴(z-20)와 표 sticky 셀(thead 30 / corner 40)이
//           같은 root stacking context 에서 겨룸 → 표가 위에 그려짐.
//   수정: AnchoredPortalMenu(components/ui/anchored-portal-menu.tsx) 로 body portal + fixed 좌표.
//
//   읽기 전용 — 크루 "선택"까지만 하고 [추가](변이)는 실행하지 않는다.
//   실행: node scripts/browser-verify-competency-crew-search-dropdown.mjs
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
// encre = 승인 명단(표)이 있는 조직 → 표와의 겹침 검증 / oranke = 명단 0건(카드가 짧음) → 클리핑 검증.
const ORGS = (process.env.VERIFY_ORGS ?? "encre,oranke").split(",");
const Q = process.env.VERIFY_Q ?? "T";

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

const cookies = await makeAdminCookies();
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies(cookies);

for (const org of ORGS) {
  console.log(`\n== ${org} ==`);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin/integrated/line-opening/practical-competency?org=${org}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(6000);
  // 기본 탭은 [라인 관리] — [라인 개설] 로 전환해야 [해당 크루] 섹션이 렌더된다.
  await page.getByText("라인 개설", { exact: true }).first().click();
  await page.waitForTimeout(6000);

  const input = page.getByLabel("수동 추가 크루 검색");
  await input.waitFor({ timeout: 20000 });
  await input.click();
  await input.pressSequentially(Q, { delay: 120 });
  await page.waitForTimeout(4000);

  const r = await page.evaluate(() => {
    const menu = document.querySelector('[data-slot="anchored-portal-menu"]');
    if (!menu) return { error: "menu not rendered" };
    const input = document.querySelector('input[aria-label="수동 추가 크루 검색"]');
    const anchor = input.closest("div.relative");
    const s = getComputedStyle(menu);
    const m = menu.getBoundingClientRect();
    const a = anchor.getBoundingClientRect();
    const desc = (el) => {
      const cls = typeof el.className === "string" && el.className
        ? "." + el.className.trim().split(/\s+/).slice(0, 4).join(".") : "";
      return `${el.tagName.toLowerCase()}${cls}`;
    };
    // 메뉴 세로 전 구간에서 실제로 위에 그려지는지(가려지면 다른 요소가 잡힌다).
    const probes = [];
    for (let i = 0; i < 9; i++) {
      const y = m.top + 4 + ((m.height - 8) * i) / 8;
      const hit = document.elementFromPoint(m.left + m.width / 2, y);
      probes.push({ y: Math.round(y), inside: hit ? menu.contains(hit) : false, hit: hit ? desc(hit) : null });
    }
    const th = document.querySelector('[data-slot="table-container"] thead th');
    const thR = th?.getBoundingClientRect() ?? null;
    let overlapHit = null;
    if (thR && thR.top < m.bottom && thR.bottom > m.top && thR.left < m.right && thR.right > m.left) {
      const x = (Math.max(m.left, thR.left) + Math.min(m.right, thR.right)) / 2;
      const y = (Math.max(m.top, thR.top) + Math.min(m.bottom, thR.bottom)) / 2;
      const hit = document.elementFromPoint(x, y);
      overlapHit = { inside: hit ? menu.contains(hit) : false, hit: hit ? desc(hit) : null };
    }
    return {
      portaled: menu.parentElement === document.body,
      position: s.position,
      zIndex: s.zIndex,
      // 앵커(검색 입력 wrapper) 바로 아래 4px, 같은 좌표/너비인가.
      alignedTop: Math.abs(m.top - (a.bottom + 4)) <= 1,
      alignedLeft: Math.abs(m.left - a.left) <= 1,
      alignedWidth: Math.abs(m.width - a.width) <= 1,
      itemCount: menu.querySelectorAll("button").length,
      probes,
      hasTable: Boolean(thR),
      overlapHit,
      stickyZ: {
        thead: th ? getComputedStyle(th).zIndex : null,
        corner: (() => { const c = document.querySelector("thead .stick-col-1"); return c ? getComputedStyle(c).zIndex : null; })(),
      },
    };
  });

  if (r.error) {
    check("검색 드롭다운 렌더", false, r.error);
    await page.close();
    continue;
  }

  check("body 로 portal 됨(카드 overflow-hidden 밖)", r.portaled === true);
  check("position:fixed + z-index 60 (sticky 40 · 팝오버 50 위)", r.position === "fixed" && r.zIndex === "60",
    `${r.position}/${r.zIndex}, sticky thead=${r.stickyZ.thead} corner=${r.stickyZ.corner}`);
  check("검색 입력 바로 아래·같은 폭에 정렬", r.alignedTop && r.alignedLeft && r.alignedWidth,
    `top=${r.alignedTop} left=${r.alignedLeft} width=${r.alignedWidth}`);
  check("검색 결과 항목 렌더", r.itemCount > 0, `${r.itemCount}건`);
  const covered = r.probes.filter((p) => !p.inside);
  check("메뉴 전 구간이 최상단에 그려짐(가려짐 0)", covered.length === 0,
    covered.length ? `가려진 지점 ${covered.map((c) => `${c.y}px→${c.hit}`).join(", ")}` : `${r.probes.length}지점 확인`);
  if (r.hasTable) {
    check("표 헤더와 겹치는 지점에서도 드롭다운이 위", r.overlapHit?.inside === true,
      r.overlapHit ? `hit=${r.overlapHit.hit}` : "겹침 구간 없음");
  } else {
    check("표 없음(카드가 짧음) — 카드 경계 아래까지 잘리지 않음", covered.length === 0);
  }

  // 항목 클릭 → 선택 반영 + 메뉴 닫힘(포털 분리 후에도 mousedown 바깥클릭에 먹히지 않는지).
  const first = page.locator('[data-slot="anchored-portal-menu"] button').first();
  const label = (await first.innerText()).replace(/\s+/g, " ").trim();
  await first.click();
  await page.waitForTimeout(500);
  const afterPick = await page.evaluate(() => ({
    open: Boolean(document.querySelector('[data-slot="anchored-portal-menu"]')),
    value: document.querySelector('input[aria-label="수동 추가 크루 검색"]').value,
  }));
  check("항목 클릭 → 선택 반영 + 메뉴 닫힘", !afterPick.open && afterPick.value.length > 0,
    `value="${afterPick.value}" (항목="${label}")`);

  // Esc 로 닫힘.
  await page.getByLabel("수동 추가 크루 검색").fill("");
  await page.getByLabel("수동 추가 크루 검색").pressSequentially(Q, { delay: 120 });
  await page.waitForTimeout(3500);
  const openedAgain = await page.evaluate(() => Boolean(document.querySelector('[data-slot="anchored-portal-menu"]')));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const afterEsc = await page.evaluate(() => Boolean(document.querySelector('[data-slot="anchored-portal-menu"]')));
  check("Esc 로 닫힘", openedAgain && !afterEsc, `reopen=${openedAgain} afterEsc=${afterEsc}`);

  await page.close();
}

await browser.close();
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

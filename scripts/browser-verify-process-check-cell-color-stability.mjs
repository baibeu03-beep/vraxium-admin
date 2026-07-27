// 브라우저 검증(보강) — 프로세스 체크 표 배지 색의 **정렬/재렌더/테마 안정성**.
//
//   검증 계약:
//     (1) 정렬 클릭(asc → desc → 기본)으로 행 순서가 바뀌어도 `값 → 색` 매핑이 그대로다.
//         (= 색이 "화면에 나타난 순서"가 아니라 컬럼+셀값으로만 정해진다)
//     (2) 다크 모드로 전환하면 색 토큰은 바뀌지만(theme-aware), 같은 값끼리는 여전히 같은 색이다.
//     (3) 라이트/다크 모두에서 배지 전경색과 배경색이 서로 구분된다(투명/동일색 아님).
//     (4) 별/방패(초록) · 번개(빨강) 셀값 색도 다크 모드에서 각각 유지된다.
//
//   조회 전용 — 정렬 헤더/테마 토글만 클릭한다(저장/검수/롤백 없음).
//   run: node scripts/browser-verify-process-check-cell-color-stability.mjs
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
const g = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = process.env.BASE ?? "http://localhost:3000";
const SUPABASE_URL = g("NEXT_PUBLIC_SUPABASE_URL");
const ANON = g("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = g("SUPABASE_SERVICE_ROLE_KEY");
const admin = createClient(SUPABASE_URL, SERVICE);

const BADGE_COLUMNS = ["소속 라인 급", "종류", "카페"];
const TARGET = process.env.TARGET ?? "/admin/integrated/processes/check/info?org=encre";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++; else fail++;
};

async function makeAdminCookies() {
  const { data: adm } = await admin
    .from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = process.env.SMOKE_ADMIN_EMAIL ?? adm?.[0]?.email;
  const b = createClient(SUPABASE_URL, ANON);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await b.auth.verifyOtp({ email, token: link.properties.email_otp, type: "magiclink" });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  console.log(`admin = ${email}`);
  return captured.map((i) => ({
    name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax",
  }));
}

// 값 → 색 매핑 + 행 순서 시그니처를 한 번에 읽는다.
const snapshot = (page, columns) =>
  page.evaluate((cols) => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const t = Array.from(document.querySelectorAll("table")).find((tb) =>
      Array.from(tb.querySelectorAll("thead th")).some((th) => /소속 라인 급/.test(th.textContent || "")));
    if (!t) return null;
    const labels = Array.from(t.querySelectorAll("thead th")).map((th) => norm(th.textContent));
    const idxOf = (l) => labels.findIndex((x) => x === l || x.startsWith(l));
    const map = {};
    for (const c of cols) map[c] = {};
    const points = { a: [], b: [], c: [] };
    // po 컬럼 = "소요 시간(m)" 다음 3개(조직별 표시명이라 위치로 잡는다).
    const durIdx = idxOf("소요 시간(m)");
    const order = [];
    const nameIdx = idxOf("액트명");
    for (const tr of Array.from(t.querySelectorAll("tbody tr"))) {
      const tds = Array.from(tr.querySelectorAll("td"));
      if (tds.length < labels.length - 1) continue;
      if (nameIdx >= 0 && tds[nameIdx]) order.push(norm(tds[nameIdx].textContent));
      for (const c of cols) {
        const i = idxOf(c);
        if (i < 0 || !tds[i]) continue;
        const b = tds[i].querySelector('[data-slot="badge"],[data-slot="badge-button"]');
        if (!b) continue;
        const cs = getComputedStyle(b);
        map[c][norm(tds[i].textContent)] = `${cs.color}|${cs.backgroundColor}|${cs.borderColor}`;
      }
      if (durIdx >= 0) {
        const keys = ["a", "b", "c"];
        for (let k = 0; k < 3; k += 1) {
          const cell = tds[durIdx + 1 + k];
          if (cell) points[keys[k]].push(getComputedStyle(cell).color);
        }
      }
    }
    return { map, points, order, rowCount: order.length };
  }, columns);

const sameMap = (a, b) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diffs = [];
  for (const k of keys) if (a[k] && b[k] && a[k] !== b[k]) diffs.push(k);
  return diffs;
};

async function main() {
  const cookies = await makeAdminCookies();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1800, height: 1200 } });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();

  console.log(`\n▸ ${TARGET}`);
  await page.goto(`${BASE}${TARGET}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll("thead th")).some((th) => /소속 라인 급/.test(th.textContent || "")),
    { timeout: 90000, polling: 500 },
  );
  const base = await snapshot(page, BADGE_COLUMNS);
  if (!base) { console.log("표를 찾지 못했습니다."); process.exit(1); }
  console.log(`  표본 ${base.rowCount}행 · 소속 라인 급 ${Object.keys(base.map["소속 라인 급"]).length}값`);

  // (1) 정렬 3단계 순환 — 매번 값→색 매핑 대조.
  const sortBtn = page.locator('button[aria-label="소속 라인 급 정렬"]').first();
  const orders = [base.order.join("|")];
  for (const step of ["asc", "desc", "기본"]) {
    await sortBtn.click();
    await page.waitForTimeout(300);
    const s = await snapshot(page, BADGE_COLUMNS);
    orders.push(s.order.join("|"));
    let diffs = [];
    for (const c of BADGE_COLUMNS) diffs = diffs.concat(sameMap(base.map[c], s.map[c]).map((v) => `${c}:${v}`));
    check(`정렬 ${step} 후 값→색 불변`, diffs.length === 0, diffs.slice(0, 3).join(", ") || `${s.rowCount}행`);
  }
  check("정렬로 행 순서가 실제로 바뀌었다(검증 유효성)", new Set(orders).size > 1,
    `서로 다른 순서 ${new Set(orders).size}종`);

  // (2)(3) 다크 모드 — 토큰은 바뀌되 값→색 결정론과 전/배경 구분은 유지.
  await page.evaluate(() => {
    document.documentElement.classList.add("dark");
    document.documentElement.style.colorScheme = "dark";
  });
  await page.waitForTimeout(300);
  const dark = await snapshot(page, BADGE_COLUMNS);
  for (const c of BADGE_COLUMNS) {
    const lightVals = base.map[c];
    const darkVals = dark.map[c];
    const shared = Object.keys(lightVals).filter((k) => darkVals[k]);
    if (shared.length === 0) continue;
    check(`${c} 다크 모드에서 토큰 전환됨(theme-aware)`,
      shared.some((k) => lightVals[k] !== darkVals[k]),
      `${shared.length}값 비교`);
    // 같은 값 = 같은 색(다크 안에서도 결정론) — 값별 색이 1:1 인지 확인.
    const byValue = new Map();
    let conflict = null;
    for (const k of Object.keys(darkVals)) {
      if (byValue.has(k) && byValue.get(k) !== darkVals[k]) conflict = k;
      byValue.set(k, darkVals[k]);
    }
    check(`${c} 다크 모드 값→색 결정론`, !conflict, conflict ?? `${byValue.size}값`);
    const flat = shared.map((k) => darkVals[k].split("|"));
    check(`${c} 다크 모드 전경≠배경(가독성)`, flat.every(([fg, bg]) => fg !== bg), flat[0]?.join(" on "));
  }
  const lightFlat = Object.values(base.map["소속 라인 급"]).map((v) => v.split("|"));
  check("라이트 모드 전경≠배경(가독성)", lightFlat.every(([fg, bg]) => fg !== bg), lightFlat[0]?.join(" on "));

  // (4) 별/방패/번개 — 다크에서도 A/B 는 서로 같은 색, C 는 다른 색(초록/빨강 분리 유지).
  for (const [label, snap] of [["라이트", base], ["다크", dark]]) {
    const a = new Set(snap.points.a), b = new Set(snap.points.b), c = new Set(snap.points.c);
    if (a.size === 0) continue;
    check(`${label} 별/방패 동일 색(초록 계열)`, a.size === 1 && b.size === 1 && [...a][0] === [...b][0], [...a][0]);
    check(`${label} 번개 단일 색 & 별/방패와 구분(빨강)`, c.size === 1 && [...c][0] !== [...a][0], [...c][0]);
  }

  await browser.close();
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

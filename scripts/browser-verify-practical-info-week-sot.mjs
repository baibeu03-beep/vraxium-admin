// 브라우저 검증 — 실무 정보 라인: "주차별 개설 결과" 선택 주차 == "신규 개설 주차"/라인 목록.
//   /admin/line-opening/practical-info?org={encre,oranke,phalanx}&mode={test,operating}
//   확인:
//     1) 진입 기본 선택 주차에서 "신규 개설 주차" 라벨·라인 목록 주차가 드롭다운 선택과 일치
//     2) 드롭다운에서 26 봄 W16 선택 → "신규 개설 주차" 라벨·라인 목록이 W16 로 따라감(W13 잔존 0)
//     3) 다시 W13 선택 → W16 잔존 0
//   표시 전용 — DB/저장/API write·snapshot 무접촉.
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

const RESULT_SELECT = "select[aria-label='개설 결과 주차 선택']";

// 라인 목록 표(첫 컬럼=주차)의 행별 주차 텍스트 수집.
//   라인 목록 표는 헤더에 "생성일" 컬럼이 있는 유일한 표(상세 모달 표에는 없음)로 식별한다.
//   주차 셀은 ISO 주차 라벨(예: "2026-W22 (2026-05-25 ~ 2026-05-31)") 형식이라 날짜로 판정한다.
const linesWeekCellsJs = `(() => {
  const tables = Array.from(document.querySelectorAll('table'));
  const t = tables.find((tb) => Array.from(tb.querySelectorAll('thead th')).some((th) => (th.textContent||'').includes('생성일')));
  if (!t) return null; // 표 미발견(미렌더)
  return Array.from(t.querySelectorAll('tbody tr')).map((r) => (r.querySelector('td')?.textContent || '').trim());
})()`;

// 2026 봄 W13 = ISO 2026-05-25 시작, W16 = 2026-06-15 시작. 라인 주차 셀을 날짜로 판정.
const W13_DATE = "2026-05-25";
const W16_DATE = "2026-06-15";
const cellsHaveOnly = (cells, wantDate, banDate) =>
  Array.isArray(cells) &&
  cells.every((c) => c.includes(wantDate)) &&
  !cells.some((c) => c.includes(banDate));

const labelJs = `(() => {
  const p = Array.from(document.querySelectorAll('p')).find((e) => (e.textContent||'').includes('신규 개설 주차'));
  return p ? p.textContent.trim() : '';
})()`;

// 주차 선택 + 아래 "라인 목록" 표의 info-lines 조회(activity_type_id 포함)가 끝날 때까지 대기.
//   (fetchWeekLines 는 week_id 만 → activity_type_id 유무로 라인 목록 fetch 만 골라 기다린다.)
async function selectWeekAndWait(page, val) {
  const waitLines = page
    .waitForResponse(
      (r) =>
        r.url().includes("/api/admin/cluster4/info-lines?") &&
        r.url().includes("activity_type_id="),
      { timeout: 30000 },
    )
    .catch(() => null);
  await page.selectOption(RESULT_SELECT, val);
  await waitLines;
  // 응답 후 React 리렌더 반영 한 틱 대기.
  await page.waitForTimeout(300);
}

async function optionValueByWeek(page, weekNumStr) {
  return page.evaluate(`(() => {
    const s = document.querySelector("${RESULT_SELECT}");
    if (!s) return null;
    const o = Array.from(s.options).find((o) => o.text.includes("${weekNumStr}주차"));
    return o ? o.value : null;
  })()`);
}

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 2000 } });
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();

try {
  for (const { org, mode } of [
    { org: "encre", mode: "test" },
    { org: "encre", mode: "operating" },
    { org: "oranke", mode: "test" },
    { org: "phalanx", mode: "test" },
  ]) {
    console.log(`\n[org=${org} mode=${mode}]`);
    await page.goto(`${BASE}/admin/line-opening/practical-info?org=${org}&mode=${mode}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction("document.body.innerText.includes('주차별 개설 결과')", undefined, { timeout: 60000 });
    await page.waitForFunction(
      `(() => { const s = document.querySelector("${RESULT_SELECT}"); return s && s.options.length > 0 && s.options[0].text !== '주차 없음'; })()`,
      undefined, { timeout: 60000 },
    );
    // 라벨이 렌더될 때까지 대기.
    await page.waitForFunction(labelJs.replace("return p ? p.textContent.trim() : '';", "return !!p;"), undefined, { timeout: 60000 }).catch(() => {});

    const w16val = await optionValueByWeek(page, "16");
    const w13val = await optionValueByWeek(page, "13");
    check(`${org}/${mode}: 드롭다운에 W16 옵션 존재`, Boolean(w16val));
    check(`${org}/${mode}: 드롭다운에 W13 옵션 존재`, Boolean(w13val));
    if (!w16val || !w13val) continue;

    // ── 진입 기본값 정합: 드롭다운 선택값 ↔ 라벨 주차 일치 ──
    const defVal = await page.$eval(RESULT_SELECT, (s) => s.value);
    const defLabel = await page.evaluate(labelJs);
    const defWeekNum = defVal === w16val ? "16" : defVal === w13val ? "13" : "?";
    check(
      `${org}/${mode}: 기본 라벨 주차 == 드롭다운 선택(${defWeekNum}주차)`,
      defWeekNum !== "?" && defLabel.includes(`${defWeekNum}주차`),
      `label="${defLabel}"`,
    );

    // ── W16 선택 → 라벨/라인목록 W16, W13 잔존 0 ──
    await selectWeekAndWait(page, w16val);
    await page.waitForFunction(`(${labelJs}).includes('16주차')`, undefined, { timeout: 30000 }).catch(() => {});
    const label16 = await page.evaluate(labelJs);
    const cells16 = (await page.evaluate(linesWeekCellsJs)) ?? [];
    check(`${org}/${mode}: W16 선택 → "신규 개설 주차" 라벨 16주차`, label16.includes("16주차"), `label="${label16}"`);
    check(`${org}/${mode}: W16 선택 → 라벨에 13주차 잔존 없음`, !label16.includes("13주차"));
    check(
      `${org}/${mode}: W16 선택 → 라인 목록 주차 전부 W16(또는 0행), W13 잔존 0`,
      cellsHaveOnly(cells16, W16_DATE, W13_DATE),
      `rows=${cells16.length} cells=[${cells16.join(" | ")}]`,
    );

    // ── W13 선택 → 라벨/라인목록 W13, W16 잔존 0 ──
    await selectWeekAndWait(page, w13val);
    await page.waitForFunction(`(${labelJs}).includes('13주차')`, undefined, { timeout: 30000 }).catch(() => {});
    const label13 = await page.evaluate(labelJs);
    const cells13 = (await page.evaluate(linesWeekCellsJs)) ?? [];
    check(`${org}/${mode}: W13 선택 → "신규 개설 주차" 라벨 13주차`, label13.includes("13주차"), `label="${label13}"`);
    check(
      `${org}/${mode}: W13 선택 → 라인 목록 주차 전부 W13(또는 0행), W16 잔존 0`,
      cellsHaveOnly(cells13, W13_DATE, W16_DATE),
      `rows=${cells13.length} cells=[${cells13.join(" | ")}]`,
    );

    // encre/oranke 의 기본 탭(위즈덤)은 W13 에 활성 라인이 있어 행이 실제로 떠야 한다 →
    //   W13 행 존재(>=1) ↔ W16 행 0 으로 "라인 목록이 선택 주차를 따라 내용까지 바뀜"을 입증.
    if (mode === "test" && (org === "encre" || org === "oranke")) {
      check(
        `${org}/${mode}: 위즈덤 탭 W13 행 존재(>=1) & 같은 탭 W16 행 0 (내용 플립 입증)`,
        cells13.length >= 1 && cells13.every((c) => c.includes(W13_DATE)) && cells16.length === 0,
        `W13행=${cells13.length} W16행=${cells16.length}`,
      );
    }

    if (org === "encre" && mode === "test") {
      await selectWeekAndWait(page, w16val);
      await page.waitForFunction(`(${labelJs}).includes('16주차')`, undefined, { timeout: 30000 }).catch(() => {});
      await page.waitForFunction("!document.body.innerText.includes('개설 결과 불러오는 중')", undefined, { timeout: 30000 }).catch(() => {});
      await page.screenshot({ path: resolve(adminRoot, "claudedocs", "practical-info-week-sot-encre-test-w16.png"), fullPage: false });
    }
  }

  console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ " + fail + " FAIL"} (pass=${pass})`);
} finally {
  await browser.close();
}
process.exit(fail === 0 ? 0 : 1);

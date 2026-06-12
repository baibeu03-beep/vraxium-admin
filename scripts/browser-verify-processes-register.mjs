// 검증 — /admin/processes/register 브라우저 반영.
//   1) 5탭(클럽 총괄/실무 정보/경험/역량/경력 급) + 시안 12개 섹션 렌더.
//   2) UI 라운드트립: 라인급명 입력→Enter→칩 표시(액트 0)→X 삭제(빈 그룹)→제거 (browser→API→DB→render).
//   3) 액트 폼 요소(소요시간/발생·체크 시점/포인트 A·B·C/카페/체크대상/액트종류/개요/비고) 렌더.
// net-zero: TAG 행은 service-role 로 정리.
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
const TAG = "ZZ-procUI";
const sbAdmin = createClient(SUPABASE_URL, SERVICE);

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

async function cleanup() {
  const groups = (await sbAdmin.from("process_line_groups").select("id").like("name", `${TAG}%`)).data ?? [];
  const ids = groups.map((g) => g.id);
  if (ids.length) {
    await sbAdmin.from("process_acts").delete().in("line_group_id", ids);
    await sbAdmin.from("process_line_groups").delete().in("id", ids);
  }
}

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const cookies = await makeAdminCookies();
await cleanup();

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 2200 } });
await context.addCookies(cookies);
const page = await context.newPage();
page.on("dialog", (d) => d.accept().catch(() => {})); // confirm/alert 자동 수락

try {
  await page.goto(`${BASE}/admin/processes/register`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("document.body.innerText.includes('프로세스 등록')", undefined, { timeout: 30000 }).catch(() => {});
  const body = await page.evaluate("document.body.innerText");

  // 1) 5탭 렌더
  check("[탭] 5개 허브급(클럽 총괄/실무 정보/경험/역량/경력 급)",
    ["클럽 총괄 급", "실무 정보 급", "실무 경험 급", "실무 역량 급", "실무 경력 급"].every((t) => body.includes(t)));

  // 2) 시안 12개 섹션 라벨 렌더
  const labels = ["소속 허브급", "액트명", "소속 라인급", "소요 시간", "발생 시점", "체크 시점", "포인트", "카페", "체크 대상", "액트 종류", "개요", "비고"];
  const missing = labels.filter((l) => !body.includes(l));
  check("[폼] 시안 12개 섹션 라벨 전부 렌더", missing.length === 0, missing.length ? `누락=${missing.join(",")}` : "");

  // 액트 폼 요소(aria-label/포인트 라벨/textarea) 존재
  const formEls = await page.evaluate(() => {
    const q = (s) => !!document.querySelector(s);
    const body = document.body.innerText;
    return {
      duration: q('select[aria-label="소요 시간"]'),
      occur: q('select[aria-label="발생 주"]') && q('select[aria-label="발생 요일"]') && q('select[aria-label="발생 시간"]'),
      checkWhen: q('select[aria-label="체크 주"]') && q('select[aria-label="체크 요일"]') && q('select[aria-label="체크 시간"]'),
      points: q('select[aria-label="A · point.check"]') && q('select[aria-label="B · point.advantage"]') && q('select[aria-label="C · point.penalty"]'),
      cafe: q('select[aria-label="카페"]'),
      checkTarget: q('select[aria-label="체크 대상"]'),
      actType: q('select[aria-label="액트 종류"]'),
      overview: q('textarea[aria-label="개요"]'),
      remarks: q('textarea[aria-label="비고"]'),
      actNameInput: q('input[maxlength="30"]'),
      hasActListSection: body.includes("등록된 액트"),
    };
  });
  check("[폼] 소요시간 드롭다운", formEls.duration);
  check("[폼] 발생 시점 3종(주/요일/시간)", formEls.occur);
  check("[폼] 체크 시점 3종(주/요일/시간)", formEls.checkWhen);
  check("[폼] 포인트 A·B·C 드롭다운(0~20)", formEls.points);
  check("[폼] 카페/체크대상/액트종류 드롭다운", formEls.cafe && formEls.checkTarget && formEls.actType);
  check("[폼] 개요/비고 textarea", formEls.overview && formEls.remarks);
  check("[폼] 등록된 액트 확인 섹션", formEls.hasActListSection);

  // 등록/초기화 버튼(액트 폼 하단)
  const hasButtons = await page.evaluate(() => {
    const txt = [...document.querySelectorAll("button")].map((b) => (b.textContent || "").trim());
    return txt.includes("등록") && txt.includes("초기화");
  });
  check("[폼] 등록·초기화 버튼", hasButtons);

  // 3) UI 라운드트립 — 라인급명 입력 → Enter → 칩 표시(액트 0)
  const gName = `${TAG} 라인급`;
  await page.fill('input[placeholder*="라인급명"]', gName);
  await page.press('input[placeholder*="라인급명"]', "Enter");
  await page.waitForFunction(
    (n) => document.body.innerText.includes(n) && document.body.innerText.includes("(액트 0)"),
    gName, { timeout: 15000 },
  ).catch(() => {});
  const afterAdd = await page.evaluate("document.body.innerText");
  check("[UI] 라인급 등록 → 칩 표시(액트 0)", afterAdd.includes(gName) && afterAdd.includes("(액트 0)"));

  // DB 반영 확인(browser→API→DB)
  const dbRow = (await sbAdmin.from("process_line_groups").select("id,hub,name").eq("name", gName).maybeSingle()).data;
  check("[UI] 라인급 DB 저장 확인(hub=club)", !!dbRow && dbRow.hub === "club", dbRow ? dbRow.id : "no row");

  // 체크박스 단일 선택 동작
  const chk = await page.evaluate((n) => {
    const cb = document.querySelector(`input[aria-label="${n} 선택"]`);
    if (!cb) return { found: false };
    cb.click();
    return { found: true, checked: cb.checked };
  }, gName);
  check("[UI] 라인급 칩 체크박스 선택 동작", chk.found && chk.checked);

  // X 삭제(빈 그룹) → 제거 (confirm 자동 수락)
  await page.click(`button[aria-label="${gName} 삭제"]`);
  await page.waitForFunction((n) => !document.body.innerText.includes(n), gName, { timeout: 15000 }).catch(() => {});
  const afterDel = await page.evaluate("document.body.innerText");
  const dbGone = (await sbAdmin.from("process_line_groups").select("id").eq("name", gName).maybeSingle()).data;
  check("[UI] 빈 라인급 X 삭제 → 칩 제거 + DB 삭제", !afterDel.includes(gName) && !dbGone);

  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-processes-register.png"), fullPage: true });
  console.log("  screenshot → claudedocs/browser-processes-register.png");
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
  try { await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-processes-register-error.png"), fullPage: true }); } catch {}
} finally {
  await browser.close();
  await cleanup();
  console.log("(cleanup 완료 — net-zero)");
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);

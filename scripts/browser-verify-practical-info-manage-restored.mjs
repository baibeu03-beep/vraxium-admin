// 브라우저 검증 — practical-info 라인 관리/라인 개설 탭 디자인 복구 확인.
//   manage(라인 관리): "현재 상황" + "주차별 개설 결과" 카드 복구(원래 디자인), H1 제목은 계속 제거.
//   open(라인 개설): 두 카드 계속 미노출(요청 제거 유지), Section0 입력 UI 정상.
//   표시 전용 — DB/저장/API 무접촉.
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
const ORG = "oranke";

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

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1800 } });
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();

try {
  // ── 라인 관리(manage) 탭 ──
  console.log("\n[라인 관리 tab]");
  await page.goto(`${BASE}/admin/line-opening/practical-info?org=${ORG}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("document.body.innerText.includes('현재 상황') && document.body.innerText.includes('주차별 개설 결과')", undefined, { timeout: 60000 });
  let body = await page.evaluate("document.body.innerText");
  const h1s = await page.evaluate(`Array.from(document.querySelectorAll('h1')).map((h) => h.innerText.trim())`);
  check("[복구] '현재 상황' 카드 노출", body.includes("현재 상황"));
  check("[복구] '주차별 개설 결과' 카드 노출", body.includes("주차별 개설 결과"));
  check("[유지] H1 '실무 정보 라인 운영' 제목 제거", !h1s.some((t) => t.includes("실무 정보 라인 운영")), `h1s=${JSON.stringify(h1s)}`);
  check("[유지] 라인 목록(관리 UI) 노출", body.includes("라인 목록") || body.includes("새 라인 개설"));
  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-practical-info-manage-restored.png"), fullPage: true });

  // ── 라인 개설(open) 탭 ──
  console.log("\n[라인 개설 tab]");
  await page.goto(`${BASE}/admin/line-opening/practical-info?org=${ORG}&tab=open`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("document.body.innerText.includes('상태창')", undefined, { timeout: 60000 });
  body = await page.evaluate("document.body.innerText");
  // open 탭 본문은 Section0(상태창/개설 폼) — 페이지 레벨 카드는 미노출이어야.
  // 'PracticalInfoWeekResults' 카드 제목과 'PracticalInfoCurrentSituation' 카드 제목 부재 확인.
  //   주의: Section0 내부에도 '상태창'(다른 카드)·로그 등이 있으나, 페이지 레벨 '현재 상황'/'주차별 개설 결과'는 없어야 한다.
  check("[유지·제거] 페이지 '현재 상황' 카드 미노출", !body.includes("현재 상황"));
  check("[유지·제거] 페이지 '주차별 개설 결과' 카드 미노출", !body.includes("주차별 개설 결과"));
  check("[유지] 개설 입력 영역(Section0 상태창) 노출", body.includes("상태창"));
  check("[유지] 라인 개설 폼 노출", body.includes("개설할 라인") || body.includes("메인 타이틀") || body.includes("아웃풋"));
  const h1sOpen = await page.evaluate(`Array.from(document.querySelectorAll('h1')).map((h) => h.innerText.trim())`);
  check("[유지] H1 '실무 정보 라인 운영' 제목 제거", !h1sOpen.some((t) => t.includes("실무 정보 라인 운영")));
  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-practical-info-open-clean.png"), fullPage: true });
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
  try { await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-practical-info-restore-error.png"), fullPage: true }); } catch {}
} finally {
  await browser.close();
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);

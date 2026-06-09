// 브라우저 검증 — 라인 개설 예외(:3000, 어드민 세션 쿠키 주입).
//   (1) /admin/settings/line-opening-windows — 화면1 자동정책(금요일 경계)·화면2 폼·화면3 목록 렌더,
//       UI 로 예외 등록→목록 반영→삭제→사라짐.
//   (2) /admin/line-opening/practical-info — 상단 "현재 상황" 패널 렌더.
//   page.evaluate 는 문자열형(SYS_NO_PATHCONV 회피). prod SoT 변경 없음(테스트 행은 정리).
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

const sb = createClient(SUPABASE_URL, SERVICE);
const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1700 } });
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();

let testWeekId = null;
try {
  // ── 1) 설정 페이지 렌더 ──
  // ⚠ 사이드바에도 "라인 개설 기간" 링크가 있어 body 텍스트만으로는 매니저 로드를 보장 못 한다.
  //   매니저 전용 요소(#exc-week, loading=false 이후 렌더)를 기다려 데이터 로드 완료를 확정한다.
  await page.goto(`${BASE}/admin/settings/line-opening-windows`, { waitUntil: "domcontentloaded" });
  const weekSelect = page.locator("#exc-week");
  await weekSelect.waitFor({ timeout: 60000 });
  check("설정 페이지 렌더(매니저 로드 완료)", true);
  check(
    "화면1 자동정책 — '현재 자동 개설 대상' + '금요일 경계' 표시",
    await page.evaluate("document.body.innerText.includes('현재 자동 개설 대상') && document.body.innerText.includes('금요일 경계')"),
  );
  check(
    "화면1 규칙 — 월·화·수·목 → 지난 주차(N-1)",
    await page.evaluate("document.body.innerText.includes('월 · 화 · 수 · 목')"),
  );
  check(
    "화면2 예외 추가 폼 — '허용 범위' + '예외 등록' 버튼",
    await page.evaluate("document.body.innerText.includes('허용 범위') && document.body.innerText.includes('예외 등록')"),
  );

  // ── 2) UI 로 예외 등록(주차 전체) → 목록 반영 ──
  // 기존 행이 있는 주차는 제외하고(사용자/잔여 데이터 무접촉) 첫 실 옵션을 고른다.
  const { data: existing } = await sb.from("line_opening_windows").select("week_id");
  const excluded = JSON.stringify([...new Set((existing ?? []).map((r) => r.week_id))]);
  const optValue = await page.evaluate(
    "(function(){var ex=" + excluded + ";var s=document.getElementById('exc-week');for(var i=0;i<s.options.length;i++){var v=s.options[i].value;if(v&&ex.indexOf(v)<0)return v;}return '';})()",
  );
  if (!optValue) { check("등록 가능한(잔여 없는) 테스트 주차 확보", false, "모든 옵션에 기존 행 존재"); throw new Error("no free week"); }
  testWeekId = optValue;
  await weekSelect.selectOption(optValue);
  await page.getByRole("button", { name: "예외 등록" }).click();
  await page.waitForFunction("document.body.innerText.includes('예외가 등록되었습니다')", undefined, { timeout: 15000 });
  check("UI 예외 등록 → 성공 배너", true);
  check(
    "화면3 목록 — '활성' 배지 + '전체 라인' 반영",
    await page.evaluate("document.body.innerText.includes('활성') && document.body.innerText.includes('전체 라인')"),
  );

  // ── 3) UI 비활성화 → 활성화 토글 ──
  await page.getByRole("button", { name: "비활성화" }).first().click();
  await page.waitForFunction("document.body.innerText.includes('비활성')", undefined, { timeout: 10000 });
  check("UI 비활성화 → '비활성' 반영", true);

  // ── 4) 정리: 등록한 테스트 주차 행 삭제(서비스 롤, prod 잔여 방지) ──
  if (testWeekId) await sb.from("line_opening_windows").delete().eq("week_id", testWeekId);

  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-line-opening-windows-settings.png"), fullPage: true });

  // ── 5) practical-info 상단 "현재 상황" 패널 ──
  await page.goto(`${BASE}/admin/line-opening/practical-info`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("document.body.innerText.includes('현재 상황')", undefined, { timeout: 60000 });
  check("practical-info '현재 상황' 패널 렌더", true);
  check(
    "현재 상황 — '개설' 안내 문구 존재(금요일 경계 표시 경로)",
    await page.evaluate("document.body.innerText.includes('개설')"),
  );
  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-line-opening-practical-info.png"), fullPage: true });
} catch (e) {
  console.error("browser error:", e?.message ?? e);
  fail++;
} finally {
  // 안전 정리.
  if (testWeekId) { try { await sb.from("line_opening_windows").delete().eq("week_id", testWeekId); } catch {} }
  await browser.close();
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);

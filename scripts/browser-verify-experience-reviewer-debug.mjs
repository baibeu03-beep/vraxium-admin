// 브라우저 검증 — /admin/processes/check/experience?org=encre&mode=test 에서
//   실 테스트 행([브리핑] 팀 시작 · 비주얼랩(T))이 "체크 대기"로 보이고,
//   액트 팝업 "검수 진단" 블록이 원인(검수 미실행=not_started)을 표시하는지 확인(read-only).
//   전제: dev 서버 + 로그인 쿠키(magiclink). 시드/쓰기 없음(실데이터 read-only).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const reqAdmin = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = reqAdmin("@supabase/supabase-js");
const { createServerClient } = reqAdmin("@supabase/ssr");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const EMAIL = "vanuatu.golden@gmail.com", BASE = "http://localhost:3000";
const URL = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL, SERVICE);
const TEAM = "비주얼랩(T) 팀", ACT = "[브리핑] 팀 시작";

let pass = 0, fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function cookies() {
  const brow = createClient(URL, ANON);
  const { data: l } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: l.properties.email_otp, type: "magiclink" });
  const cap = [];
  const s = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await s.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}

const browser = await chromium.launch();
try {
  const cks = await cookies();
  const ctx = await browser.newContext();
  await ctx.addCookies(cks);
  const page = await ctx.newPage();

  await page.goto(`${BASE}/admin/processes/check/experience?org=encre&mode=test`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  const body = (await page.locator("body").textContent()) ?? "";
  ck("페이지 렌더 + 제목", body.includes("프로세스 체크") && body.includes("실무 경험"));

  // 팀 탭 선택(비주얼랩(T)).
  const tab = page.getByRole("button", { name: TEAM });
  ck("팀 탭 노출(비주얼랩(T))", (await tab.count()) > 0);
  if (await tab.count()) { await tab.first().click(); await page.waitForTimeout(900); }

  // 팀 종합(읽기전용) 기본 — 액트 행 + "체크 대기" 배지 확인.
  const rowAll = page.locator("tr", { hasText: ACT });
  ck("액트 행 노출([브리핑] 팀 시작)", (await rowAll.count()) > 0);
  ck("해당 행 '체크 대기' 표시", ((await rowAll.first().textContent()) ?? "").includes("체크 대기"));

  // 팀 총괄 스코프로 전환 → 액트 클릭 → 팝업 "검수 진단" 확인.
  await page.selectOption('select[aria-label="파트 구분 범위"]', "overall");
  await page.waitForTimeout(900);
  const row = page.locator("tr", { hasText: ACT });
  ck("[팀 총괄] 액트 행 노출", (await row.count()) > 0);
  const btn = row.first().getByRole("button", { name: "체크 대기" });
  ck("[팀 총괄] '체크 대기' 클릭 버튼", (await btn.count()) > 0);
  if (await btn.count()) { await btn.first().click(); await page.waitForTimeout(700); }

  const dialog = (await page.locator('[class*="max-w-md"]').last().textContent()) ?? "";
  ck("팝업 '검수 진단' 블록 노출", dialog.includes("검수 진단"));
  ck("팝업 원인 = '검수 미실행'(not_started)", dialog.includes("검수 미실행"));

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
} finally {
  await browser.close();
}

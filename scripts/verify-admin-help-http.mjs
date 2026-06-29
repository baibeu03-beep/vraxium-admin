// 검증 — 도움말 HTTP API(GET/PUT) 응답 + 브라우저 표시값=API 응답 일치.
//   raw 응답을 출력한다. 테스트 경로는 검증 후 정리(삭제). 실데이터 경로 일시 사용 후 빈값 복구.
//   실행: node scripts/verify-admin-help-http.mjs
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

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE);

async function makeCookieHeader() {
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: ld } = await supabaseAdmin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: vd } = await browser.auth.verifyOtp({ email: adminEmail, token: ld.properties.email_otp, type: "magiclink" });
  const captured = [];
  const sv = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (it) => captured.push(...it) } });
  await sv.auth.setSession({ access_token: vd.session.access_token, refresh_token: vd.session.refresh_token });
  return { header: captured.map((c) => `${c.name}=${c.value}`).join("; "), cookies: captured };
}

let failures = 0;
const check = (label, ok, detail = "") => { if (!ok) failures++; console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); };

async function main() {
  const { header, cookies } = await makeCookieHeader();
  const apiGet = async (path) => {
    const res = await fetch(`${BASE}/api/admin/help?path=${encodeURIComponent(path)}`, { headers: { cookie: header } });
    return { status: res.status, json: await res.json() };
  };
  const apiPut = async (path, content) => {
    const res = await fetch(`${BASE}/api/admin/help`, { method: "PUT", headers: { cookie: header, "Content-Type": "application/json" }, body: JSON.stringify({ path, content }) });
    return { status: res.status, json: await res.json() };
  };

  const P1 = "/admin/__httptest1__";
  const P2 = "/admin/__httptest2__";

  console.log("\n[A] HTTP API GET/PUT 계약");
  let r = await apiGet(P1);
  console.log("  GET(초기):", JSON.stringify(r));
  check("초기 GET 200 + 빈 content", r.status === 200 && r.json.success && r.json.data.content === "", `${r.status}`);

  const A = "도움말 A\n둘째 줄 · 숫자 123";
  r = await apiPut(P1, A);
  console.log("  PUT(A):", JSON.stringify(r));
  check("PUT 200 + 저장 content 반영", r.status === 200 && r.json.success && r.json.data.content === A);

  r = await apiGet(P1);
  console.log("  GET(A 후):", JSON.stringify(r));
  check("GET 200 + 방금 저장값 동일", r.status === 200 && r.json.data.content === A);

  r = await apiPut(P1, "");
  check("빈 문자열 PUT 200 허용", r.status === 200 && r.json.success && r.json.data.content === "");
  r = await apiGet(P1);
  check("빈 저장 후 GET content === ''", r.status === 200 && r.json.data.content === "");

  r = await apiGet(P2);
  check("다른 경로(P2)는 독립적으로 빈값", r.status === 200 && r.json.data.content === "");
  await apiPut(P2, "P2 전용 도움말");
  const p1 = await apiGet(P1), p2 = await apiGet(P2);
  check("페이지별 독립 저장(P1='' · P2=값)", p1.json.data.content === "" && p2.json.data.content === "P2 전용 도움말", `P1="${p1.json.data.content}" P2="${p2.json.data.content}"`);

  console.log("\n[B] 입력 검증(에러 코드)");
  r = await apiGet("/not-admin/x");
  check("어드민 외 경로 GET 400", r.status === 400, `${r.status}`);
  r = await apiPut("/admin/x", 12345);
  check("content 비문자열 PUT 400", r.status === 400, `${r.status}`);
  r = await fetch(`${BASE}/api/admin/help`, { method: "PUT", headers: { cookie: header, "Content-Type": "application/json" }, body: "{not json" }).then((x) => x.status);
  check("깨진 JSON PUT 400", r === 400, `${r}`);

  console.log("\n[C] 브라우저 표시값 = API 응답 일치 (/admin/members)");
  const MEM = "/admin/members";
  const browserContent = `브라우저-API 일치 검증 ${Date.now()}\n- 항목1\n- 항목2`;
  await apiPut(MEM, browserContent);
  const apiRead = (await apiGet(MEM)).json.data.content;

  const browser = await chromium.launch({ channel: "chromium", headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addCookies(cookies.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" })));
  const page = await ctx.newPage();
  await page.goto(`${BASE}${MEM}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.locator("main button", { hasText: "도움말" }).first().click();
  await page.waitForSelector('[role="dialog"][aria-label="관련 도움말"]', { timeout: 8000 });
  await page.waitForTimeout(1000);
  const shown = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    // 본문 영역(읽기) 텍스트만 — 헤더/버튼 제외.
    const body = d.querySelector("div.whitespace-pre-wrap");
    return body ? body.textContent : "(no body)";
  });
  console.log("  API content :", JSON.stringify(apiRead));
  console.log("  브라우저 표시:", JSON.stringify(shown));
  check("브라우저 표시값 === API GET 응답", shown === apiRead && shown === browserContent);
  await page.screenshot({ path: "claudedocs/help-api-match.png" });
  await browser.close();

  console.log("\n[정리] 테스트/실데이터 경로 삭제·복구");
  await supabaseAdmin.from("admin_page_help_contents").delete().in("page_path", [P1, P2, MEM]);
  const cleaned = await apiGet(MEM);
  check("정리 후 /admin/members 빈값 복구", cleaned.json.data.content === "");

  console.log(`\n${failures === 0 ? "✓ 전체 통과" : `✗ 실패 ${failures}건`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

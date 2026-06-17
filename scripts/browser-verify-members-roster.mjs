// 검증(브라우저) — /admin/members "크루 목록" 탭 실제 렌더 + 네트워크.
//   1) 새 18개 컬럼 헤더 노출 · 구 컬럼(연락 이메일/Net Advantage 등) 부재
//   2) /api/admin/members/roster 호출(200) · 구 /api/admin/members 미호출
//   3) "불러오는 중..." 로딩 상태 해제(행 렌더 or 빈 결과 안내)
//   사전조건: admin dev :3000. Usage: node scripts/browser-verify-members-roster.mjs
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

let fail = 0;
const ck = (l, ok, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({
  email: EMAIL,
  token: link.properties.email_otp,
  type: "magiclink",
});
const cap = [];
const srv = createServerClient(URL_, ANON, {
  cookies: { getAll: () => [], setAll: (i) => cap.push(...i) },
});
await srv.auth.setSession({
  access_token: v.session.access_token,
  refresh_token: v.session.refresh_token,
});
const cookies = cap.map((i) => ({
  name: i.name, value: i.value, domain: "localhost", path: "/",
  httpOnly: false, secure: false, sameSite: "Lax",
}));

const NEW_COLUMNS = [
  "이름", "클럽명", "상태", "클래스", "성별", "생년월일", "학교", "전공",
  "팀", "파트", "품계", "성장 성공", "성장 가능", "Po.A", "Po.B", "Po.C",
  "일정 신뢰도", "활동 완료율",
];
const OLD_COLUMNS = ["연락 이메일", "로그인 이메일", "Net Advantage", "Penalty", "Advantage"];

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
await context.addCookies(cookies);
const page = await context.newPage();

// 네트워크 캡처 — roster 호출 + 구 members API 호출 여부.
const apiCalls = [];
page.on("response", (res) => {
  const u = res.url();
  if (u.includes("/api/admin/members")) apiCalls.push({ url: u, status: res.status() });
});

await page.goto(`${BASE}/admin/members`, { waitUntil: "domcontentloaded" });
// 콜드 컴파일 + 로딩 해제 대기 — "불러오는 중..."이 사라지고 헤더가 보일 때까지(최대 25s).
await page
  .waitForFunction(() => {
    const t = document.body.innerText;
    return t.includes("성장 성공") && !t.includes("불러오는 중...");
  }, { timeout: 25000 })
  .catch(() => {});
await page.waitForTimeout(800);

// innerText 는 CSS `uppercase` 변환을 반영 → 컬럼 매칭은 대소문자 무시.
const bodyRaw = await page.evaluate(() => document.body.innerText);
const body = bodyRaw;
const bodyLc = bodyRaw.toLowerCase();
const has = (s) => bodyLc.includes(s.toLowerCase());
const rowCount = await page.evaluate(
  () => document.querySelectorAll("table tbody tr").length,
);

console.log("▶ /admin/members 크루 목록 탭");
for (const c of NEW_COLUMNS) ck(`신규 컬럼 '${c}'`, has(c));
for (const c of OLD_COLUMNS) ck(`구 컬럼 '${c}' 부재`, !has(c));
ck("로딩('불러오는 중...') 해제", !body.includes("불러오는 중..."));
ck("표 행 렌더(>0) 또는 빈결과 안내", rowCount > 0 || body.includes("조회된 크루가 없습니다"));

const roster = apiCalls.filter((c) => c.url.includes("/members/roster"));
const oldApi = apiCalls.filter(
  (c) => /\/api\/admin\/members(\?|$)/.test(c.url) && !c.url.includes("/roster"),
);
ck("roster API 호출됨", roster.length > 0, roster.map((c) => c.status).join(","));
ck("roster API 200", roster.every((c) => c.status === 200));
ck("구 /api/admin/members 미호출", oldApi.length === 0, oldApi.map((c) => c.url).join(" "));
console.log(`  · 표 행 수: ${rowCount}`);
console.log(`  · members API 호출: ${apiCalls.map((c) => `${c.status} ${c.url.replace(BASE, "")}`).join(" | ")}`);

await browser.close();
console.log("─".repeat(50));
console.log(fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);

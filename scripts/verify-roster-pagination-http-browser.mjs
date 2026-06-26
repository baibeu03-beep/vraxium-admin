// 검증 — /admin/members 서버 페이지네이션 HTTP==direct + 브라우저(속도·페이지·검색·필터·품계정렬).
//   사전조건: admin :3000. node scripts/verify-roster-pagination-http-browser.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const { chromium } = createRequire(resolve(adminRoot, "..", "vraxium", "package.json"))("playwright");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE), brow = createClient(URL_, ANON);
const EMAIL = "vanuatu.golden@gmail.com";
let fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const hr = () => console.log("─".repeat(72));

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = [];
const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1700, height: 1100 } });
await context.addCookies(cookies);
const page = await context.newPage();

hr(); console.log("▶ HTTP page 1 (cold→warm 응답시간)");
const warm0 = Date.now();
await page.request.get(`${BASE}/api/admin/members/roster?mode=operating&page=1&pageSize=50`); // 1차(콜드 컴파일 포함)
const coldMs = Date.now() - warm0;
const t0 = Date.now();
const res = await page.request.get(`${BASE}/api/admin/members/roster?mode=operating&page=1&pageSize=50`); // 2차(warm)
const ms = Date.now() - t0;
const j = await res.json();
const d = j.data ?? {};
console.log(`  members=${d.members?.length} total=${d.total} filteredTotal=${d.filteredTotal} counts=${JSON.stringify(d.statusCounts)} (cold ${coldMs}ms · warm ${ms}ms)`);
ck("HTTP 200", res.status() === 200 && j.success);
ck("page1 members 50", (d.members?.length ?? 0) === 50);
ck("total 318", d.total === 318);
ck("counts active201/rest51/stopped66", d.statusCounts?.active === 201 && d.statusCounts?.rest === 51 && d.statusCounts?.stopped === 66, JSON.stringify(d.statusCounts));
ck("warm 응답시간 < 3.5s(품계 풀스캔 제거·페이지당 50행)", ms < 3500, `warm ${ms}ms`);
ck("품계(캐시) 응답에 포함", (d.members ?? []).some((m) => m.rankGradeNumber != null));

hr(); console.log("▶ HTTP 필터/정렬");
const restRes = await (await page.request.get(`${BASE}/api/admin/members/roster?mode=operating&page=1&pageSize=50&filter=seasonal_rest`)).json();
ck("filter=seasonal_rest filteredTotal 51", restRes.data?.filteredTotal === 51, `${restRes.data?.filteredTotal}`);
const sortRes = await (await page.request.get(`${BASE}/api/admin/members/roster?mode=operating&page=1&pageSize=50&sort=poA:desc`)).json();
const poa = (sortRes.data?.members ?? []).map((m) => m.poA);
ck("sort=poA:desc 내림차순", poa.every((x, i) => i === 0 || poa[i - 1] >= x));

hr(); console.log("▶ 브라우저 /admin/members 첫 로드(실데이터) + 페이지/검색/필터");
const tb = Date.now();
await page.goto(`${BASE}/admin/members`, { waitUntil: "domcontentloaded" });
// 실데이터 도착 대기 — "전체 318" 카운트가 렌더될 때까지(스켈레톤 8행 오인 방지).
await page.waitForFunction(() => document.body.innerText.includes("전체") && /전체\s*318/.test(document.body.innerText), { timeout: 40000 }).catch(() => {});
const loadMs = Date.now() - tb;
await page.waitForTimeout(400);
const rowCount = await page.evaluate(() => document.querySelectorAll("table tbody tr").length);
console.log(`  실데이터 로드 ${loadMs}ms · 표 행수=${rowCount}`);
ck("첫 페이지 행수 = 50 (페이지네이션)", rowCount === 50, `${rowCount}`);
const bodyText = await page.evaluate(() => document.body.innerText);
ck("전체 318 카운트 표시", /전체\s*318/.test(bodyText));
ck("상태 카운트(활동201/휴식51/중단66) 표시", bodyText.includes("201") && bodyText.includes("51") && bodyText.includes("66"));
// 다음 페이지
const nextBtn = page.getByRole("button", { name: "다음" }).first();
const firstRowBefore = await page.evaluate(() => document.querySelector("table tbody tr")?.textContent ?? "");
await nextBtn.click();
// 페이지2 fetch 완료 대기(warm ~2.8s) — 첫 행이 실제로 바뀔 때까지 폴링.
await page.waitForFunction(
  (prev) => { const t = document.querySelector("table tbody tr")?.textContent ?? ""; return t.length > 0 && t !== prev; },
  firstRowBefore, { timeout: 15000 },
).catch(() => {});
const firstRowAfter = await page.evaluate(() => document.querySelector("table tbody tr")?.textContent ?? "");
// 기본 필터=클러빙_확대(활동+휴식, 중단 제외) → 252명/6페이지. 페이지 표시는 "2 / N".
const pg2 = await page.evaluate(() => Array.from(document.querySelectorAll("span")).some((s) => /^\s*2\s*\/\s*\d+\s*$/.test(s.textContent ?? "")));
ck("다음 페이지 이동 — 첫 행 변경", firstRowBefore !== firstRowAfter && firstRowAfter.length > 0);
ck("페이지 표시 2 / N", pg2);

// 상태 필터 — "활동 중단"(suspended) 선택 → 확인 → 66명.
const filterSelect = page.locator("select").filter({ has: page.locator('option', { hasText: "활동 중단" }) }).first();
await filterSelect.selectOption({ label: "활동 중단" });
await page.getByRole("button", { name: "확인" }).first().click();
// 필터 fetch 완료까지 — 결과 카운트가 66(=중단 인원)으로 바뀔 때까지 폴링(always-true 조건 금지).
await page.waitForFunction(() => /결과\s*값\s*66\b/.test(document.body.innerText.replace(/\s+/g, " ")) || /\b1\s*\/\s*2\b/.test(document.body.innerText), { timeout: 15000 }).catch(() => {});
const afterFilterText = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
const filteredRows = await page.evaluate(() => document.querySelectorAll("table tbody tr").length);
ck("활동 중단 필터 — 결과 66명(페이지 1/2·행수 50)", /결과 값 66\b/.test(afterFilterText) && filteredRows === 50, `결과값매치=${/결과 값 66\b/.test(afterFilterText)} 행수=${filteredRows}`);
await page.screenshot({ path: "claudedocs/roster-pagination.png" });

await browser.close();
hr();
console.log(fail === 0 ? "✅ roster 페이지네이션 HTTP+BROWSER PASS" : `❌ ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);

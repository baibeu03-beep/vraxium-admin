// 검증 — practical-competency [라인 관리] 탭: 레거시 3섹션(라인 등록/라인 개설/카페 링크 집계) 숨김 +
//   관련 API 호출 중단 + 유지 영역(주차 드롭다운·6집계카드·크루별 결과표) 정상.
//   practical-info/experience 회귀(페이지 정상 렌더) 라이트 체크. 읽기 전용·net-zero.
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
const URL = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const EMAIL = "vanuatu.golden@gmail.com";
const sb = createClient(URL, SERVICE), brow = createClient(URL, ANON);
const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = []; const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
let pass = 0, fail = 0; const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 2400 } });
await context.addCookies(cookies);
const page = await context.newPage();
const apiCalls = [];
page.on("request", (r) => { const u = r.url(); if (u.includes("/api/")) apiCalls.push(u); });

try {
  await page.goto(`${BASE}/admin/line-opening/practical-competency?org=oranke`, { waitUntil: "domcontentloaded" });
  // 유지 영역(결과표) 로드 대기 = 보드 정상.
  await page.waitForFunction("document.body.innerText.includes('크루별 라인 개설 결과')", undefined, { timeout: 30000 });
  await page.waitForTimeout(1500); // 잔여 백그라운드 fetch 있으면 잡히도록 여유.
  const body = await page.evaluate("document.body.innerText");

  // 1) 유지 영역 — 주차 드롭다운 + 6 집계 카드 + 크루별 결과표
  ck("[유지] 주차 선택 드롭다운", await page.evaluate(() => !!document.querySelector('button[aria-label="주차 선택"]')));
  ck("[유지] 6 집계 카드(활동/신청/개설/반려/신청라인/개설라인)",
    ["활동 크루", "신청 크루", "개설 크루", "반려 크루", "신청 라인", "개설 라인"].every((t) => body.includes(t)));
  ck("[유지] 크루별 라인 개설 결과표", body.includes("크루별 라인 개설 결과"));

  // 2) 숨김 — 레거시 3섹션 고유 마커 부재
  ck("[숨김] '라인 개설 대상 주차'(라인 개설 섹션) 미표시", !body.includes("라인 개설 대상 주차"));
  ck("[숨김] '개설된 실무 역량 라인'(라인 개설 테이블) 미표시", !body.includes("개설된 실무 역량 라인"));
  ck("[숨김] 라인 등록(통합 등록 read-mirror 배너) 미표시", !body.includes("통합 등록(line_registrations)"));
  ck("[숨김] '카페 댓글 닉네임 수집'(카페 링크 집계) 미표시", !body.includes("카페 댓글 닉네임 수집"));
  // 내부 탭바 버튼(라인 등록/카페 링크 집계) 부재
  const hasLegacyTabBtns = await page.evaluate(() =>
    [...document.querySelectorAll("button")].some((b) => {
      const t = (b.textContent || "").trim();
      return t === "카페 링크 집계" || t === "라인 등록";
    }),
  );
  ck("[숨김] 레거시 내부 탭 버튼(라인 등록/카페 링크 집계) 부재", !hasLegacyTabBtns);

  // 3) 데이터 호출 중단 — 레거시 섹션 전용 엔드포인트 미호출
  const forbidden = [
    "/api/admin/cluster4/competency-line-masters",
    "/api/admin/cluster4/teams",
    "/api/admin/cluster4/admin-org",
    "/api/admin/cluster4/current-week",
    "/api/admin/cluster4/lines?",
    "/api/admin/cluster4/crews",
    "/api/admin/cluster4/cafe-comments",
    "weeks-options?limit=3",
  ];
  for (const f of forbidden) {
    ck(`[호출중단] ${f} 미호출`, !apiCalls.some((u) => u.includes(f)));
  }
  // 보드 유지 호출은 존재(applications)
  ck("[유지호출] competency/applications 호출됨(보드 집계/결과)", apiCalls.some((u) => u.includes("/competency/applications")));

  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-competency-manage-hide-legacy.png"), fullPage: true });

  // 4) 회귀 — practical-info / practical-experience 정상 렌더(크래시 없음)
  for (const hub of ["practical-info", "practical-experience"]) {
    apiCalls.length = 0;
    const resp = await page.goto(`${BASE}/admin/line-opening/${hub}?org=oranke`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);
    const b2 = await page.evaluate("document.body.innerText");
    const ok = (resp?.status() ?? 0) < 400 && !/Application error|Unhandled Runtime|500 -/.test(b2) && b2.trim().length > 30;
    ck(`[회귀] ${hub} 정상 렌더(크래시 없음)`, ok, `status=${resp?.status()}`);
  }
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
  try { await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-competency-manage-hide-legacy-error.png"), fullPage: true }); } catch {}
} finally {
  await browser.close();
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

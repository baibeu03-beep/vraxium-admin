// 검증(브라우저) — /admin/crews 가 /admin/members UI 를 org 로 고정해 재사용하는지.
//   1) /admin/crews?org={slug}&mode=test 진입 → path(/admin/crews/{slug}?mode=test)로 정규화
//   2) "크루 목록" 탭에 "클럽" 드롭다운 부재 · 표 렌더 · roster API 가 organization={slug}&mode=test 로 호출
//   3) "크루 관리" 탭(?tab=manage) → 기존 CrewManager 관리 UI(바로가기/크루 추가 등) 렌더
//   4) mode=test 가 탭/URL 이동 후에도 유지
//   5) 회귀: /admin/members?mode=test 는 여전히 "클럽" 드롭다운 노출(영향 없음)
//   사전조건: admin dev :3000. Usage: node scripts/browser-verify-crews-org-scope.mjs
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

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
await context.addCookies(cookies);
const page = await context.newPage();

const rosterCalls = [];
const infoStatsCalls = [];
page.on("response", (res) => {
  const u = res.url();
  if (u.includes("/api/admin/members/roster")) rosterCalls.push({ url: u, status: res.status() });
  if (u.includes("/api/admin/members/info-stats")) infoStatsCalls.push({ url: u, status: res.status() });
});

const CLUB_LABELS = { encre: "엥크레", oranke: "오랑캐", phalanx: "팔랑크스" };
const ALL_CLUB_TAB_LABELS = ["통합", "엥크레", "오랑캐", "팔랑크스"];
// 클럽 하위 탭 바의 버튼 텍스트만 추출(헤더 탭은 "크루 목록/크루 관리"라 겹치지 않음).
const clubTabLabels = () =>
  page.evaluate((known) => {
    const set = new Set(known);
    return Array.from(document.querySelectorAll("button"))
      .map((b) => b.textContent?.trim() ?? "")
      .filter((t) => set.has(t));
  }, ALL_CLUB_TAB_LABELS);

const waitLoaded = async () => {
  await page
    .waitForFunction(
      () => {
        const t = document.body.innerText;
        return t.includes("크루 목록") && !t.includes("불러오는 중...");
      },
      { timeout: 25000 },
    )
    .catch(() => {});
  await page.waitForTimeout(700);
};

for (const org of ["encre", "oranke", "phalanx"]) {
  console.log(`▶ /admin/crews?org=${org}&mode=test`);
  rosterCalls.length = 0;
  // roster 응답은 슬림 조회 + 콜드 컴파일로 수 초 걸릴 수 있어, goto 전에 대기 promise 를 건다(레이스 방지).
  const rosterRespP = page
    .waitForResponse((r) => r.url().includes("/api/admin/members/roster"), { timeout: 30000 })
    .catch(() => null);
  await page.goto(`${BASE}/admin/crews?org=${org}&mode=test`, {
    waitUntil: "domcontentloaded",
  });
  await rosterRespP;
  await waitLoaded();

  const url = page.url();
  ck("path(/admin/crews/{org})로 정규화", new RegExp(`/admin/crews/${org}(\\?|$)`).test(url), url.replace(BASE, ""));
  ck("mode=test URL 유지", url.includes("mode=test"), url.replace(BASE, ""));

  // "클럽" 조건 라벨(드롭다운) 부재 — 조건 영역에서만. 표 헤더 "클럽명" 컬럼과 구분하기 위해
  //   조건 영역(role 없음)의 <label> 텍스트를 직접 확인한다.
  const hasClubDropdown = await page.evaluate(() =>
    Array.from(document.querySelectorAll("label")).some(
      (l) => l.querySelector("select") && l.textContent?.trim().startsWith("클럽"),
    ),
  );
  ck('"클럽" 드롭다운 부재', !hasClubDropdown);

  const rowCount = await page.evaluate(() => document.querySelectorAll("table tbody tr").length);
  const body = await page.evaluate(() => document.body.innerText);
  ck("표 행 렌더(>0) 또는 빈결과 안내", rowCount > 0 || body.includes("조회된 크루가 없습니다"), `rows=${rowCount}`);

  const scoped = rosterCalls.filter((c) => c.url.includes(`organization=${org}`));
  ck(`roster API organization=${org} 스코프 호출`, scoped.length > 0, rosterCalls.map((c) => c.url.replace(BASE, "")).join(" | "));
  ck("roster API mode=test 스코프", rosterCalls.every((c) => c.url.includes("mode=test")) && rosterCalls.length > 0);
  ck("roster API 200", rosterCalls.length > 0 && rosterCalls.every((c) => c.status === 200));

  // "크루 관리" 탭 진입 → members 정보(집계) 뷰(역대 누적 / 주차별 데이터) 렌더 + org 스코프.
  infoStatsCalls.length = 0;
  const infoRespP = page
    .waitForResponse((r) => r.url().includes("/api/admin/members/info-stats"), { timeout: 30000 })
    .catch(() => null);
  await page.goto(`${BASE}/admin/crews/${org}?mode=test&tab=manage`, {
    waitUntil: "domcontentloaded",
  });
  await infoRespP;
  await page.waitForTimeout(600);
  const manageBody = await page.evaluate(() => document.body.innerText);
  ck("크루 관리 탭: 정보(집계) 뷰 렌더(역대 누적·주차별 데이터)", manageBody.includes("역대 누적") && manageBody.includes("주차별 데이터"));
  ck("크루 관리 탭: 구 CrewManager UI(바로가기/크루 추가) 부재", !manageBody.includes("바로가기") && !manageBody.includes("크루 추가"));

  const labels = await clubTabLabels();
  ck(`클럽 하위 탭 = 현재 org(${CLUB_LABELS[org]}) 하나만`, labels.length === 1 && labels[0] === CLUB_LABELS[org], `[${labels.join(",")}]`);
  const otherLabels = ALL_CLUB_TAB_LABELS.filter((l) => l !== CLUB_LABELS[org]);
  ck("다른 조직/통합 클럽 탭 미노출", otherLabels.every((l) => !labels.includes(l)));

  const infoScoped = infoStatsCalls.filter((c) => c.url.includes(`organization=${org}`));
  ck(`info-stats API organization=${org} 스코프 호출`, infoScoped.length > 0, infoStatsCalls.map((c) => c.url.replace(BASE, "")).join(" | "));
  ck("info-stats API mode=test 스코프·200", infoStatsCalls.length > 0 && infoStatsCalls.every((c) => c.url.includes("mode=test") && c.status === 200));
  ck("크루 관리 탭: mode=test URL 유지", page.url().includes("mode=test"));
}

// 회귀 — /admin/members 는 여전히 "클럽" 드롭다운 노출.
console.log("▶ 회귀 /admin/members?mode=test");
await page.goto(`${BASE}/admin/members?mode=test`, { waitUntil: "domcontentloaded" });
await waitLoaded();
const membersHasClub = await page.evaluate(() =>
  Array.from(document.querySelectorAll("label")).some(
    (l) => l.querySelector("select") && l.textContent?.trim().startsWith("클럽"),
  ),
);
ck('/admin/members "클럽" 드롭다운 유지(회귀 없음)', membersHasClub);

// 회귀 — /admin/members?tab=info(크루 정보 탭)은 여전히 통합 포함 4개 클럽 탭 노출.
console.log("▶ 회귀 /admin/members?mode=test&tab=info");
const infoRegP = page
  .waitForResponse((r) => r.url().includes("/api/admin/members/info-stats"), { timeout: 30000 })
  .catch(() => null);
await page.goto(`${BASE}/admin/members?mode=test&tab=info`, { waitUntil: "domcontentloaded" });
await infoRegP;
await page.waitForTimeout(600);
const memberInfoLabels = await clubTabLabels();
ck(
  "/admin/members 정보 탭 4개 클럽 탭 유지(회귀 없음)",
  ALL_CLUB_TAB_LABELS.every((l) => memberInfoLabels.includes(l)),
  `[${memberInfoLabels.join(",")}]`,
);

await browser.close();
console.log("─".repeat(50));
console.log(fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);

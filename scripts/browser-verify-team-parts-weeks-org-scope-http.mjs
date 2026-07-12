// 검증(HTTP+DOM, 실행 중 dev 서버) — 클럽 진행/주차 내역 통합/개별 컨텍스트.
//   통합/개별 SoT = URL 의 유효한 ?org 유무(org-optional 정책). 현 어드민 전원 owner 라 owner 세션으로
//   ?org 유무를 바꿔 통합/개별을 재현한다(개별=owner@?org). 추가로 !isAllOrgs 분기 확인을 위해
//   임시 단일조직(encre) 어드민 1명을 프로비저닝하고 finally 에서 전량 삭제한다.
//
//   핵심 회귀 포인트:
//     · 개별 목록 = 자기 org 탭 1개만(타조직 탭 DOM 부재)
//     · 개별에서 [활동 관리] 클릭 → ?org 보존(통합 전환 X) → 사이드바 MENU_ORG('클럽 진행') 유지
//     · 개별 상세 = 검수 버튼 disabled+툴팁 · 허브라인 체크박스 disabled · 안내 문구
//     · 통합 = 전체 탭 · 편집 가능(회귀 없음)
//     · 서버: 개별(?org) 쓰기 403 · 통합(?org 없음) 쓰기 게이트 통과(400/422) · 단일조직 어드민 403
//   ⚠ 실데이터 무변경: 쓰기는 게이트 통과 후 400/403 로만 확인(실제 확정/저장 없음).
//
//   사전조건: admin dev :3000. Usage: node scripts/browser-verify-team-parts-weeks-org-scope-http.mjs
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
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE);
const brow = createClient(URL_, ANON);
const OWNER_EMAIL = "vanuatu.golden@gmail.com"; // owner(전체 허용) — ?org 로 통합/개별 재현
const TEMP_EMAIL = "zz-temp-org-admin-verify@example.com"; // 임시 단일조직(encre) 어드민

let fail = 0;
const ck = (l, ok, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};

// 미래·미검수 주차(통합 상세에서 검수 버튼이 disabled 아닌 상태로 렌더되도록).
const { data: wk } = await sb
  .from("weeks")
  .select("id")
  .order("start_date", { ascending: false })
  .limit(1)
  .maybeSingle();
const WEEK_ID = wk?.id;
if (!WEEK_ID) {
  console.error("weeks 표본 없음");
  process.exit(1);
}
const BOGUS_WEEK = "not-a-uuid";

async function cookiesFor(email) {
  const { data: link, error } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw new Error(`generateLink(${email}): ${error.message}`);
  const { data: v, error: e2 } = await brow.auth.verifyOtp({
    email,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  if (e2) throw new Error(`verifyOtp(${email}): ${e2.message}`);
  const cap = [];
  const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => ({
    name: i.name,
    value: i.value,
    domain: "localhost",
    path: "/",
    httpOnly: false,
    secure: false,
    sameSite: "Lax",
  }));
}

let tempUserId = null;
let insertedUsersRow = false;
let insertedAdminRow = false;
let insertedProfileRow = false;
const browser = await chromium.launch({ channel: "chromium", headless: true });

const status = async (ctx, method, path) => {
  const r = await ctx.request[method.toLowerCase()](`${BASE}${path}`, { failOnStatusCode: false });
  return r.status();
};

try {
  const ownerCookies = await cookiesFor(OWNER_EMAIL);

  // ══ HTTP — owner: 통합(?org 없음) 통과 · 개별(?org) 403 ══
  console.log("▶ HTTP — owner (통합 vs 개별 by ?org)");
  const ownerApi = await browser.newContext();
  await ownerApi.addCookies(ownerCookies);
  for (const org of ["encre", "oranke", "phalanx"]) {
    ck(`통합 GET 목록 ?club=${org} → 200`, (await status(ownerApi, "GET", `/api/admin/team-parts/info/weeks?club=${org}`)) === 200);
  }
  // 통합 쓰기(=?org 없음): 게이트 통과 → 뒤 단계 400(실데이터 무변경).
  ck("통합 POST 검수(?club, 비-uuid) → 400(게이트 통과)", (await status(ownerApi, "POST", `/api/admin/team-parts/info/weeks/${BOGUS_WEEK}/review?club=encre`)) === 400);
  ck("통합 POST 오픈확인(?club, 무효 club) → 400(게이트 통과)", (await status(ownerApi, "POST", `/api/admin/team-parts/info/weeks/${WEEK_ID}/open-confirm?club=zzz`)) === 400);
  // 개별 쓰기(=?org 부착): 403.
  ck("개별 POST 검수 ?org=encre → 403", (await status(ownerApi, "POST", `/api/admin/team-parts/info/weeks/${WEEK_ID}/review?org=encre`)) === 403);
  ck("개별 POST 검수 ?org=encre&mode=test → 403", (await status(ownerApi, "POST", `/api/admin/team-parts/info/weeks/${WEEK_ID}/review?org=encre&mode=test`)) === 403);
  ck("개별 POST 오픈확인 ?org=encre&club=encre → 403", (await status(ownerApi, "POST", `/api/admin/team-parts/info/weeks/${WEEK_ID}/open-confirm?org=encre&club=encre`)) === 403);
  await ownerApi.close();

  // ══ HTTP — 단일조직(encre) 어드민(!isAllOrgs 분기) ══
  console.log("\n▶ HTTP — 단일조직 encre 어드민(프로비저닝, !isAllOrgs)");
  {
    const { data: existing } = await sb.auth.admin.listUsers();
    const staleU = existing?.users?.find((u) => u.email === TEMP_EMAIL);
    if (staleU) {
      await sb.from("admin_users").delete().eq("id", staleU.id);
      await sb.from("user_profiles").delete().eq("user_id", staleU.id);
      await sb.from("users").delete().eq("id", staleU.id);
      await sb.auth.admin.deleteUser(staleU.id);
    }
    const { data: created, error: cErr } = await sb.auth.admin.createUser({ email: TEMP_EMAIL, email_confirm: true });
    if (cErr) throw new Error(`createUser: ${cErr.message}`);
    tempUserId = created.user.id;
    // user_profiles.user_id → public.users(id) FK 루트. source_system 은 CHECK 제약 → null(테스트유저와 동일).
    const { error: uRowErr } = await sb.from("users").insert({ id: tempUserId, source_system: null, legacy_user_id: 9900000 + (Date.now() % 90000) });
    if (uRowErr) throw new Error(`users insert: ${uRowErr.message}`);
    insertedUsersRow = true;
    const { error: pErr } = await sb.from("user_profiles").insert({ user_id: tempUserId, organization_slug: "encre", display_name: "ZZ 임시 개별검증" });
    if (pErr) throw new Error(`user_profiles insert: ${pErr.message}`);
    insertedProfileRow = true;
    const { error: aErr } = await sb.from("admin_users").insert({ id: tempUserId, email: TEMP_EMAIL, role: "admin", is_active: true });
    if (aErr) throw new Error(`admin_users insert: ${aErr.message}`);
    insertedAdminRow = true;

    const indivApi = await browser.newContext();
    await indivApi.addCookies(await cookiesFor(TEMP_EMAIL));
    ck("GET 목록 ?club=encre → 200", (await status(indivApi, "GET", `/api/admin/team-parts/info/weeks?club=encre`)) === 200);
    ck("GET 목록 ?club=oranke → 403(타조직)", (await status(indivApi, "GET", `/api/admin/team-parts/info/weeks?club=oranke`)) === 403);
    ck("POST 검수 ?club=encre(?org 없음) → 403(!isAllOrgs)", (await status(indivApi, "POST", `/api/admin/team-parts/info/weeks/${WEEK_ID}/review?club=encre`)) === 403);
    ck("POST 오픈확인 ?club=encre(?org 없음) → 403(!isAllOrgs)", (await status(indivApi, "POST", `/api/admin/team-parts/info/weeks/${WEEK_ID}/open-confirm?club=encre`)) === 403);
    await indivApi.close();
  }

  // ══ DOM — owner 개별(?org=encre) ══
  console.log("\n▶ DOM — 개별(owner @ ?org=encre)");
  {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    await ctx.addCookies(ownerCookies);
    const page = await ctx.newPage();
    page.on("dialog", (d) => d.dismiss().catch(() => {}));
    await page.goto(`${BASE}/admin/team-parts/info/weeks?org=encre`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-club-tab]', { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(800);
    ck("목록: encre 탭 1개만", (await page.locator('[data-club-tab]').count()) === 1 && (await page.locator('[data-club-tab="encre"]').count()) === 1);
    ck("목록: 통합/타조직 탭 DOM 부재", (await page.locator('[data-club-tab="integrated"], [data-club-tab="oranke"], [data-club-tab="phalanx"]').count()) === 0);
    const asideTextI = await page.locator("aside").innerText().catch(() => "");
    ck("사이드바: MENU_ORG('클럽 진행') 노출", asideTextI.includes("클럽 진행"));

    // [활동 관리] 클릭 → ?org 보존(통합 전환 X). 공식휴식 행은 alert(이동X) → nav 될 때까지 시도.
    const btns = page.locator('[data-manage-activity]');
    const n = await btns.count();
    let navigated = false;
    for (let i = 0; i < Math.min(n, 8); i++) {
      const before = page.url();
      await btns.nth(i).click().catch(() => {});
      await page.waitForTimeout(600);
      if (page.url() !== before && /\/weeks\/[0-9a-f-]{36}/i.test(page.url())) { navigated = true; break; }
    }
    ck("[활동 관리] 클릭 → 상세 이동", navigated, page.url());
    ck("[활동 관리] 후 ?org=encre 보존(통합 전환 아님)", /[?&]org=encre\b/.test(page.url()), page.url());
    const asideDetailI = await page.locator("aside").innerText().catch(() => "");
    ck("상세 사이드바: MENU_ORG('클럽 진행') 유지(개별 유지)", asideDetailI.includes("클럽 진행"));
    await page.waitForSelector("[data-review-button]", { timeout: 90000 }).catch(() => {});
    await page.waitForTimeout(600);
    const rb = page.locator("[data-review-button]");
    ck("상세: 검수 버튼 disabled", await rb.first().isDisabled().catch(() => false));
    ck("상세: 검수 버튼 툴팁(통합 전용)", (await rb.first().getAttribute("title").catch(() => "")) === "주차 검수는 통합 관리자만 실행할 수 있습니다.");
    ck("상세: 허브·라인 조회전용 안내", (await page.locator("[data-hub-line-readonly-notice]").count()) >= 1);
    const cbs = page.locator('input[type="checkbox"]');
    const cbn = await cbs.count();
    let allDisabled = cbn > 0;
    for (let i = 0; i < cbn; i++) if (!(await cbs.nth(i).isDisabled())) allDisabled = false;
    ck(`상세: 체크박스 전부 disabled(${cbn}개)`, allDisabled);
    await page.screenshot({ path: "claudedocs/qa-team-parts-weeks-individual-readonly.png" }).catch(() => {});
    await ctx.close();
  }

  // ══ DOM — owner 통합(?org 없음) — 회귀 ══
  console.log("\n▶ DOM — 통합(owner, ?org 없음) 회귀");
  {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    await ctx.addCookies(ownerCookies);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/admin/team-parts/info/weeks`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-club-tab]', { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(800);
    for (const t of ["integrated", "encre", "oranke", "phalanx"]) {
      ck(`목록: '${t}' 탭 노출(통합)`, (await page.locator(`[data-club-tab="${t}"]`).count()) >= 1);
    }
    const asideText = await page.locator("aside").innerText().catch(() => "");
    ck("사이드바: MENU_INTEGRATED(‘클럽 진행’ 미노출)", !asideText.includes("클럽 진행"));
    await page.goto(`${BASE}/admin/team-parts/info/weeks/${WEEK_ID}?club=encre`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-review-button]", { timeout: 90000 }).catch(() => {});
    await page.waitForTimeout(600);
    const rb = page.locator("[data-review-button]");
    ck("상세: 조회전용 안내 부재(편집 가능)", (await page.locator("[data-hub-line-readonly-notice]").count()) === 0);
    ck("상세: 검수 버튼 툴팁 없음", !(await rb.first().getAttribute("title").catch(() => null)));
    ck("상세: 검수 버튼 활성(disabled 아님)", !(await rb.first().isDisabled().catch(() => true)));
    await ctx.close();
  }

  // ══ 미인증 ══
  console.log("\n▶ 미인증");
  const anonCtx = await browser.newContext();
  ck("POST 검수(미인증) → 401", (await status(anonCtx, "POST", `/api/admin/team-parts/info/weeks/${WEEK_ID}/review?club=encre`)) === 401);
  ck("POST 오픈확인(미인증) → 401", (await status(anonCtx, "POST", `/api/admin/team-parts/info/weeks/${WEEK_ID}/open-confirm?club=encre`)) === 401);
  await anonCtx.close();
} finally {
  await browser.close();
  console.log("\n▶ 클린업(임시 어드민 삭제)");
  if (tempUserId) {
    if (insertedAdminRow) await sb.from("admin_users").delete().eq("id", tempUserId);
    if (insertedProfileRow) await sb.from("user_profiles").delete().eq("user_id", tempUserId);
    if (insertedUsersRow) await sb.from("users").delete().eq("id", tempUserId);
    await sb.auth.admin.deleteUser(tempUserId).catch(() => {});
    const { data: a } = await sb.from("admin_users").select("id").eq("id", tempUserId).maybeSingle();
    const { data: p } = await sb.from("user_profiles").select("user_id").eq("user_id", tempUserId).maybeSingle();
    const { data: u } = await sb.from("users").select("id").eq("id", tempUserId).maybeSingle();
    console.log(`  임시 잔여 — admin_users:${a ? "있음(!)" : "없음"} · user_profiles:${p ? "있음(!)" : "없음"} · users:${u ? "있음(!)" : "없음"}`);
  }
}

console.log(`\n${fail === 0 ? "✅ PASS" : `❌ FAIL (${fail})`}`);
process.exit(fail === 0 ? 0 : 1);

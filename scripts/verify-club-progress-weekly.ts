/**
 * 클럽 진행 > 주차 내역/상세 (개별 조직 · 조회 전용) 검증.
 *   신규 라우트: /admin/club-progress/weekly?org=..  ·  /admin/club-progress/weekly/[weekId]?org=..
 *   기반: 통합 어드민 /admin/team-parts/info/weeks 화면 재사용(같은 API·DTO·snapshot 경로).
 *
 *   1) direct 함수(loadTeamPartsInfoWeeks / loadTeamPartsInfoWeekDetail) 결과
 *   2) HTTP API 응답(관리자 세션 쿠키) — 신규 페이지가 사용하는 club=<org> 경로
 *   3) direct == HTTP 동치
 *   4) 고객 weekly-card snapshot(cluster4_weekly_card_snapshots) 무변경(조회 전용)
 *   5) snapshot 재계산 필요 없음(write 경로 미접촉)
 *   6) 브라우저:
 *      - 3개 org 목록 페이지 = 자기 조직 탭만 고정 · 조회 전용 배지
 *      - 상세 페이지 = 검수 완료 / 오픈 확인 / 허브·라인 체크박스 모두 disabled + 상태 배지
 *      - 통합 어드민 상세는 체크박스 편집 가능(회귀 없음)
 *      - 통합에서 설정한 체크 상태가 개별(조회 전용)에 그대로 표시
 *
 *   선행: npm run dev (:3000)
 *   npx tsx --env-file=.env.local scripts/verify-club-progress-weekly.ts
 */
import { pathToFileURL } from "url";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ORGANIZATIONS, type OrganizationSlug } from "@/lib/organizations";
import { loadTeamPartsInfoWeeks } from "@/lib/adminTeamPartsInfoWeeksData";
import { loadTeamPartsInfoWeekDetail } from "@/lib/adminTeamPartsInfoWeekDetailData";

const BASE = process.env.ADMIN_API_BASE_URL?.replace(/\/$/, "") || "http://localhost:3000";
const u = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const a = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const s = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`);
  if (!ok) failed++;
}

async function adminSession() {
  const { data: adm } = await supabaseAdmin
    .from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = (adm?.[0] as { email: string } | undefined)?.email;
  if (!email) throw new Error("활성 관리자 없음");
  const A = createClient(u, s), N = createClient(u, a);
  const { data: l } = await A.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await N.auth.verifyOtp({ email, token: (l as any).properties.email_otp, type: "magiclink" });
  const cap: { name: string; value: string }[] = [];
  const sv = createServerClient(u, a, {
    cookies: { getAll: () => [], setAll: (items) => cap.push(...items.map(({ name, value }: any) => ({ name, value }))) },
  });
  await sv.auth.setSession({
    access_token: (v as any).session.access_token,
    refresh_token: (v as any).session.refresh_token,
  });
  return {
    cookieHeader: cap.map((c) => `${c.name}=${c.value}`).join("; "),
    cookies: cap.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" })),
  };
}

async function snapshotFingerprint() {
  const { count } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true });
  const { data } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots").select("updated_at")
    .order("updated_at", { ascending: false }).limit(1);
  return { count: count ?? 0, latest: (data?.[0] as { updated_at: string } | undefined)?.updated_at ?? null };
}

async function main() {
  try {
    const h = await fetch(`${BASE}/api/health`);
    check("dev server 응답", h.ok, { base: BASE });
  } catch {
    console.log(`❌ dev server 미기동(${BASE}). npm run dev 후 재실행.`);
    process.exit(2);
  }

  const { cookieHeader: cookie, cookies } = await adminSession();
  const snapBefore = await snapshotFingerprint();

  // 상세 검증에 쓸 org별 weekId(가능하면 공식 활동 주차).
  const detailWeekByOrg: Partial<Record<OrganizationSlug, string>> = {};

  // ── 1~3) 목록 direct == HTTP ────────────────────────────────
  for (const org of ORGANIZATIONS) {
    const direct = await loadTeamPartsInfoWeeks({ organization: org, page: 1, pageSize: 20 });
    const res = await fetch(
      `${BASE}/api/admin/team-parts/info/weeks?club=${org}&page=1&pageSize=20`,
      { headers: { cookie }, cache: "no-store" },
    );
    const json: any = await res.json();
    check(`[목록/${org}] HTTP 200 · success`, res.ok && json?.success === true, { status: res.status });
    const http = json?.data;
    const dEq = JSON.stringify(direct) === JSON.stringify(http);
    check(`[목록/${org}] direct == HTTP`, dEq, dEq ? { items: direct.items.length } : {
      directItems: direct.items.length, httpItems: http?.items?.length,
    });

    const act = (direct.items as any[]).find((it) => it.clubActivityStatus === "official_activity");
    detailWeekByOrg[org] = (act ?? direct.items[0])?.weekId;
  }

  // ── 상세 direct == HTTP ────────────────────────────────────
  for (const org of ORGANIZATIONS) {
    const weekId = detailWeekByOrg[org];
    if (!weekId) { console.log(`⚠ [${org}] 상세 검증용 주차 없음 — 생략`); continue; }
    const direct = await loadTeamPartsInfoWeekDetail({ weekId, organization: org, mode: "test" });
    const res = await fetch(
      `${BASE}/api/admin/team-parts/info/weeks/${weekId}?club=${org}&mode=test`,
      { headers: { cookie }, cache: "no-store" },
    );
    const json: any = await res.json();
    check(`[상세/${org}] HTTP 200 · success`, res.ok && json?.success === true, { status: res.status });
    const dEq = JSON.stringify(direct) === JSON.stringify(json?.data);
    check(`[상세/${org}] direct == HTTP`, dEq, dEq ? { weekId } : { weekId });
  }

  // ── 4~5) snapshot 무변경 ───────────────────────────────────
  const snapAfter = await snapshotFingerprint();
  check("고객 weekly-card snapshot 무변경(count)", snapBefore.count === snapAfter.count, { before: snapBefore.count, after: snapAfter.count });
  check("고객 weekly-card snapshot 무변경(latest updated_at)", snapBefore.latest === snapAfter.latest, { before: snapBefore.latest, after: snapAfter.latest });

  // ── 6) 브라우저 ────────────────────────────────────────────
  const pw: any = await import(pathToFileURL(resolve("../vraxium/node_modules/playwright/index.js")).href);
  const chromium = pw.chromium ?? pw.default?.chromium;
  const ctx = await (await chromium.launch()).newContext({ viewport: { width: 1500, height: 2200 } });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();

  // 6a) 3개 org 목록 = 자기 조직 탭만 + 조회 전용 배지.
  for (const org of ORGANIZATIONS) {
    const resp = await page.goto(`${BASE}/admin/club-progress/weekly?org=${org}&mode=test`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(2500);
    const body = await page.evaluate(() => document.body.innerText);
    const crash = /Jest worker|Internal Server Error|Application error/i.test(body);
    check(`[브라우저/${org}] 목록 200 · 크래시 없음`, resp?.status() === 200 && !crash, { status: resp?.status() });

    const tabs = await page.$$eval("[data-club-tab]", (els: any[]) => els.map((e) => e.getAttribute("data-club-tab")));
    check(`[브라우저/${org}] 자기 조직 탭만 노출(통합 없음)`, tabs.length === 1 && tabs[0] === org, { tabs });

    const tabDisabled = await page.$eval(`[data-club-tab="${org}"]`, (e: any) => e.disabled).catch(() => null);
    check(`[브라우저/${org}] 탭 비활성(고정)`, tabDisabled === true, { tabDisabled });

    const badge = await page.$("[data-readonly-badge]");
    check(`[브라우저/${org}] "조회 전용" 배지 표시`, !!badge);

    const rows = await page.$$eval("[data-week-row]", (els: any[]) => els.length);
    check(`[브라우저/${org}] 주차 표 렌더(>0)`, rows > 0, { rows });
  }
  await page.screenshot({ path: "claudedocs/qa-club-progress-weekly-list.png", fullPage: true });

  // 6b) 상세(조회 전용) — 버튼/체크박스 모두 disabled + 상태 배지.
  const org0: OrganizationSlug = "encre";
  const wk = detailWeekByOrg[org0];
  if (wk) {
    await page.goto(`${BASE}/admin/club-progress/weekly/${wk}?org=${org0}&mode=test`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(3000);

    const reviewDisabled = await page.$eval("[data-review-button]", (e: any) => e.disabled).catch(() => null);
    check(`[상세 조회전용] 검수 완료 버튼 disabled`, reviewDisabled === true, { reviewDisabled });
    const openDisabled = await page.$eval("[data-open-confirm-button]", (e: any) => e.disabled).catch(() => null);
    check(`[상세 조회전용] 오픈 확인 버튼 disabled`, openDisabled === true, { openDisabled });

    const reviewedPill = await page.$eval("[data-reviewed]", (e: any) => e.textContent).catch(() => null);
    check(`[상세 조회전용] 검수 상태 배지 표시`, !!reviewedPill && (reviewedPill.includes("검수 완료") || reviewedPill.includes("검수 대기")), { reviewedPill: reviewedPill?.trim() });
    const openPill = await page.$eval("[data-open-confirmed]", (e: any) => e.textContent).catch(() => null);
    check(`[상세 조회전용] 오픈 확인 상태 배지 표시`, !!openPill && (openPill.includes("오픈 확인 완료") || openPill.includes("오픈 확인 전")), { openPill: openPill?.trim() });

    // 모든 허브/라인 체크박스 disabled.
    const cbStats = await page.evaluate(() => {
      const boxes = Array.from(document.querySelectorAll('section input[type="checkbox"]')) as HTMLInputElement[];
      return { total: boxes.length, enabled: boxes.filter((b) => !b.disabled).length };
    });
    check(`[상세 조회전용] 허브/라인 체크박스 전부 disabled`, cbStats.total > 0 && cbStats.enabled === 0, cbStats);

    // 통합에서 설정한 체크 상태가 그대로 보이는가 — DTO checked 와 화면 checked 대조(실무 역량).
    const detail = await loadTeamPartsInfoWeekDetail({ weekId: wk, organization: org0, mode: "test" });
    const compCheckedDom = await page.$eval("[data-competency-checkbox]", (e: any) => e.checked).catch(() => null);
    check(`[상세 조회전용] 통합 설정(실무 역량 checked)이 그대로 표시`, compCheckedDom === detail.openingConfig.practicalCompetency.checked, { dom: compCheckedDom, dto: detail.openingConfig.practicalCompetency.checked });

    await page.screenshot({ path: "claudedocs/qa-club-progress-weekly-detail.png", fullPage: true });
  } else {
    console.log("⚠ encre 상세 주차 없음 — 상세 브라우저 검증 생략");
  }

  // 6c) 통합 어드민 상세 회귀 — 체크박스 편집 가능(disabled 아님).
  if (wk) {
    await page.goto(`${BASE}/admin/team-parts/info/weeks/${wk}?club=${org0}&mode=test`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(3000);
    const compDisabled = await page.$eval("[data-competency-checkbox]", (e: any) => e.disabled).catch(() => null);
    check(`[통합 어드민 회귀] 체크박스 편집 가능(disabled=false)`, compDisabled === false, { compDisabled });
    const reviewedNow = await page.$("[data-review-button]");
    check(`[통합 어드민 회귀] 검수 버튼 존재`, !!reviewedNow);
  }

  await ctx.browser()?.close?.();
  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

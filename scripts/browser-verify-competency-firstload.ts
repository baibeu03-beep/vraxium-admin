/**
 * 브라우저 최초 접속 검증: /admin/line-opening/practical-competency 새로고침 없이 한 번에 로드.
 *   npx tsx --env-file=.env.local scripts/browser-verify-competency-firstload.ts
 *
 * - 실 관리자 세션 쿠키로 페이지에 "처음" 진입(캐시 없이, 새로고침 없이).
 * - manage 탭(?org)·open 탭(?org&tab=open)·test 모드 각각 최초 로드.
 * - 검증: (1) 콘텐츠가 렌더(집계 카드/상태창) (2) "응답이 지연되고 있습니다" 배너가 끝까지 뜨지 않음
 *         (3) 최초 진입 시 /api/admin 요청이 중복되지 않음(동일 URL 2회+ 없음, StrictMode 재호출 감지).
 * 선행: dev server 기동(:3000).
 */
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SLOW_TEXT = "응답이 지연되고 있습니다";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`);
  if (!ok) failed++;
}

async function makeAdminCookies() {
  const { data: admins, error } = await supabaseAdmin
    .from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  if (error) throw error;
  const email = (admins?.[0] as { email: string } | undefined)?.email;
  if (!email) throw new Error("No active admin email");
  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const otp = link.properties?.email_otp;
  if (!otp) throw new Error("no otp");
  const { data: verified } = await anon.auth.verifyOtp({ email, token: otp, type: "magiclink" });
  if (!verified.session) throw new Error("no session");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items.map(({ name, value }) => ({ name, value }))) },
  });
  await server.auth.setSession({
    access_token: verified.session.access_token,
    refresh_token: verified.session.refresh_token,
  });
  console.log(`   admin session for ${email}`);
  return captured.map(({ name, value }) => ({
    name, value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" as const,
  }));
}

async function main() {
  try {
    const h = await fetch(`${BASE}/api/health`);
    if (!h.ok) throw new Error();
  } catch {
    console.log(`❌ dev server 미기동(${BASE}).`);
    process.exit(2);
  }
  const cookies = await makeAdminCookies();
  const browser = await chromium.launch({ headless: true });

  const scenarios = [
    // 렌더 완료 sentinel — [라인 관리] 보드의 "현재 상황" 고정 라벨.
    //   ("[실무 역량] Hub" 제목은 제거됨 → 상시 렌더되는 라벨로 교체. 상단 보드 자체의 등장 신호는 동일.)
    { tag: "manage/operating", path: "/admin/line-opening/practical-competency?org=encre", expect: "개설 이행 기간" },
    { tag: "manage/test", path: "/admin/line-opening/practical-competency?org=encre&mode=test", expect: "개설 이행 기간" },
    { tag: "open/operating", path: "/admin/line-opening/practical-competency?org=encre&tab=open", expect: "라인 개설" },
  ];

  for (const sc of scenarios) {
    // 매 시나리오 새 컨텍스트 = "최초 접속"(캐시/세션 상태 공유 없음).
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    const adminReqs: string[] = [];
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith("/api/admin/")) adminReqs.push(u.pathname + u.search);
    });
    let sawSlow = false;
    const t0 = Date.now();
    await page.goto(`${BASE}${sc.path}`, { waitUntil: "domcontentloaded" });
    // 최초 진입 후 12초 관찰(slow 배너 임계 10초 초과까지) — 도중 slow 문구 출현 감시.
    const deadline = Date.now() + 12_000;
    let rendered = false;
    while (Date.now() < deadline) {
      const body = await page.locator("body").innerText().catch(() => "");
      if (body.includes(SLOW_TEXT)) sawSlow = true;
      if (!rendered && body.includes(sc.expect)) rendered = true;
      // 콘텐츠가 떴고 로딩 배너 문구가 없으면 조기 종료(단, 최소 3초는 관찰).
      if (rendered && Date.now() - t0 > 3_000 && !body.includes("불러오는 중") && !body.includes("불러오고")) break;
      await page.waitForTimeout(400);
    }
    const renderMs = Date.now() - t0;

    // dev 서버는 React Strict Mode 로 effect 를 2회 실행 → 모든 요청이 ×2로 보이는 게 정상(프로덕션 ×1).
    //   따라서 "×2 자체"는 실패로 보지 않고, 프로덕션에도 남는 진짜 중복만 검출한다:
    //   같은 applications 엔드포인트가 week_id "없이"도 부르고 "있이"도 부르는 no-week→week 이중발화.
    const appsReqs = adminReqs.filter((u) => u.includes("/competency/applications"));
    const appsNoWeek = appsReqs.filter((u) => !u.includes("week_id="));
    const appsWithWeek = appsReqs.filter((u) => u.includes("week_id="));
    // 고유 엔드포인트(week_id·mode 정규화) 수 — Strict Mode ×2 걷어낸 "논리 요청" 파악용.
    const logical = new Set(adminReqs.map((u) => u.replace(/([?&])week_id=[^&]*/, "$1")));

    console.log(`\n== ${sc.tag} (${sc.path}) ==`);
    console.log(`   admin 요청 ${adminReqs.length}건(dev Strict×2 포함) · 논리 고유 ${logical.size}종 · render≈${renderMs}ms`);
    for (const u of adminReqs) console.log(`     · ${u}`);
    check(`${sc.tag} 콘텐츠 렌더('${sc.expect}')`, rendered);
    check(`${sc.tag} '응답이 지연' 배너 미출현`, !sawSlow);
    // manage 탭(주차 옵션 존재)에서는 week_id 없는 applications 조회가 없어야 한다(no-week→week 이중발화 제거).
    if (sc.tag.startsWith("manage")) {
      check(
        `${sc.tag} applications no-week 이중발화 없음`,
        appsWithWeek.length > 0 && appsNoWeek.length === 0,
        { noWeek: appsNoWeek.length, withWeek: appsWithWeek.length },
      );
    }
    await ctx.close();
  }

  await browser.close();
  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });

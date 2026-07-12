/**
 * 등록 관리 기능 브라우저 E2E — /admin/lines/info 수정 모달.
 *   npx tsx --env-file=.env.local scripts/verify-registration-manage-browser.ts
 * 테스트 등록 생성 → 모달 수정/저장 → DB 확인 → 잠금 라벨([통합] 행) 확인 → 정리.
 */
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { createLineRegistration } from "@/lib/adminLineRegistrationsData";
import { bridgeLineRegistration } from "@/lib/adminLineBridgeData";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

function ensureEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}
const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
const serviceKey = ensureEnv("SUPABASE_SERVICE_ROLE_KEY");
const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (ok) pass++;
  else fail++;
}

async function main() {
  const stamp = Date.now();
  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: l, error: le } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  if (le || !l?.properties?.email_otp) throw new Error(le?.message ?? "generateLink failed");
  const { data: v, error: ve } = await anon.auth.verifyOtp({ email: adminEmail, token: l.properties.email_otp, type: "magiclink" });
  if (ve || !v.session) throw new Error(ve?.message ?? "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items.map((i) => ({ name: i.name, value: i.value }))) },
  });
  await server.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });

  const { data: adminRow } = await sb.from("admin_users").select("id").eq("email", adminEmail).maybeSingle();
  const actor = (adminRow as { id: string }).id;
  const reg = await createLineRegistration(
    {
      lineName: `MNGB 브라우저 ${stamp}`, hub: "competency", lineType: "관점",
      lineCode: `CPMB-${stamp}`, mainTitleMode: "fixed", mainTitle: "브라우저 원본 타이틀",
      unitLink: "-", organizationSlug: "oranke",
      partnerCompany: null, companyLogoUrl: null, managerName: null,
      managerPosition: null, managerJob: null, managerProfileKey: null,
    },
    actor,
  );
  const bridge = await bridgeLineRegistration(reg.id);

  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1680, height: 1050 } });
    await ctx.addCookies(captured.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" })));
    const page = await ctx.newPage();

    console.log("=== A) 수정 모달 — 일반 수정 + 저장 ===");
    await page.goto(`${baseUrl}/admin/lines/info`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=통합 라인 목록", { timeout: 15000 });
    const row = page.locator("tbody tr", { hasText: `CPMB-${stamp}` });
    check("등록 행 + 수정 버튼 노출", (await row.getByRole("button", { name: "수정" }).count()) === 1);
    await row.getByRole("button", { name: "수정" }).click();
    await page.waitForSelector("text=등록 수정", { timeout: 10000 });
    // 상세는 모달 오픈 후 비동기 로드 — 폼 렌더 완료까지 대기.
    await page.waitForSelector("text=소속 허브 (수정 불가)", { timeout: 10000 });
    check("모달 로드 — 허브 read-only 표기", await page.getByText("소속 허브 (수정 불가)").isVisible());
    // 수정: 라인명 + 라인 종류 + 비활성
    const nameInput = page.locator('div[role="dialog"] input').first();
    await nameInput.fill(`MNGB 수정됨 ${stamp}`);
    await page.getByLabel("라인 종류 수정").selectOption("자원");
    await page.getByLabel("활성 여부").uncheck();
    await page.screenshot({ path: "claudedocs/browser-registration-manage-modal.png", fullPage: true });
    await page.getByRole("button", { name: "저장" }).click();
    await page.waitForSelector("text=등록이 수정되었습니다", { timeout: 15000 });
    check("저장 성공 배너 (+mirror 동기화 문구)", await page.getByText("mirror 마스터에 동기화됨").isVisible());

    const { data: regAfter } = await sb
      .from("line_registrations")
      .select("line_name,line_type,is_active")
      .eq("id", reg.id)
      .maybeSingle();
    check(
      "DB 반영 (라인명/종류/비활성)",
      regAfter?.line_name === `MNGB 수정됨 ${stamp}` && regAfter?.line_type === "자원" && regAfter?.is_active === false,
      JSON.stringify(regAfter),
    );
    const { data: masterAfter } = await sb
      .from("cluster4_competency_line_masters")
      .select("line_name,is_active")
      .eq("id", bridge.masterId)
      .maybeSingle();
    check("mirror 마스터 동기화 (브라우저 경유)", masterAfter?.line_name === `MNGB 수정됨 ${stamp}` && masterAfter?.is_active === false);
    await page.waitForTimeout(1200);
    const rowAfter = page.locator("tbody tr", { hasText: `CPMB-${stamp}` }).first();
    check("목록 갱신 — 비활성 뱃지", (await rowAfter.getByText("비활성").count()) >= 1);

    console.log("\n=== B) 개설 보유 행 — 게이트 잠금 라벨 ===");
    await page.getByLabel("라인 검색").fill("[통합]");
    await page.waitForTimeout(400);
    const unifiedRow = page.locator("tbody tr", { hasText: "신규 등록" }).filter({ hasText: "[통합]" });
    await unifiedRow.getByRole("button", { name: "수정" }).click();
    await page.waitForSelector("text=등록 수정", { timeout: 10000 });
    // 상세 로드 + 잠금 안내(서브타이틀) 렌더 대기.
    await page.waitForSelector("text=/개설 라인 \\d+건/", { timeout: 10000 });
    check(
      "개설 보유 행 — 잠금 안내 + 코드/조직/종류 비활성",
      (await page.getByText(/개설 라인 \d+건/).isVisible()) &&
        (await page.getByLabel("라인 코드 수정").isDisabled()) &&
        (await page.getByLabel("소속 클럽 수정").isDisabled()) &&
        (await page.getByLabel("라인 종류 수정").isDisabled()),
    );
    await page.screenshot({ path: "claudedocs/browser-registration-manage-locked.png", fullPage: true });
    await page.getByRole("button", { name: "취소" }).click();

    await ctx.close();
  } finally {
    await browser.close();
    // 정리
    const { count: used } = await sb
      .from("cluster4_lines")
      .select("*", { count: "exact", head: true })
      .eq("competency_line_master_id", bridge.masterId);
    if ((used ?? 0) === 0) {
      await sb.from("cluster4_competency_line_masters").delete().eq("id", bridge.masterId);
    }
    await sb.from("line_registrations").delete().eq("id", reg.id);
    console.log("\n정리 완료 (마스터+등록 삭제)");
  }

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

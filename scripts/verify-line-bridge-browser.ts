/**
 * Phase 2C 브라우저 E2E: 등록(조직 지정) → 라인 정보 → 개설 연결 → 연결됨 + info 프리필.
 *   npx tsx --env-file=.env.local scripts/verify-line-bridge-browser.ts
 * 종료 시 생성물 전부 정리(마스터·등록). 스크린샷 2장 (claudedocs/).
 */
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

function ensureEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (ok) pass++;
  else fail++;
}

async function main() {
  const stamp = Date.now();
  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const serviceKey = ensureEnv("SUPABASE_SERVICE_ROLE_KEY");
  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: l, error: le } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: adminEmail,
  });
  if (le || !l?.properties?.email_otp) throw new Error(le?.message ?? "generateLink failed");
  const { data: v, error: ve } = await anon.auth.verifyOtp({
    email: adminEmail,
    token: l.properties.email_otp,
    type: "magiclink",
  });
  if (ve || !v.session) throw new Error(ve?.message ?? "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [],
      setAll: (items) =>
        captured.push(...items.map((i) => ({ name: i.name, value: i.value }))),
    },
  });
  await server.auth.setSession({
    access_token: v.session.access_token,
    refresh_token: v.session.refresh_token,
  });

  const browser = await chromium.launch({ channel: "chromium" });
  const cleanupRegs: string[] = [];
  const cleanupMasters: string[] = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1680, height: 1050 } });
    await ctx.addCookies(
      captured.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" })),
    );
    const page = await ctx.newPage();

    console.log("=== A) 등록 — 소속 조직(Encre) 지정 ===");
    await page.goto(`${baseUrl}/admin/lines/register`, { waitUntil: "networkidle" });
    await page.getByPlaceholder("예) 마케팅 전략 라인").fill(`2C브라우저 역량 ${stamp}`);
    await page.getByLabel("소속 허브").selectOption("competency");
    await page.getByLabel("라인 종류").selectOption("관점");
    await page.getByLabel("소속 조직").selectOption("encre");
    await page.getByPlaceholder("예) WCBS-NL0001").fill(`CPBW-${stamp}`);
    await page.getByPlaceholder("메인 타이틀을 입력하세요").fill("2C 브라우저 타이틀");
    await page.getByRole("button", { name: "등록", exact: true }).click();
    await page.waitForSelector("text=라인이 등록되었습니다", { timeout: 15000 });
    const { data: reg } = await sb
      .from("line_registrations")
      .select("id,organization_slug")
      .eq("line_code", `CPBW-${stamp}`)
      .maybeSingle();
    check("등록 + DB organization_slug='encre'", reg?.organization_slug === "encre", JSON.stringify(reg));
    if (reg) cleanupRegs.push(reg.id);

    // info 등록 (프리필 링크 확인용 — 조직 미지정)
    await page.getByPlaceholder("예) 마케팅 전략 라인").fill(`2C브라우저 정보 ${stamp}`);
    await page.getByLabel("소속 허브").selectOption("info");
    await page.getByPlaceholder("예) WCBS-NL0001").fill(`IFBW-${stamp}`);
    await page.getByPlaceholder("메인 타이틀을 입력하세요").fill(`프리필 확인 타이틀 ${stamp}`);
    await page.getByRole("button", { name: "등록", exact: true }).click();
    await page.waitForSelector("text=라인이 등록되었습니다", { timeout: 15000 });
    const { data: regInfo } = await sb
      .from("line_registrations")
      .select("id")
      .eq("line_code", `IFBW-${stamp}`)
      .maybeSingle();
    if (regInfo) cleanupRegs.push(regInfo.id);

    console.log("\n=== B) 라인 정보 — 개설 연결 ===");
    await page.goto(`${baseUrl}/admin/lines/info`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=통합 라인 목록", { timeout: 15000 });
    const row = page.locator("tbody tr", { hasText: `CPBW-${stamp}` });
    check("등록 행 노출 (신규 등록 출처)", (await row.count()) === 1);
    await row.getByRole("button", { name: "개설 연결" }).click();
    await page.waitForSelector("text=개설 연결 완료", { timeout: 15000 });
    check("개설 연결 성공 배너", true);
    await page.waitForTimeout(1200);
    const rowAfter = page.locator("tbody tr", { hasText: `CPBW-${stamp}` });
    check("행 상태 '연결됨' 뱃지", (await rowAfter.getByText("연결됨").count()) === 1);
    await page.screenshot({ path: "claudedocs/browser-line-bridge-connected.png", fullPage: true });

    const { data: regAfter } = await sb
      .from("line_registrations")
      .select("bridged_master_id")
      .eq("line_code", `CPBW-${stamp}`)
      .maybeSingle();
    check("DB bridged_master_id 기록", Boolean(regAfter?.bridged_master_id));
    if (regAfter?.bridged_master_id) cleanupMasters.push(regAfter.bridged_master_id);
    const { data: master } = await sb
      .from("cluster4_competency_line_masters")
      .select("line_name,organization_slug,line_code")
      .eq("id", regAfter?.bridged_master_id ?? "")
      .maybeSingle();
    check(
      "역량 마스터 실생성 (기존 개설 드롭다운 원천)",
      master?.line_code === `CPBW-${stamp}` && master?.organization_slug === "encre",
      JSON.stringify(master),
    );

    console.log("\n=== C) info 프리필 링크 ===");
    const infoRow = page.locator("tbody tr", { hasText: `IFBW-${stamp}` });
    check("info 행 — '개설 화면(프리필)' 링크 노출", (await infoRow.getByText("개설 화면(프리필)").count()) === 1);
    await infoRow.getByText("개설 화면(프리필)").click();
    await page.waitForURL(/practical-info/, { timeout: 15000 });
    await page.waitForTimeout(2500);
    const titleInput = page.getByPlaceholder("메인 타이틀을 입력하세요");
    const prefilled = (await titleInput.count()) > 0 ? await titleInput.first().inputValue() : "";
    check(
      "info 개설 폼 메인 타이틀 프리필",
      prefilled === `프리필 확인 타이틀 ${stamp}`,
      `value='${prefilled}'`,
    );
    await page.screenshot({ path: "claudedocs/browser-line-bridge-info-prefill.png", fullPage: true });

    await ctx.close();
  } finally {
    await browser.close();
    // 정리 — 브리지 마스터(개설 0건) → 등록
    console.log("\n=== 정리 ===");
    for (const id of cleanupMasters) {
      const { count: used } = await sb
        .from("cluster4_lines")
        .select("*", { count: "exact", head: true })
        .eq("competency_line_master_id", id);
      if ((used ?? 0) === 0) {
        await sb.from("cluster4_competency_line_masters").delete().eq("id", id);
        console.log(`  - 역량 마스터 ${id} 삭제 ✓`);
      }
    }
    if (cleanupRegs.length > 0) {
      await sb.from("line_registrations").delete().in("id", cleanupRegs);
      console.log(`  - 검증 등록 ${cleanupRegs.length}건 삭제 ✓`);
    }
  }

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

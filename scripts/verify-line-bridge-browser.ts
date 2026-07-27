/**
 * 브라우저 E2E: 라인 등록 → **자동 개설 브리지** → 라인 정보 표에서의 표시.
 *   npx tsx --env-file=.env.local scripts/verify-line-bridge-browser.ts
 * 종료 시 생성물 전부 정리(마스터·등록). 스크린샷: claudedocs/browser-line-bridge-*.png
 *
 * 2026-07-27 개정
 *   · 등록 API 가 경험/역량을 **자동 브리지**하므로 UI 등록만으로 연결이 끝난다
 *     → 구 시나리오("등록 후 [개설 연결] 버튼 수동 클릭")는 정상 경로에서 재현되지 않는다.
 *       수동 복구 버튼/조건부 컬럼 시나리오는
 *       scripts/verify-lines-bridge-column-conditional.ts 가 fixture 로 담당한다.
 *   · '개설 연결'은 조건부 컬럼이 되었다 — 고정 컬럼 수 단언을 폐기하고
 *     "미연결 없음 → 헤더 없음 / 있음 → 연결된 행 셀은 '—'"로 바꿨다.
 *     (구 '연결됨' 배지 단언은 폐기 — 연결 완료 행은 더 이상 배지를 반복 표시하지 않는다.)
 *   · 구 'info 개설 화면(프리필)' 링크는 현재 UI 에 없다(실무 정보는 등록 시 활동유형 지정으로
 *     연결이 끝난다) → 해당 섹션 폐기.
 *
 * ⚠ 공용 Table 은 20행/페이지 페이지네이션 — 행 단언 전 해당 페이지로 이동한다.
 */
import { chromium, type Page } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const BRIDGE_HEADER = "개설 연결";

function ensureEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

type RegistrationRow = {
  id: string;
  organization_slug: string | null;
  bridged_master_id: string | null;
  bridged_at: string | null;
};
type MasterRow = { line_name: string; organization_slug: string; line_code: string };

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (ok) pass++;
  else fail++;
}

async function headerLabels(page: Page): Promise<string[]> {
  const raw = await page.locator("table thead th").allTextContents();
  return raw.map((t) => t.replace(/\s+/g, " ").trim());
}

async function waitTable(page: Page) {
  await page.waitForSelector("table tbody tr", { timeout: 60000 });
  await page
    .locator("tbody")
    .getByRole("button", { name: "수정" })
    .first()
    .waitFor({ state: "visible", timeout: 60000 });
}

async function gotoRowPage(page: Page, code: string): Promise<boolean> {
  const prev = page.getByRole("button", { name: "이전 페이지" });
  while ((await prev.count()) > 0 && (await prev.isEnabled())) {
    await prev.click();
    await page.waitForTimeout(120);
  }
  for (let i = 0; i < 20; i++) {
    if ((await page.locator("tbody tr", { hasText: code }).count()) > 0) return true;
    const next = page.getByRole("button", { name: "다음 페이지" });
    if ((await next.count()) === 0 || !(await next.isEnabled())) break;
    await next.click();
    await page.waitForTimeout(150);
  }
  return (await page.locator("tbody tr", { hasText: code }).count()) > 0;
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
    const code = `CPBW-${stamp}`;

    console.log("=== A) 등록 — 역량/소속 클럽(Encre) 지정 → 자동 브리지 ===");
    await page.goto(`${baseUrl}/admin/lines/register`, {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });
    await page.getByPlaceholder("예) 마케팅 전략 라인").fill(`2C브라우저 역량 ${stamp}`);
    await page.getByLabel("소속 허브", { exact: true }).selectOption("competency");
    await page.getByLabel("라인 종류", { exact: true }).selectOption("관점");
    await page.getByLabel("소속 클럽", { exact: true }).selectOption("encre");
    await page.getByLabel("라인 코드", { exact: true }).fill(code);
    await page.getByLabel("소요 시간", { exact: true }).selectOption("60");
    await page.getByPlaceholder("메인 타이틀을 입력하세요").fill("2C 브라우저 타이틀");
    await page.getByRole("button", { name: "등록", exact: true }).click();
    // 자동 브리지 성공 문구 — "…라인이 등록되어 관련 개설 목록에 반영되었습니다."
    await page.waitForSelector("text=관련 개설 목록에 반영되었습니다", { timeout: 20000 });
    check("등록 + 자동 브리지 성공 토스트", true);

    const { data: regRow } = await sb
      .from("line_registrations")
      .select("id,organization_slug,bridged_master_id,bridged_at")
      .eq("line_code", code)
      .maybeSingle();
    const reg = regRow as RegistrationRow | null;
    check("DB organization_slug='encre'", reg?.organization_slug === "encre");
    check(
      "DB bridged_master_id / bridged_at 기록 (자동 브리지)",
      Boolean(reg?.bridged_master_id) && Boolean(reg?.bridged_at),
    );
    if (reg) cleanupRegs.push(reg.id);
    if (reg?.bridged_master_id) cleanupMasters.push(reg.bridged_master_id);

    const { data: masterRow } = await sb
      .from("cluster4_competency_line_masters")
      .select("line_name,organization_slug,line_code")
      .eq("id", reg?.bridged_master_id ?? "")
      .maybeSingle();
    const master = masterRow as MasterRow | null;
    check(
      "역량 마스터 실생성 (기존 개설 드롭다운 원천)",
      master?.line_code === code && master?.organization_slug === "encre",
      JSON.stringify(master),
    );

    console.log("\n=== B) 라인 정보 표 — 조건부 '개설 연결' 컬럼 ===");
    await page.goto(`${baseUrl}/admin/lines/info`, {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });
    await waitTable(page);
    check("등록 행 노출", await gotoRowPage(page, code));
    const heads = await headerLabels(page);
    check(
      "등록 행에 [개설 연결] 버튼 없음 (이미 자동 연결됨)",
      (await page
        .locator("tbody tr", { hasText: code })
        .getByRole("button", { name: BRIDGE_HEADER })
        .count()) === 0,
    );
    if (heads.includes(BRIDGE_HEADER)) {
      // 다른 미연결 행이 있어 컬럼이 떠 있는 경우 — 이 행의 셀은 '—' 여야 한다.
      const idx = heads.indexOf(BRIDGE_HEADER) + 1;
      const cell = (
        await page
          .locator("tbody tr", { hasText: code })
          .locator(`td:nth-child(${idx})`)
          .textContent()
      )
        ?.replace(/\s+/g, " ")
        .trim();
      check("연결 완료 행 셀 = '—' (연결 완료 배지 미표시)", cell === "—", `cell='${cell}'`);
    } else {
      check(
        "미연결 행 없음 → '개설 연결' 헤더 자체가 미렌더",
        !heads.includes(BRIDGE_HEADER),
        `${heads.length}컬럼: ${heads.join(" | ")}`,
      );
    }
    await page.screenshot({
      path: "claudedocs/browser-line-bridge-connected.png",
      fullPage: true,
    });

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

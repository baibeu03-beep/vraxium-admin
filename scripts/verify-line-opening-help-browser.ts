import { chromium, type Page } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// /admin/line-opening/* 요소별 도움말(돋보기) Pass 2 브라우저 검증.
//   대상 Live 라우트: practical-info / practical-career / practical-experience / practical-competency.
//   (line-history 는 feature-off(notFound) → 제외)
//   A) practical-info(manage, org 불필요): "현재 상황" 카드 + 정보 라벨 신규 돋보기 렌더,
//      클릭→편집/저장 모달, 저장→새로고침 유지. 1440/1280/1024 스크린샷.
//   B) practical-career(org 불필요): in-body 3탭 돋보기 렌더.
//   C) practical-experience / practical-competency(org 스코프): best-effort 렌더 + 스크린샷.
//   D) /api/admin/help 요청에 org/mode 파라미터 없음(공통 키) — 전 라우트 통합 검사.

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SHOT_DIR = "claudedocs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function makeAdminCookies() {
  const { data: admins, error: adminError } = await supabaseAdmin
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  if (adminError) throw adminError;
  const email = (admins?.[0] as { email: string } | undefined)?.email;
  assert(email, "No active admin email");

  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  assert(link.properties?.email_otp && !linkError, linkError?.message ?? "generateLink failed");
  const { data: verified, error: verifyError } = await anon.auth.verifyOtp({
    email,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  assert(verified.session && !verifyError, verifyError?.message ?? "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [],
      setAll: (items) => captured.push(...items.map(({ name, value }) => ({ name, value }))),
    },
  });
  await server.auth.setSession({
    access_token: verified.session.access_token,
    refresh_token: verified.session.refresh_token,
  });
  return captured.map(({ name, value }) => ({
    name,
    value,
    domain: "localhost",
    path: "/",
    httpOnly: false,
    secure: false,
    sameSite: "Lax" as const,
  }));
}

async function discoverOrg(): Promise<string | null> {
  // 명시 override(검증 대상 org 고정) 우선.
  if (process.env.VERIFY_ORG) return process.env.VERIFY_ORG;
  // line-opening org 스코프 탭 검증용 유효 org 1개(활성 팀이 있는 조직 우선).
  const { data } = await supabaseAdmin
    .from("cluster4_team_halves")
    .select("organization_slug")
    .eq("is_active", true)
    .not("organization_slug", "is", null)
    .limit(1);
  const org = (data?.[0] as { organization_slug: string } | undefined)?.organization_slug ?? null;
  return org ?? "phalanx";
}

type HelpReq = { method: string; path: string | null; mode: string | null; org: string | null };
const helpReqs: HelpReq[] = [];
const cleanupKeys = new Set<string>();

function wireHelpSniffer(page: Page) {
  page.on("request", (request) => {
    const u = new URL(request.url());
    if (u.pathname !== "/api/admin/help") return;
    let path = u.searchParams.get("path");
    if (!path && request.postData()) {
      try {
        path = (JSON.parse(request.postData()!) as { path?: string }).path ?? null;
      } catch {
        /* ignore */
      }
    }
    if (path) cleanupKeys.add(path);
    helpReqs.push({
      method: request.method(),
      path,
      mode: u.searchParams.get("mode"),
      org: u.searchParams.get("org"),
    });
  });
}

async function helpCount(page: Page): Promise<number> {
  return page.getByRole("button", { name: "이 항목 도움말" }).count();
}

async function shotAt(page: Page, width: number, tag: string) {
  await page.setViewportSize({ width, height: 1000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOT_DIR}/qa-lineopen-${tag}-${width}.png`, fullPage: true });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies(await makeAdminCookies());
  const page = await context.newPage();
  wireHelpSniffer(page);

  const org = await discoverOrg();
  console.log(`discovered org = ${org ?? "(none)"}`);
  const marker = `[QA ${new Date().toISOString()}] 라인개설 도움말 Pass2 유지 검증`;

  try {
    // ══ A) practical-info (manage, org 불필요) ════════════════════════════════
    await page.goto(`${baseUrl}/admin/line-opening/practical-info`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1800);

    // "현재 상황" 카드 제목 + 신규 돋보기(사용자 예시의 핵심 누락).
    const situationTitle = page.getByText("현재 상황", { exact: true });
    await situationTitle.first().waitFor({ state: "visible", timeout: 15_000 });
    const situationHelp = situationTitle.first().getByRole("button", { name: "이 항목 도움말" });
    assert((await situationHelp.count()) >= 1, '"현재 상황" 카드 제목 옆 돋보기 없음');
    console.log('PASS A1 practical-info "현재 상황" 카드 돋보기 렌더');

    // 정보 라벨 3종 라벨 옆 돋보기(값에는 없어야 함) — 라벨 텍스트로 확인.
    for (const label of ["오늘 날짜", "개설 필요 기간", "개설 이행 기간"]) {
      const lbl = page.getByText(label, { exact: true }).first();
      await lbl.waitFor({ state: "visible", timeout: 10_000 });
      const btn = lbl.getByRole("button", { name: "이 항목 도움말" });
      assert((await btn.count()) >= 1, `정보 라벨 "${label}" 옆 돋보기 없음`);
    }
    console.log("PASS A2 정보 라벨(오늘 날짜/개설 필요 기간/개설 이행 기간) 돋보기 렌더");

    const infoTotal = await helpCount(page);
    console.log(`      practical-info 총 돋보기 ${infoTotal}개`);
    assert(infoTotal >= 6, `practical-info 돋보기 최소 6개 기대, 실제 ${infoTotal}`);

    // 클릭 → 편집/저장 모달 → 저장 → 새로고침 유지 ("현재 상황" 키 대상).
    await situationHelp.first().click();
    const dlg = page.getByRole("dialog");
    await dlg.waitFor({ state: "visible", timeout: 10_000 });
    assert(await page.getByRole("button", { name: "편집" }).isVisible(), "[편집] 버튼 없음");
    await page.getByRole("button", { name: "편집" }).click();
    const ta = dlg.locator("textarea");
    await ta.waitFor({ state: "visible" });
    await ta.fill(marker);
    const put = page.waitForResponse(
      (r) => r.url().includes("/api/admin/help") && r.request().method() === "PUT",
    );
    await page.getByRole("button", { name: "저장" }).click();
    const putResp = await put;
    assert(putResp.ok(), `저장 PUT 실패 ${putResp.status()}`);
    console.log("PASS A3 돋보기 클릭→편집→저장 PUT 200");
    await page.getByRole("button", { name: "닫기" }).click();
    await page.waitForTimeout(300);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1800);
    await page
      .getByText("현재 상황", { exact: true })
      .first()
      .getByRole("button", { name: "이 항목 도움말" })
      .first()
      .click();
    const dlg2 = page.getByRole("dialog");
    await dlg2.waitFor({ state: "visible", timeout: 10_000 });
    await dlg2.getByText(marker.slice(0, 24), { exact: false }).waitFor({ state: "visible", timeout: 10_000 });
    console.log("PASS A4 새로고침 후 저장 내용 유지");
    await page.getByRole("button", { name: "닫기" }).click();
    await page.waitForTimeout(300);

    await shotAt(page, 1440, "info");
    await shotAt(page, 1280, "info");
    await shotAt(page, 1024, "info");
    await page.setViewportSize({ width: 1440, height: 1000 });

    // ══ B) practical-career (org 불필요) — in-body 3탭 돋보기 ═══════════════════
    await page.goto(`${baseUrl}/admin/line-opening/practical-career`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1800);
    for (const tab of ["라인 등록", "경력 라인 개설", "경력 기록/평가 관리"]) {
      const t = page.getByText(tab, { exact: true }).first();
      await t.waitFor({ state: "visible", timeout: 10_000 });
    }
    const careerTotal = await helpCount(page);
    console.log(`PASS B1 practical-career 로드 · 총 돋보기 ${careerTotal}개`);
    assert(careerTotal >= 3, `practical-career 돋보기 최소 3개(탭) 기대, 실제 ${careerTotal}`);
    await shotAt(page, 1440, "career");
    await page.setViewportSize({ width: 1440, height: 1000 });

    // ══ C) experience / competency (org 스코프, best-effort) ═══════════════════
    for (const [slug, tag] of [
      ["practical-experience", "exp"],
      ["practical-competency", "comp"],
    ] as const) {
      const url = org
        ? `${baseUrl}/admin/line-opening/${slug}?org=${encodeURIComponent(org)}`
        : `${baseUrl}/admin/line-opening/${slug}`;
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3500);
      const n = await helpCount(page);
      console.log(`      ${slug} (org=${org ?? "none"}) 돋보기 ${n}개`);
      await shotAt(page, 1440, `${tag}-manage`);
      // open 탭
      const openUrl = org
        ? `${baseUrl}/admin/line-opening/${slug}?org=${encodeURIComponent(org)}&tab=open`
        : `${baseUrl}/admin/line-opening/${slug}?tab=open`;
      await page.goto(openUrl, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3500);
      const nOpen = await helpCount(page);
      console.log(`      ${slug}?tab=open 돋보기 ${nOpen}개`);
      await shotAt(page, 1440, `${tag}-open`);
      page.setViewportSize({ width: 1440, height: 1000 });
    }
    console.log("PASS C experience/competency 렌더(오류 없이 로드, best-effort)");

    // ══ D) org/mode 중립 ══════════════════════════════════════════════════════
    const leaked = helpReqs.filter((r) => r.mode !== null || r.org !== null);
    assert(leaked.length === 0, `org/mode 파라미터 누수: ${JSON.stringify(leaked.slice(0, 3))}`);
    console.log(`PASS D /api/admin/help ${helpReqs.length}건 모두 org/mode 파라미터 없음`);

    console.log("\nALL PASS");
    console.log("captured keys:", [...cleanupKeys].sort().join(", "));
  } finally {
    for (const k of cleanupKeys) {
      await supabaseAdmin
        .from("admin_page_help_contents")
        .upsert({ page_path: k, content: "", updated_at: new Date().toISOString() }, { onConflict: "page_path" });
    }
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

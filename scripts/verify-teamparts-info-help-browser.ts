import { chromium, type Page } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// /admin/team-parts/info — 돋보기 도움말 + 드롭다운 라벨 + 필터 레이아웃 브라우저/HTTP 검증.
//   (1) 돋보기 렌더 수 + 클릭 시 편집/저장 모달(정적 Popover 아님)
//   (2) filter.half 키 저장 → 새로고침 후 유지
//   (3) 돋보기 클릭이 하부 컨트롤(등록 박스 등)을 실행하지 않음(이벤트 격리)
//   (4) 해당 시기 <select> — 트리거에 raw value(예: 2026-H1)가 아닌 라벨(2026년 상반기)이 보임
//   (5) 필터 레이아웃 — 1440/1280/1024 에서 가로 스크롤 없음(스크린샷)
//   (6) /api/admin/help 요청에 org/mode 파라미터 없음(공통 키)
//   (7) HTTP — 일반 vs mode=test 데이터 API 가 동일 DTO 형태

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SHOT_DIR = "claudedocs";
const PAGE_PATH = "/admin/team-parts/info";

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

type HelpReq = { method: string; path: string | null; mode: string | null; org: string | null };

async function noHScroll(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1,
  );
}

async function main() {
  const marker = `[QA-TPINFO ${new Date().toISOString()}] filter.half 저장 검증`;
  const helpReqs: HelpReq[] = [];
  const cleanupKeys = ["admin.teamParts.info.filter.half"];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies(await makeAdminCookies());
  const page = await context.newPage();

  page.on("request", (request) => {
    const u = new URL(request.url());
    if (u.pathname === "/api/admin/help") {
      let path = u.searchParams.get("path");
      if (!path && request.postData()) {
        try {
          path = (JSON.parse(request.postData()!) as { path?: string }).path ?? null;
        } catch {
          path = null;
        }
      }
      helpReqs.push({
        method: request.method(),
        path,
        mode: u.searchParams.get("mode"),
        org: u.searchParams.get("org"),
      });
    }
  });

  try {
    await page.goto(`${baseUrl}${PAGE_PATH}`, { waitUntil: "domcontentloaded" });
    // 초기 로드(3개 org 병렬 조회) 완료 = 조직 탭 렌더까지 대기.
    await page.waitForSelector("[data-org-tab]", { timeout: 30_000 });
    await page.waitForTimeout(500);

    // (1) 돋보기 렌더 수
    const mags = page.getByRole("button", { name: "이 항목 도움말" });
    const total = await mags.count();
    assert(total >= 6, `상단 돋보기 6개 이상 필요(현재 ${total})`);
    console.log(`PASS 돋보기 렌더 — ${total}개 (모달 닫힘 상태)`);

    // (4) 해당 시기 select — 라벨 vs raw value
    const sel = page.locator("#team-parts-half-select");
    const selValue = await sel.inputValue();
    const shownText = await sel.evaluate((el) => {
      const s = el as HTMLSelectElement;
      return s.options[s.selectedIndex]?.textContent?.trim() ?? "";
    });
    assert(shownText.length > 0, "해당 시기 select 표시 텍스트 없음");
    assert(shownText !== selValue, `select 트리거에 raw value 노출: "${shownText}" == value("${selValue}")`);
    assert(/반기/.test(shownText), `select 라벨이 반기 문구 아님: "${shownText}"`);
    console.log(`PASS 해당 시기 select — 표시="${shownText}" / value="${selValue}" (라벨 노출, raw 아님)`);

    // (5) 필터 레이아웃 — 3 해상도 가로 스크롤 없음 + 스크린샷
    for (const w of [1440, 1280, 1024] as const) {
      await page.setViewportSize({ width: w, height: 1000 });
      await page.waitForTimeout(400);
      const ok = await noHScroll(page);
      assert(ok, `가로 스크롤 발생 @${w}px`);
      await page.screenshot({ path: `${SHOT_DIR}/qa-tpinfo-${w}.png`, fullPage: false });
      console.log(`PASS 레이아웃 @${w}px — 가로 스크롤 없음 (qa-tpinfo-${w}.png)`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForTimeout(300);

    // (3) 이벤트 격리 — 등록 박스 위 돋보기 클릭이 등록 모달을 열지 않음
    const regBox = page.locator("#team-parts-register-box");
    if ((await regBox.count()) > 0) {
      // 등록 박스 컨테이너 안(마지막 돋보기 = register)의 아이콘 클릭.
      const regHelp = page.locator("#team-parts-register-box ~ div button[aria-label='이 항목 도움말']");
      if ((await regHelp.count()) > 0) {
        await regHelp.first().click();
        const dlg = page.getByRole("dialog");
        await dlg.waitFor({ state: "visible", timeout: 8000 });
        const regModalVisible = await page.locator("#team-parts-register-modal").isVisible().catch(() => false);
        assert(!regModalVisible, "돋보기 클릭이 등록 모달을 열었음 — 이벤트 격리 실패");
        console.log("PASS 이벤트 격리 — 등록 박스 돋보기 클릭이 등록 모달을 열지 않음(도움말만 열림)");
        await page.getByRole("button", { name: "닫기" }).click();
        await page.waitForTimeout(300);
      } else {
        console.log("SKIP 이벤트 격리 — 등록 박스 돋보기 미발견(권한/반기 상태)");
      }
    }

    // (2) filter.half 저장 → 새로고침 후 유지
    await mags.nth(0).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    assert(await page.getByRole("button", { name: "편집" }).isVisible(), "[편집] 없음 — 편집 모달 아님");
    assert(await page.getByRole("button", { name: "저장" }).isVisible(), "[저장] 없음 — 편집 모달 아님");
    await page.getByRole("button", { name: "편집" }).click();
    const ta = dialog.locator("textarea");
    await ta.waitFor({ state: "visible" });
    await ta.fill(marker);
    const putResp = page.waitForResponse(
      (r) => r.url().includes("/api/admin/help") && r.request().method() === "PUT",
    );
    await page.getByRole("button", { name: "저장" }).click();
    const put = await putResp;
    assert(put.ok(), `저장 PUT 실패 status=${put.status()}`);
    console.log("PASS filter.half 편집→저장 PUT 200");
    await page.getByRole("button", { name: "닫기" }).click();
    await page.waitForTimeout(300);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-org-tab]", { timeout: 30_000 });
    await page.waitForTimeout(500);
    const mags2 = page.getByRole("button", { name: "이 항목 도움말" });
    await mags2.nth(0).click();
    const dialog2 = page.getByRole("dialog");
    await dialog2.waitFor({ state: "visible", timeout: 10_000 });
    await dialog2.getByText(marker.slice(0, 24), { exact: false }).waitFor({ state: "visible", timeout: 10_000 });
    console.log("PASS 새로고침 후 filter.half 저장 내용 유지");
    await page.screenshot({ path: `${SHOT_DIR}/qa-tpinfo-help-persisted.png` });
    await page.getByRole("button", { name: "닫기" }).click();
    await page.waitForTimeout(300);

    // 등록 모달 내부 돋보기(필드/액션) — 5개 이상
    const regBox2 = page.locator("#team-parts-register-box");
    if ((await regBox2.count()) > 0 && (await regBox2.isEnabled())) {
      await regBox2.click();
      const regModal = page.locator("#team-parts-register-modal");
      await regModal.waitFor({ state: "visible", timeout: 8000 });
      const modalMags = regModal.getByRole("button", { name: "이 항목 도움말" });
      const modalCount = await modalMags.count();
      assert(modalCount >= 5, `등록 모달 돋보기 5개 이상 필요(현재 ${modalCount})`);
      console.log(`PASS 등록 모달 돋보기 — ${modalCount}개(팀명/개요/크루코드/호출/저장)`);
      await page.screenshot({ path: `${SHOT_DIR}/qa-tpinfo-modal.png` });
    } else {
      console.log("SKIP 등록 모달 — 등록 박스 비활성(과거 반기/권한)");
    }

    // (6) org/mode 중립
    const leaked = helpReqs.filter((r) => r.mode !== null || r.org !== null);
    assert(leaked.length === 0, `help 요청 org/mode 누수: ${JSON.stringify(leaked.slice(0, 3))}`);
    console.log(`PASS /api/admin/help ${helpReqs.length}건 모두 org/mode 없음(공통 키)`);

    // (7) HTTP — 일반 vs mode=test 데이터 API 동일 DTO 형태
    const normalRes = await page.request.get(
      `${baseUrl}/api/admin/team-parts/info?organization=encre`,
    );
    const testRes = await page.request.get(
      `${baseUrl}/api/admin/team-parts/info?organization=encre&mode=test`,
    );
    assert(normalRes.ok(), `일반 데이터 API 실패 ${normalRes.status()}`);
    assert(testRes.ok(), `test 데이터 API 실패 ${testRes.status()}`);
    const normalJson = (await normalRes.json()) as { data?: Record<string, unknown> };
    const testJson = (await testRes.json()) as { data?: Record<string, unknown> };
    const nKeys = Object.keys(normalJson.data ?? {}).sort();
    const tKeys = Object.keys(testJson.data ?? {}).sort();
    assert(
      JSON.stringify(nKeys) === JSON.stringify(tKeys),
      `일반/test DTO 키 불일치\n일반=${nKeys.join(",")}\ntest=${tKeys.join(",")}`,
    );
    console.log(`PASS 일반/test 데이터 API 동일 DTO 키 [${nKeys.join(", ")}]`);

    console.log("\nALL PASS");
  } finally {
    for (const k of cleanupKeys) {
      await supabaseAdmin
        .from("admin_page_help_contents")
        .upsert(
          { page_path: k, content: "", updated_at: new Date().toISOString() },
          { onConflict: "page_path" },
        );
    }
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

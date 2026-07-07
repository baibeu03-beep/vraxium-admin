import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// 돋보기(AdminHelpIconButton) = 페이지 도움말과 "동일한" 편집/저장 모달을 여는지 브라우저로 검증.
//   1) 돋보기 클릭 → role=dialog + [편집]/[저장] 버튼(=편집 모달, 정적 Popover 아님)
//   2) helpKey 별 저장 → 새로고침 후 재조회 시 유지
//   3) 다른 돋보기(다른 key)는 첫 내용과 섞이지 않음
//   4) /api/admin/help 요청에 org/mode 파라미터가 없음(공통 키)

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

type HelpReq = { method: string; path: string | null; mode: string | null; org: string | null };

async function main() {
  const marker = `[QA-HELP ${new Date().toISOString()}] 요소별 도움말 저장 검증 본문`;
  const capturedKeys = new Set<string>();
  const helpReqs: HelpReq[] = [];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies(await makeAdminCookies());
  const page = await context.newPage();

  page.on("request", (request) => {
    const u = new URL(request.url());
    if (u.pathname === "/api/admin/help") {
      const path = u.searchParams.get("path") ?? bodyPath(request.postData());
      if (path) capturedKeys.add(path);
      helpReqs.push({
        method: request.method(),
        path,
        mode: u.searchParams.get("mode"),
        org: u.searchParams.get("org"),
      });
    }
  });

  function bodyPath(body: string | null): string | null {
    if (!body) return null;
    try {
      return (JSON.parse(body) as { path?: string }).path ?? null;
    } catch {
      return null;
    }
  }

  const cleanupKeys: string[] = [];
  try {
    // 사용자 예시 경로 우선, 실패 시 members 로 폴백(둘 다 헤더 돋보기 존재).
    let landed = "";
    for (const p of ["/admin/team-parts/info/weeks", "/admin/members"]) {
      await page.goto(`${baseUrl}${p}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);
      const cnt = await page.getByRole("button", { name: "이 항목 도움말" }).count();
      if (cnt > 0) {
        landed = p;
        break;
      }
    }
    assert(landed, "돋보기 버튼을 어떤 페이지에서도 찾지 못함");
    const mags = page.getByRole("button", { name: "이 항목 도움말" });
    const total = await mags.count();
    assert(total >= 2, `돋보기가 2개 이상 필요(현재 ${total})`);
    console.log(`PASS 돋보기 렌더 확인 — ${landed} 에서 ${total}개`);

    // (1) 첫 돋보기 클릭 → 편집 모달 확인
    await mags.nth(0).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    assert(await page.getByRole("button", { name: "편집" }).isVisible(), "[편집] 버튼 없음 — 편집 모달이 아님(정적 Popover 의심)");
    assert(await page.getByRole("button", { name: "저장" }).isVisible(), "[저장] 버튼 없음 — 편집 모달이 아님");
    console.log("PASS 돋보기 클릭 → 편집/저장 모달 열림(정적 Popover 아님)");
    await page.screenshot({ path: `${SHOT_DIR}/qa-help-modal-open.png` });

    const keyA = [...capturedKeys][0];
    assert(keyA, "GET 요청에서 helpKey(path) 캡처 실패");
    cleanupKeys.push(keyA);

    // (2) 편집 → 저장 → PUT 200
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
    console.log(`PASS 편집→저장 PUT 200 (key=${keyA})`);
    await page.screenshot({ path: `${SHOT_DIR}/qa-help-modal-saved.png` });
    // 모달 닫기
    await page.getByRole("button", { name: "닫기" }).click();
    await page.waitForTimeout(300);

    // (3) 새로고침 후 같은 돋보기 재열기 → 저장 내용 유지
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const mags2 = page.getByRole("button", { name: "이 항목 도움말" });
    const getA = page.waitForResponse(
      (r) => r.url().includes("/api/admin/help") && r.request().method() === "GET",
    );
    await mags2.nth(0).click();
    const dialog2 = page.getByRole("dialog");
    await dialog2.waitFor({ state: "visible", timeout: 10_000 });
    await getA; // 조회 완료까지 대기(로딩 스피너 → 내용)
    // 저장된 본문이 나타날 때까지 대기(비동기 렌더 레이스 방지).
    await dialog2.getByText(marker.slice(0, 24), { exact: false }).waitFor({ state: "visible", timeout: 10_000 });
    const shownText = await dialog2.innerText();
    assert(shownText.includes(marker.slice(0, 24)), "새로고침 후 저장 내용이 유지되지 않음");
    console.log("PASS 새로고침 후 저장 내용 유지");
    await page.screenshot({ path: `${SHOT_DIR}/qa-help-modal-persisted.png` });
    await page.getByRole("button", { name: "닫기" }).click();
    await page.waitForTimeout(300);

    // (4) 다른 돋보기(다른 key) → 첫 내용과 섞이지 않음
    // keyA 이외의 key 를 여는 돋보기를 찾는다.
    let mixedOk = false;
    let keyB = "";
    const count2 = await mags2.count();
    for (let i = 1; i < count2; i++) {
      capturedKeys.clear();
      const getB = page.waitForResponse(
        (r) => r.url().includes("/api/admin/help") && r.request().method() === "GET",
      );
      await mags2.nth(i).click();
      const d = page.getByRole("dialog");
      await d.waitFor({ state: "visible", timeout: 10_000 });
      await getB;
      await page.waitForTimeout(300); // 로딩 스피너 → 내용 전환
      const k = [...capturedKeys][0];
      const txt = await d.innerText();
      await page.getByRole("button", { name: "닫기" }).click();
      await page.waitForTimeout(250);
      if (k && k !== keyA) {
        keyB = k;
        cleanupKeys.push(k);
        assert(!txt.includes(marker.slice(0, 24)), `다른 key(${k}) 모달에 첫 내용이 새어 나옴 — 키 충돌`);
        mixedOk = true;
        break;
      }
    }
    assert(mixedOk, "keyA 와 다른 key 를 가진 돋보기를 찾지 못함");
    console.log(`PASS 다른 돋보기(key=${keyB})는 첫 내용과 섞이지 않음 (keyA≠keyB)`);

    // (5) org/mode 중립: /api/admin/help 요청에 mode/org 파라미터 없음
    const leaked = helpReqs.filter((r) => r.mode !== null || r.org !== null);
    assert(leaked.length === 0, `org/mode 파라미터 누수: ${JSON.stringify(leaked.slice(0, 3))}`);
    console.log(`PASS /api/admin/help ${helpReqs.length}건 모두 org/mode 파라미터 없음(공통 키)`);

    console.log("\nCAPTURED_KEY_A=" + keyA);
    console.log("CAPTURED_KEY_B=" + keyB);
    console.log("ALL PASS");
  } finally {
    // 검증용 저장 내용 정리(빈 문자열로 upsert).
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

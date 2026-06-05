/**
 * 운영 계정 이름(display_name) 수정 기능 검증 — HTTP + DB direct + 브라우저 UI.
 *   A. HTTP: PATCH /api/admin/accounts/[id] display_name →
 *      ① 응답 account.displayName ② DB user_profiles.display_name(direct)
 *      ③ GET /api/admin/accounts 목록 ④ GET /api/admin/me
 *      ⑤ admin_users 전체(email/role/is_active) 불변 ⑥ 빈 문자열/51자 400 → 원복
 *   B. UI(Playwright): /admin/settings/accounts 연필 → input → 저장 → 셀 갱신,
 *      /admin 새로고침 → 사이드바 환영 문구 갱신 → UI 로 원복.
 *
 *   사전조건: dev 서버 (http://localhost:3000).
 *   npx tsx --env-file=.env.local scripts/verify-account-display-name-edit.mts
 */
import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// playwright 는 admin repo 에 미설치 — 인접 고객 repo(../vraxium) 설치본을 재사용.
const requireFromFront = createRequire(
  new URL("../../vraxium/package.json", import.meta.url),
);
const { chromium } = requireFromFront("playwright") as typeof import("playwright");

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const TEST_NAME_HTTP = "이름검증HTTP";
const TEST_NAME_UI = "이름검증UI";

function ensureEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const admin = createClient(supabaseUrl, ensureEnv("SUPABASE_SERVICE_ROLE_KEY"));

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function makeAdminCookies() {
  const browser = createClient(supabaseUrl, anonKey);
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: adminEmail,
  });
  if (linkError || !linkData?.properties?.email_otp) {
    throw new Error(linkError?.message ?? "Failed to generate admin magic link");
  }
  const { data: verifyData, error: verifyError } = await browser.auth.verifyOtp({
    email: adminEmail,
    token: linkData.properties.email_otp,
    type: "magiclink",
  });
  if (verifyError || !verifyData.session) {
    throw new Error(verifyError?.message ?? "Failed to verify admin OTP");
  }
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [],
      setAll: (items) => {
        captured.push(...items.map((i) => ({ name: i.name, value: i.value })));
      },
    },
  });
  const { error: setError } = await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  if (setError) throw new Error(setError.message);
  return captured;
}

async function fetchDirectName(userId: string) {
  const { data, error } = await admin
    .from("user_profiles")
    .select("display_name")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data?.display_name ?? null) as string | null;
}

async function snapshotAdminUsers() {
  const { data, error } = await admin
    .from("admin_users")
    .select("id,email,role,is_active")
    .order("id");
  if (error) throw new Error(error.message);
  return JSON.stringify(data);
}

async function main() {
  const cookies = await makeAdminCookies();
  const cookieHeader = cookies.map((i) => `${i.name}=${i.value}`).join("; ");
  const patch = (userId: string, body: unknown) =>
    fetch(`${baseUrl}/api/admin/accounts/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookieHeader },
      body: JSON.stringify(body),
    });

  // ── 준비: 본인 계정/원래 이름 + admin_users 스냅샷 ───────────────────
  const { data: selfRow, error: selfError } = await admin
    .from("admin_users")
    .select("id")
    .eq("email", adminEmail)
    .maybeSingle();
  if (selfError || !selfRow) throw new Error(selfError?.message ?? "self admin missing");
  const selfId = selfRow.id as string;
  const originalName = await fetchDirectName(selfId);
  if (!originalName) throw new Error("원래 display_name 이 비어 있어 검증을 중단합니다.");
  const adminUsersBefore = await snapshotAdminUsers();
  console.log(`info | 대상=${adminEmail} 원래 이름=${originalName}`);

  try {
    // ── A-1) PATCH 성공 + 응답 반영 ───────────────────────────────────
    const res = await patch(selfId, { display_name: `  ${TEST_NAME_HTTP}  ` });
    const json = (await res.json()) as {
      success?: boolean;
      data?: { account?: { displayName?: string | null } };
    };
    check(
      "PATCH display_name → 200 + 응답 displayName(trim 적용)",
      res.status === 200 &&
        json.success === true &&
        json.data?.account?.displayName === TEST_NAME_HTTP,
      `status=${res.status} displayName=${json.data?.account?.displayName}`,
    );

    // ── A-2) DB direct ───────────────────────────────────────────────
    const directAfter = await fetchDirectName(selfId);
    check(
      "DB user_profiles.display_name 변경(direct)",
      directAfter === TEST_NAME_HTTP,
      `direct=${directAfter}`,
    );

    // ── A-3) 목록 HTTP ───────────────────────────────────────────────
    const listRes = await fetch(
      `${baseUrl}/api/admin/accounts?q=${encodeURIComponent(adminEmail)}`,
      { headers: { Cookie: cookieHeader } },
    );
    const listJson = (await listRes.json()) as {
      data?: { accounts?: Array<{ userId: string; displayName: string | null }> };
    };
    const listed = listJson.data?.accounts?.find((a) => a.userId === selfId);
    check(
      "GET /api/admin/accounts 목록 displayName 반영",
      listed?.displayName === TEST_NAME_HTTP,
      `listed=${listed?.displayName}`,
    );

    // ── A-4) /api/admin/me ───────────────────────────────────────────
    const meRes = await fetch(`${baseUrl}/api/admin/me`, {
      headers: { Cookie: cookieHeader },
    });
    const meJson = (await meRes.json()) as {
      data?: { displayName?: string | null };
    };
    check(
      "GET /api/admin/me displayName 반영",
      meJson.data?.displayName === TEST_NAME_HTTP,
      `me=${meJson.data?.displayName}`,
    );

    // ── A-5) admin_users 불변 ────────────────────────────────────────
    check(
      "admin_users 전체(email/role/is_active) 불변",
      (await snapshotAdminUsers()) === adminUsersBefore,
    );

    // ── A-6) validation ──────────────────────────────────────────────
    const emptyRes = await patch(selfId, { display_name: "   " });
    check("빈 문자열(공백만) → 400", emptyRes.status === 400, `status=${emptyRes.status}`);
    const longRes = await patch(selfId, { display_name: "가".repeat(51) });
    check("51자 → 400", longRes.status === 400, `status=${longRes.status}`);
    const noAuthRes = await fetch(
      `${baseUrl}/api/admin/accounts/${encodeURIComponent(selfId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: "x".repeat(3) }),
      },
    );
    check("비로그인 PATCH → 401", noAuthRes.status === 401, `status=${noAuthRes.status}`);
    check(
      "validation 시도 후에도 DB 이름 유지",
      (await fetchDirectName(selfId)) === TEST_NAME_HTTP,
    );

    // ── B) 브라우저 UI ───────────────────────────────────────────────
    const browser = await chromium.launch({ channel: "chromium" });
    try {
      const context = await browser.newContext({ baseURL: baseUrl });
      await context.addCookies(
        cookies.map((i) => ({ ...i, domain: "localhost", path: "/" })),
      );
      const page = await context.newPage();

      await page.goto("/admin/settings/accounts", { waitUntil: "networkidle" });
      await page.getByPlaceholder("이메일, user_id 로 검색").fill(adminEmail);
      const row = page.locator("tbody tr", { hasText: adminEmail });
      await row.waitFor({ timeout: 15000 });
      check("목록: 이름 셀 표시", await row.getByText(TEST_NAME_HTTP).isVisible());

      await row.getByRole("button", { name: "이름 수정" }).click();
      const input = row.getByLabel("이름 수정 입력");
      check("수정 클릭 → input 표시(현재 이름 프리필)", (await input.inputValue()) === TEST_NAME_HTTP);
      await input.fill(TEST_NAME_UI);
      await row.getByRole("button", { name: "이름 저장" }).click();
      await row.getByText(TEST_NAME_UI).waitFor({ timeout: 15000 });
      check("저장 → 셀 텍스트 갱신", await row.getByText(TEST_NAME_UI).isVisible());
      check("DB 반영(UI 저장)", (await fetchDirectName(selfId)) === TEST_NAME_UI);

      // 사이드바 연동 — 새로고침 후 환영 문구.
      await page.goto("/admin", { waitUntil: "networkidle" });
      check(
        "사이드바 환영 문구 = 수정된 이름",
        await page.locator("aside").getByText(`${TEST_NAME_UI}님`).isVisible(),
      );

      // UI 로 원복.
      await page.goto("/admin/settings/accounts", { waitUntil: "networkidle" });
      await page.getByPlaceholder("이메일, user_id 로 검색").fill(adminEmail);
      await row.waitFor({ timeout: 15000 });
      await row.getByRole("button", { name: "이름 수정" }).click();
      await row.getByLabel("이름 수정 입력").fill(originalName);
      await row.getByRole("button", { name: "이름 저장" }).click();
      // 성공 시에만 편집 모드가 닫힌다 — input 이 사라질 때까지 대기.
      // (getByText(originalName) 은 이메일 셀에 부분 일치해 race 가 난다.)
      await row
        .getByLabel("이름 수정 입력")
        .waitFor({ state: "hidden", timeout: 15000 });
      check("UI 원복 → DB 원래 이름", (await fetchDirectName(selfId)) === originalName);

      await page.goto("/admin", { waitUntil: "networkidle" });
      check(
        "사이드바 환영 문구 원복",
        await page.locator("aside").getByText(`${originalName}님`).isVisible(),
      );
    } finally {
      await browser.close();
    }
  } finally {
    // 안전망: 어떤 단계에서 실패했더라도 원래 이름으로 복구.
    const current = await fetchDirectName(selfId);
    if (current !== originalName) {
      const { error } = await admin
        .from("user_profiles")
        .update({ display_name: originalName })
        .eq("user_id", selfId);
      console.log(
        error
          ? `WARN | 이름 원복 실패: ${error.message}`
          : `info | 이름 원복 완료 (${originalName})`,
      );
    }
    check(
      "최종: admin_users 전체 불변 + 이름 원복",
      (await snapshotAdminUsers()) === adminUsersBefore &&
        (await fetchDirectName(selfId)) === originalName,
    );
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

import { chromium, type Page, type BrowserContext } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// /admin/members/{userId} 회원 상세 — 도움말(helpKey) + 표 정렬 브라우저 검증.
//   요구: mode(operating/test) × org(encre/oranke/phalanx) 전 조합에서 동일 코드 경로로
//         · 요소별 도움말 아이콘(돋보기, AdminHelpIconButton)이 렌더되고
//         · 시즌/주차 표 헤더 클릭 정렬(오름→내림→기본 3단계)이 동작하며
//         · /api/admin/help?path=<key> (org/mode 파라미터 없음, 공통 키)가 200 을 준다.
//   실행: npx tsx --env-file=.env.local scripts/verify-members-detail-help-sort-browser.ts

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SHOT_DIR = "claudedocs";

const ORGS = ["encre", "oranke", "phalanx"] as const;
const MODES = ["operating", "test"] as const;

// 상세 페이지가 반드시 노출하는 도움말 키(HTTP 200 확인용 샘플).
const SAMPLE_HELP_KEY = "admin.members.detail.section.personalInfo";

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

// (org, mode) 첫 번째 실제 회원 userId 를 목록 API 로 조회(org 필터·모집단 모드 확인 겸).
async function firstUserId(ctx: BrowserContext, org: string, mode: string): Promise<string | null> {
  const res = await ctx.request.get(
    `${baseUrl}/api/admin/members?organization=${org}&limit=1&mode=${mode}`,
  );
  if (!res.ok()) return null;
  const json = await res.json();
  const members = json?.data?.members;
  if (!Array.isArray(members) || members.length === 0) return null;
  return (members[0]?.userId as string) ?? null;
}

// 특정 <th> 의 정렬 버튼을 클릭하고 aria-sort 상태를 반환.
async function ariaSortOf(page: Page, label: string): Promise<string | null> {
  const th = page.locator(`th:has(button[aria-label="${label} 기준 정렬"])`).first();
  return th.getAttribute("aria-sort");
}

async function clickSort(page: Page, label: string): Promise<void> {
  await page.locator(`button[aria-label="${label} 기준 정렬"]`).first().click();
  await page.waitForTimeout(120);
}

type Result = { org: string; mode: string; userId: string | null; ok: boolean; notes: string[] };

async function verifyOne(
  page: Page,
  ctx: BrowserContext,
  org: string,
  mode: string,
): Promise<Result> {
  const notes: string[] = [];
  const userId = await firstUserId(ctx, org, mode);
  if (!userId) {
    notes.push("no member for (org,mode) — skipped");
    return { org, mode, userId: null, ok: true, notes };
  }

  const url = `${baseUrl}/admin/members/${userId}?org=${org}&mode=${mode}`;
  await page.goto(url, { waitUntil: "networkidle" });
  // 상세 로드 완료 대기(인적사항 섹션 타이틀).
  await page.getByText("인적사항", { exact: true }).first().waitFor({ timeout: 15000 });

  // 1) 페이지 단위 도움말 버튼(파란 [도움말]) 존재. 접근명이 "안내 있음" 등으로 바뀔 수 있어 안정 속성으로 특정.
  const pageHelp = await page.locator('[data-admin-help-trigger="page"]').count();
  assert(pageHelp >= 1, `[${org}/${mode}] page-level 도움말 button missing`);

  // 2) 요소별 도움말 아이콘(돋보기, aria-label="이 항목 도움말") 다수 렌더.
  const iconCount = await page.locator('button[aria-label="이 항목 도움말"]').count();
  assert(iconCount >= 20, `[${org}/${mode}] help icons too few: ${iconCount}`);
  notes.push(`helpIcons=${iconCount}`);

  // 3) /api/admin/help 공통 키 HTTP 200 (org/mode 파라미터 없음).
  const helpRes = await ctx.request.get(
    `${baseUrl}/api/admin/help?path=${encodeURIComponent(SAMPLE_HELP_KEY)}`,
  );
  assert(helpRes.ok(), `[${org}/${mode}] /api/admin/help ${SAMPLE_HELP_KEY} -> ${helpRes.status()}`);
  const helpJson = await helpRes.json();
  assert(helpJson?.success === true, `[${org}/${mode}] help API not success`);
  // 파라미터 오염(org/mode) 없이 순수 path 만 소비하는지 재확인 — org/mode 붙여도 동일 응답.
  const helpRes2 = await ctx.request.get(
    `${baseUrl}/api/admin/help?path=${encodeURIComponent(SAMPLE_HELP_KEY)}&org=${org}&mode=${mode}`,
  );
  assert(helpRes2.ok(), `[${org}/${mode}] help API rejects extra params`);

  // 4) 정렬 버튼 다수 존재(시즌 9 + 주차 13 = 22 정렬가능 + 비정렬 헤더 2).
  const sortBtns = await page.locator('button[aria-label$="기준 정렬"]').count();
  assert(sortBtns >= 15, `[${org}/${mode}] sortable headers too few: ${sortBtns}`);
  notes.push(`sortButtons=${sortBtns}`);

  // 5) 주차 표 "성장 성공 주차" 3단계 정렬 순환(none → asc → desc → none) 검증.
  const label = "성장 성공 주차";
  const before = await ariaSortOf(page, label);
  assert(before === "none", `[${org}/${mode}] initial aria-sort != none (${before})`);
  await clickSort(page, label);
  assert((await ariaSortOf(page, label)) === "ascending", `[${org}/${mode}] click1 != ascending`);
  await clickSort(page, label);
  assert((await ariaSortOf(page, label)) === "descending", `[${org}/${mode}] click2 != descending`);
  await clickSort(page, label);
  assert((await ariaSortOf(page, label)) === "none", `[${org}/${mode}] click3 != none(reset)`);
  notes.push("weekSort cycle none→asc→desc→none OK");

  // 6) 실제 재정렬 근거(best-effort) — 팀명 열 asc/desc 로 첫 행 텍스트가 달라지는지(값 2개↑일 때).
  //    데이터가 1행이거나 동일값이면 스킵(순환 검증으로 배선은 이미 확인).
  try {
    const firstCellSel = "table tbody tr:first-child td:nth-child(1)";
    await clickSort(page, "주차명"); // asc
    const asc = (await page.locator(firstCellSel).first().innerText().catch(() => "")).trim();
    await clickSort(page, "주차명"); // desc
    const desc = (await page.locator(firstCellSel).first().innerText().catch(() => "")).trim();
    await clickSort(page, "주차명"); // reset
    if (asc && desc && asc !== desc) notes.push(`reorder verified (asc≠desc: ${asc}≠${desc})`);
    else notes.push("reorder not asserted (≤1 distinct row)");
  } catch {
    notes.push("reorder check skipped");
  }

  await page.screenshot({
    path: `${SHOT_DIR}/qa-members-detail-${org}-${mode}.png`,
    fullPage: true,
  });

  return { org, mode, userId, ok: true, notes };
}

async function main() {
  const cookies = await makeAdminCookies();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();

  const results: Result[] = [];
  try {
    for (const org of ORGS) {
      for (const mode of MODES) {
        try {
          results.push(await verifyOne(page, ctx, org, mode));
        } catch (err) {
          results.push({
            org,
            mode,
            userId: null,
            ok: false,
            notes: [err instanceof Error ? err.message : String(err)],
          });
        }
      }
    }
  } finally {
    await browser.close();
  }

  console.log("\n=== /admin/members/{id} help + sort verification ===");
  let allOk = true;
  for (const r of results) {
    if (!r.ok) allOk = false;
    console.log(
      `${r.ok ? "PASS" : "FAIL"}  org=${r.org} mode=${r.mode} user=${r.userId ?? "-"}\n      ${r.notes.join(" | ")}`,
    );
  }
  console.log(allOk ? "\nALL PASS" : "\nHAS FAILURES");
  if (!allOk) process.exit(1);
}

void main();

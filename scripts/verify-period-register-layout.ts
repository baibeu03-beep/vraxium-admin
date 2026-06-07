/**
 * 기간 등록 — 레이아웃 개편 브라우저 검증 (Playwright).
 *   1) 1행: 입력 필드 6개(기간선택.1/.2·연도·시즌·주차·활동)가 같은 줄(y 동일)
 *   2) 2행: 비고 단독(라벨+넓은 input, 1행보다 아래·input 폭이 카드 폭 수준)
 *   3) 3행: 등록/취소 버튼 우측 정렬(비고보다 아래·카드 우측 끝)
 *   4) 기능 회귀: 2022 봄 W1 등록 → 성공 메시지 (로직 무수정 확인, 종료 후 cleanup 필요)
 * 사전조건: admin dev :3000.
 * Usage: npx tsx --env-file=.env.local scripts/verify-period-register-layout.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const adminBase = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

function ensureEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function makeAdminCookies(): Promise<Array<{ name: string; value: string }>> {
  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const admin = createClient(supabaseUrl, ensureEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const browser = createClient(supabaseUrl, anonKey);
  const { data: linkData, error: linkError } =
    await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  if (linkError || !linkData?.properties?.email_otp)
    throw new Error(linkError?.message ?? "generateLink failed");
  const { data: verifyData, error: verifyError } = await browser.auth.verifyOtp({
    email: adminEmail,
    token: linkData.properties.email_otp,
    type: "magiclink",
  });
  if (verifyError || !verifyData.session)
    throw new Error(verifyError?.message ?? "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [],
      setAll: (items) =>
        void captured.push(...items.map((i) => ({ name: i.name, value: i.value }))),
    },
  });
  const { error } = await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  if (error) throw new Error(error.message);
  return captured;
}

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

const FIELD_LABELS = [
  "기간 선택.1",
  "기간 선택.2",
  "연도 선택",
  "시즌 선택",
  "주차 선택",
  "활동 선택",
] as const;

async function main() {
  const browser = await chromium.launch({ channel: "chromium" });
  const cookies = await makeAdminCookies();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addCookies(
    cookies.map((k) => ({ ...k, domain: new URL(adminBase).hostname, path: "/" })),
  );
  const page = await ctx.newPage();
  await page.goto(`${adminBase}/admin/periods/register`, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await page.getByText("기간 선택.1", { exact: true }).waitFor({ timeout: 30000 });

  console.log("=== 1) 1행: 입력 필드 6개 동일 라인 ===");
  const fieldBox = async (label: string) => {
    const field = page
      .locator("div.flex.flex-col", { hasText: label })
      .filter({ has: page.locator('[data-slot="select-trigger"]') })
      .last();
    const box = await field.locator('[data-slot="select-trigger"]').boundingBox();
    if (!box) throw new Error(`${label} boundingBox 실패`);
    return box;
  };
  const boxes: Record<string, { x: number; y: number; width: number; height: number }> = {};
  for (const label of FIELD_LABELS) boxes[label] = await fieldBox(label);
  const ys = FIELD_LABELS.map((l) => Math.round(boxes[l].y));
  const sameRow = ys.every((y) => Math.abs(y - ys[0]) <= 2);
  check("6개 트리거 y 좌표 동일(한 줄)", sameRow, ys.join(", "));
  const xs = FIELD_LABELS.map((l) => Math.round(boxes[l].x));
  const ordered = xs.every((x, i) => i === 0 || x > xs[i - 1]);
  check("좌→우 순서 = 명세 순서", ordered, xs.join(", "));

  console.log("\n=== 2) 2행: 비고 단독·넓은 input ===");
  const noteInput = page.getByPlaceholder("예: 설 연휴 휴식");
  const noteBox = await noteInput.boundingBox();
  if (!noteBox) throw new Error("비고 input boundingBox 실패");
  check("비고가 1행 아래", noteBox.y > ys[0] + boxes[FIELD_LABELS[0]].height, `y=${Math.round(noteBox.y)}`);
  const noteLabel = await page.getByText("비고", { exact: true }).count();
  check("비고 label 존재", noteLabel >= 1);
  // 카드 내용 폭 대비 비고 input 폭 — 단독 행(넓게)
  const card = page.locator('[data-slot="select-trigger"]').first().locator("xpath=ancestor::div[contains(@class,'flex-col')][last()]");
  const row1Right = Math.max(...FIELD_LABELS.map((l) => boxes[l].x + boxes[l].width));
  check("비고 input 폭이 1행 전체 폭 이상(단독 넓게)", noteBox.width >= row1Right - boxes[FIELD_LABELS[0]].x - 2, `input=${Math.round(noteBox.width)}px, 1행=${Math.round(row1Right - boxes[FIELD_LABELS[0]].x)}px`);

  console.log("\n=== 3) 3행: 등록/취소 우측 ===");
  const registerBtn = page.getByRole("button", { name: "등록", exact: true });
  const cancelBtn = page.getByRole("button", { name: "취소", exact: true });
  const rBox = await registerBtn.boundingBox();
  const cBox = await cancelBtn.boundingBox();
  if (!rBox || !cBox) throw new Error("버튼 boundingBox 실패");
  check("버튼이 비고 아래(3행)", rBox.y > noteBox.y + noteBox.height, `y=${Math.round(rBox.y)}`);
  check("등록 → 취소 순서", rBox.x < cBox.x);
  const noteRight = noteBox.x + noteBox.width;
  check("취소 버튼 우측 끝 정렬(±4px)", Math.abs(cBox.x + cBox.width - noteRight) <= 4, `버튼 우측=${Math.round(cBox.x + cBox.width)}, 비고 우측=${Math.round(noteRight)}`);
  await page.screenshot({ path: "claudedocs/browser-period-register-layout.png" });

  console.log("\n=== 4) 기능 회귀: 등록 동작 ===");
  const pick = async (label: string, optionText: string) => {
    const field = page
      .locator("div.flex.flex-col", { hasText: label })
      .filter({ has: page.locator('[data-slot="select-trigger"]') })
      .last();
    await field.locator('[data-slot="select-trigger"]').click();
    const option = page.getByRole("option", { name: optionText, exact: true });
    await option.waitFor({ state: "visible", timeout: 10000 });
    await option.click();
  };
  await pick("기간 선택.1", "2022년");
  await pick("기간 선택.2", "22. 03. 07. (월) ~ 22. 03. 13. (일)");
  await pick("연도 선택", "2022년");
  await pick("시즌 선택", "봄");
  await pick("주차 선택", "1주차");
  await pick("활동 선택", "공식 활동");
  await noteInput.fill("레이아웃 검증");
  await registerBtn.click();
  await page.getByText("가 등록되었습니다.").waitFor({ timeout: 30000 });
  check("등록 성공 메시지(기능 회귀 통과)", true);
  await page.screenshot({ path: "claudedocs/browser-period-register-layout-success.png" });

  await page.close();
  await ctx.close();
  await browser.close();
  console.log(`\n결과: ${failures === 0 ? "전부 통과" : `실패 ${failures}건`}`);
  process.exit(failures ? 1 : 0);
}

void main();

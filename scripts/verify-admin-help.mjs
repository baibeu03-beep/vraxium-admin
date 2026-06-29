// 검증 — 어드민 전역 [도움말] 버튼 + "관련 도움말" 팝업.
//   읽기 전용(저장 시도는 테이블 미생성 시 503 안내 확인용). 스크린샷 claudedocs/help-*.png.
//   사전조건: admin dev :3000.  실행: node scripts/verify-admin-help.mjs
//   ※ admin_page_help_contents 테이블 적용 전이면 저장은 503(안내) — 적용 후엔 SAVE_TABLE_READY=1 로 재실행.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const requireAdmin = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = requireAdmin("@supabase/supabase-js");
const { createServerClient } = requireAdmin("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const SUPABASE_URL = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const TABLE_READY = process.env.SAVE_TABLE_READY === "1";

async function makeAdminCookies() {
  const admin = createClient(SUPABASE_URL, SERVICE);
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: ld } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: vd } = await browser.auth.verifyOtp({ email: adminEmail, token: ld.properties.email_otp, type: "magiclink" });
  const captured = [];
  const sv = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (it) => captured.push(...it.map((i) => ({ name: i.name, value: i.value }))) } });
  await sv.auth.setSession({ access_token: vd.session.access_token, refresh_token: vd.session.refresh_token });
  return captured;
}

let failures = 0;
function check(label, ok, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function openHelp(page) {
  await page.locator("main button", { hasText: "도움말" }).first().click();
  await page.waitForSelector('[role="dialog"][aria-label="관련 도움말"]', { timeout: 8000 });
  await page.waitForTimeout(800);
}

async function main() {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    const cookies = await makeAdminCookies();
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await ctx.addCookies(cookies.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" })));
    const page = await ctx.newPage();

    // 1) 여러 페이지에서 [도움말] 버튼 노출 + 레이아웃 무결성
    console.log("\n[1] 여러 페이지에서 [도움말] 버튼 + 레이아웃");
    for (const url of ["/admin/members", "/admin/season-participations", "/admin/settings/accounts"]) {
      await page.goto(`${BASE}${url}`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(2000);
      const st = await page.evaluate(() => ({
        helpBtn: [...document.querySelectorAll("main button")].some((b) => /도움말/.test(b.textContent || "")),
        hasSidebar: !!document.querySelector("aside"),
        hasHeader: !!document.querySelector("header"),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }));
      check(`${url}: [도움말] 버튼 노출`, st.helpBtn);
      check(`${url}: 사이드바/헤더 유지 + 오버플로 0`, st.hasSidebar && st.hasHeader && st.overflow <= 2, `overflow=${st.overflow}`);
    }

    // 2) 팝업 구조: 제목 "관련 도움말" + [편집][저장][X]
    console.log("\n[2] 팝업 구조 + 기본 읽기");
    await page.goto(`${BASE}/admin/members`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1500);
    await openHelp(page);
    const dlg = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"][aria-label="관련 도움말"]');
      const txt = d?.textContent || "";
      const btns = [...d.querySelectorAll("button")].map((b) => (b.textContent || "").trim() || b.getAttribute("aria-label"));
      const ta = d.querySelector("textarea");
      return { title: /관련 도움말/.test(txt), hasEdit: btns.some((t) => /편집/.test(t)), hasSave: btns.some((t) => /저장/.test(t)), hasClose: btns.some((t) => /닫기|^$/.test(t)) || !!d.querySelector('[aria-label="닫기"]'), pathShown: /\/admin\/members/.test(txt), editingNow: !!ta };
    });
    check("제목 '관련 도움말' 표시", dlg.title);
    check("[편집] 버튼 존재", dlg.hasEdit);
    check("[저장] 버튼 존재", dlg.hasSave);
    check("[X] 닫기 버튼 존재", dlg.hasClose);
    check("페이지 경로 표시(/admin/members)", dlg.pathShown);
    check("기본 상태=읽기(텍스트박스 아님)", !dlg.editingNow);
    await page.screenshot({ path: "claudedocs/help-members-readonly.png" });

    // 3) [편집] → textarea 전환
    console.log("\n[3] [편집] → 텍스트박스 전환");
    await page.locator('[role="dialog"] button', { hasText: "편집" }).click();
    await page.waitForTimeout(600);
    const editing = await page.evaluate(() => !!document.querySelector('[role="dialog"] textarea'));
    check("편집 클릭 시 textarea 노출", editing);
    await page.screenshot({ path: "claudedocs/help-members-editing.png" });

    // 4) 내용 입력 후 저장
    console.log("\n[4] 내용 입력 후 [저장]");
    const sample = `크루 관리 페이지 도움말\n- 검증 ${Date.now()}\n- 클럽/필터 후 [확인]`;
    await page.locator('[role="dialog"] textarea').fill(sample);
    await page.locator('[role="dialog"] button', { hasText: "저장" }).click();
    await page.waitForTimeout(2500);
    const afterSave = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]');
      const txt = d?.textContent || "";
      return { stillEditing: !!d.querySelector("textarea"), bodyText: txt, hasErr: /테이블이 아직 생성|저장하지 못|실패/.test(txt) };
    });
    if (TABLE_READY) {
      check("저장 후 읽기 모드 복귀 + 내용 반영", !afterSave.stillEditing && afterSave.bodyText.includes("검증"), `editing=${afterSave.stillEditing}`);
      // 5) 닫았다 다시 열기 → 유지
      console.log("\n[5] 닫기 후 재열기 → 내용 유지");
      await page.locator('[role="dialog"] [aria-label="닫기"]').click();
      await page.waitForTimeout(500);
      await openHelp(page);
      const reopened = await page.evaluate(() => document.querySelector('[role="dialog"]')?.textContent || "");
      check("재열기 시 저장 내용 유지", reopened.includes("검증"));
      // 6) 다른 페이지 → 다른(빈) 도움말
      console.log("\n[6] 다른 페이지 → 다른 도움말");
      await page.locator('[role="dialog"] [aria-label="닫기"]').click();
      await page.goto(`${BASE}/admin/season-participations`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(1500);
      await openHelp(page);
      const other = await page.evaluate(() => document.querySelector('[role="dialog"]')?.textContent || "");
      check("다른 페이지는 위 내용 미표시", !other.includes("검증"));
      await page.locator('[role="dialog"] [aria-label="닫기"]').click();
      // 7) 새로고침 후 유지
      console.log("\n[7] 새로고침 후 유지");
      await page.goto(`${BASE}/admin/members`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(1500);
      await openHelp(page);
      const afterReload = await page.evaluate(() => document.querySelector('[role="dialog"]')?.textContent || "");
      check("새로고침 후에도 저장 내용 유지", afterReload.includes("검증"));
      await page.screenshot({ path: "claudedocs/help-members-saved.png" });
      // 정리: 검증으로 남긴 /admin/members 샘플 도움말을 빈 값으로 초기화(프로덕션 DB 청결 유지).
      await page.evaluate(() =>
        fetch("/api/admin/help", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: "/admin/members", content: "" }),
        }).then((r) => r.json()),
      );
      console.log("    (정리) /admin/members 샘플 도움말 초기화 완료");
    } else {
      // 테이블 미적용: 저장은 503 안내가 떠야 함(배선/에러표시 검증).
      check("테이블 미적용 시 저장 실패 안내 노출(503)", afterSave.hasErr, afterSave.bodyText.slice(0, 80));
      console.log("    (SAVE_TABLE_READY=1 로 마이그레이션 적용 후 재실행하면 4~7 영속성까지 검증)");
      await page.screenshot({ path: "claudedocs/help-members-save-pretable.png" });
    }

    // 닫기 동작
    console.log("\n[8] [X] 닫기");
    const closeBtn = page.locator('[role="dialog"] [aria-label="닫기"]');
    if (await closeBtn.count()) {
      await closeBtn.click();
      await page.waitForTimeout(500);
    }
    const closed = await page.evaluate(() => !document.querySelector('[role="dialog"][aria-label="관련 도움말"]'));
    check("[X] 클릭 시 팝업 닫힘", closed);

    await ctx.close();
  } finally {
    await browser.close();
  }
  console.log(`\n${failures === 0 ? "✓ 전체 통과" : `✗ 실패 ${failures}건`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

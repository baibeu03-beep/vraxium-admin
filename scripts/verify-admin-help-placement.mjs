// 검증 — [도움말] 버튼이 각 페이지 제목 행 우측으로 이동(헤더에서 제거).
//   각 라우트: 헤더 도움말 없음 · 페이지 도움말 정확히 1개 · 제목(h1/h2) 근처 · 가로 오버플로 0.
//   추가: /admin/members 모달 편집/저장 동작(canEdit GET 수신) 라운드트립 후 정리.
//   실행: node scripts/verify-admin-help-placement.mjs
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
const supabaseAdmin = createClient(SUPABASE_URL, SERVICE);

async function makeCookies() {
  const br = createClient(SUPABASE_URL, ANON);
  const { data: ld } = await supabaseAdmin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: vd } = await br.auth.verifyOtp({ email: adminEmail, token: ld.properties.email_otp, type: "magiclink" });
  const cap = [];
  const sv = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (it) => cap.push(...it) } });
  await sv.auth.setSession({ access_token: vd.session.access_token, refresh_token: vd.session.refresh_token });
  return cap;
}

let failures = 0;
const check = (label, ok, detail = "") => { if (!ok) failures++; console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); };

const ROUTES = [
  "/admin/members",
  "/admin/season-participations",
  "/admin/season-weeks",
  "/admin/weekly-card-finalization",
  "/admin/official-rest-periods",
  "/admin/periods/register",
  "/admin/processes/check/irregular",
  "/admin/settings/line-opening-windows",
  "/admin/line-opening/practical-career",
  "/admin/test-users",
  "/admin/settings/accounts",
  "/admin/settings/permissions",
  "/admin/week-recognitions",
  "/admin/settings/edit-windows",
  "/admin/operation-health-check",
  "/admin/line-opening/practical-info",
  // /admin/processes/check 는 미구현 stub("추후 구현 예정")이라 제목/도움말 대상 아님 — 제외.
];

async function main() {
  const cookies = await makeCookies();
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await ctx.addCookies(cookies.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" })));
    const page = await ctx.newPage();

    console.log("\n[1] 라우트별 배치 검증 (헤더없음 · 1개 · 제목근처 · 오버플로0)");
    for (const url of ROUTES) {
      await page.goto(`${BASE}${url}`, { waitUntil: "domcontentloaded", timeout: 60000 });
      // 느리게 로드되는 페이지(데이터 패칭)도 제목이 뜰 때까지 대기 후 판정.
      await page.waitForSelector("main h1, main h2", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1200);
      const r = await page.evaluate(() => {
        const isHelp = (b) => /도움말/.test(b.textContent || "");
        const headerHelp = [...document.querySelectorAll("header button")].some(isHelp);
        const helpBtns = [...document.querySelectorAll("main button, main a")].filter(isHelp)
          .concat([...document.querySelectorAll("button")].filter(isHelp).filter((b) => !b.closest("header") && !b.closest("main")));
        const allHelp = [...document.querySelectorAll("button")].filter(isHelp).filter((b) => !b.closest("header"));
        const titleEl = document.querySelector("main h1, main h2");
        let nearTitle = false;
        if (titleEl && allHelp.length) {
          // 제목과 도움말이 4단계 이내 공통 조상 공유 = 같은 제목 행
          let n = titleEl.parentElement;
          for (let i = 0; i < 4 && n; i++, n = n.parentElement) {
            if ([...n.querySelectorAll("button")].some(isHelp)) { nearTitle = true; break; }
          }
        }
        const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
        return { headerHelp, count: allHelp.length, nearTitle, overflow, title: titleEl?.textContent?.trim()?.slice(0, 20) ?? "(no title)" };
      });
      const ok = !r.headerHelp && r.count === 1 && r.nearTitle && r.overflow <= 2;
      check(`${url} [${r.title}]`, ok, `header=${r.headerHelp} count=${r.count} nearTitle=${r.nearTitle} overflow=${r.overflow}`);
    }

    console.log("\n[2] 모달 기능 동작(편집/저장, canEdit GET 수신) — /admin/members");
    await page.goto(`${BASE}/admin/members`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1500);
    await page.locator("main button", { hasText: "도움말" }).first().click();
    await page.waitForSelector('[role="dialog"][aria-label="관련 도움말"]', { timeout: 8000 });
    await page.waitForTimeout(900);
    const hasEditSave = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]');
      const btns = [...d.querySelectorAll("button")].map((b) => (b.textContent || "").trim());
      return { edit: btns.some((t) => /편집/.test(t)), save: btns.some((t) => /저장/.test(t)) };
    });
    check("편집/저장 버튼 노출(쓰기 권한 GET 수신)", hasEditSave.edit && hasEditSave.save, JSON.stringify(hasEditSave));
    await page.locator('[role="dialog"] button', { hasText: "편집" }).click();
    await page.waitForTimeout(400);
    const sample = `배치검증 ${Date.now()}`;
    await page.locator('[role="dialog"] textarea').fill(sample);
    await page.locator('[role="dialog"] button', { hasText: "저장" }).click();
    await page.waitForTimeout(2000);
    const saved = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]');
      return { editing: !!d.querySelector("textarea"), body: d.textContent || "" };
    });
    check("저장 후 읽기 복귀 + 내용 반영", !saved.editing && saved.body.includes("배치검증"));
    await page.screenshot({ path: "claudedocs/help-placement-modal.png" });

    console.log("\n[정리] /admin/members 샘플 도움말 삭제");
    await supabaseAdmin.from("admin_page_help_contents").delete().eq("page_path", "/admin/members");
    const { count } = await supabaseAdmin.from("admin_page_help_contents").select("id", { count: "exact", head: true });
    check("정리 후 도움말 테이블 0행", (count ?? 0) === 0, `rows=${count}`);

    await ctx.close();
  } finally {
    await browser.close();
  }
  console.log(`\n${failures === 0 ? "✓ 전체 통과" : `✗ 실패 ${failures}건`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

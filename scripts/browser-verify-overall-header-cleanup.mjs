// 브라우저 검증 — 팀 총괄 보드 파트 그룹 헤더 제거 + 파트장 입력 카드 헤더 제거.
//   /admin/line-opening/practical-experience?org=oranke&tab=open
//   (1) "파트장 입력" 카드 제목/설명 제거 — 페이지에 해당 텍스트 없음.
//   (2) 팀 총괄 진입 시 파트 그룹 헤더("미신청 (기본값)"/"신청 완료" 배지) 제거.
//   (3) 파트 구분은 [파트] 컬럼 값으로만 유지(통합 단일 테이블).
//   읽기/표시 전용 — DB/저장/API 무접촉(검수·완료 버튼 클릭 안 함).
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

const ORG = "oranke";

async function makeAdminCookies() {
  const admin = createClient(SUPABASE_URL, SERVICE);
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await browser.auth.verifyOtp({
    email: adminEmail, token: linkData.properties.email_otp, type: "magiclink",
  });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  return captured.map((i) => ({
    name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax",
  }));
}

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1800 } });
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();

try {
  await page.goto(`${BASE}/admin/line-opening/practical-experience?org=${ORG}&tab=open`, { waitUntil: "domcontentloaded" });
  // 입력 그리드 카드 렌더 대기(개설 주차/파트 셀렉트).
  await page.waitForFunction("document.body.innerText.includes('개설 주차') && document.body.innerText.includes('파트')", undefined, { timeout: 60000 });

  // [2-1] "파트장 입력" 카드 제목/설명 제거 확인.
  const bodyInitial = await page.evaluate("document.body.innerText");
  check('[2] "파트장 입력" 제목 제거', !bodyInitial.includes("파트장 입력"));
  check('[2] 설명 문구("평가 대상 크루를 라인별로…") 제거',
    !bodyInitial.includes("평가 대상 크루를 라인별로"));

  // ── 팀 총괄 진입 ── (파트 드롭다운에서 '팀 총괄' = __overall__ 선택)
  const partSelect = page.locator("select", { has: page.locator('option[value="__overall__"]') });
  await partSelect.waitFor({ timeout: 30000 });
  await partSelect.selectOption("__overall__");
  // 보드 렌더 대기(아웃풋 + 버튼 4종).
  await page.waitForFunction("document.body.innerText.includes('아웃풋 링크') && document.body.innerText.includes('개설 검수') && document.body.innerText.includes('개설 완료')", undefined, { timeout: 30000 });
  const board = await page.evaluate("document.body.innerText");

  // [1-1] 파트 그룹 제목/배지 제거.
  check('[1] "미신청 (기본값)" 배지 제거', !board.includes("미신청 (기본값)"));
  check('[1] 파트 그룹 "신청 완료" 배지 제거', !board.includes("신청 완료"));

  // [1-2] 단일 통합 테이블 — 보드 내부 그리드 테이블은 1개.
  //   (행=전 파트 크루, [파트] 컬럼이 파트 구분) — 파트별 별도 테이블이 없어야 한다.
  const boardTableCount = await page.evaluate(`(() => {
    // 카테고리 헤더(도출/분석/견문/관리/확장)를 모두 가진 테이블 = 총괄 그리드.
    const tables = Array.from(document.querySelectorAll('table'));
    return tables.filter((t) => {
      const h = t.querySelector('thead')?.innerText ?? '';
      return ['도출','분석','견문','관리','확장'].every((x) => h.includes(x));
    }).length;
  })()`);
  check("[3] 총괄 그리드 = 단일 통합 테이블", boardTableCount === 1, `grid tables=${boardTableCount}`);

  // [3] [파트] 컬럼 유지 — 헤더에 '파트' 존재 + 데이터행 파트값 비어있지 않음.
  const partColInfo = await page.evaluate(`(() => {
    const tables = Array.from(document.querySelectorAll('table'));
    const grid = tables.find((t) => {
      const h = t.querySelector('thead')?.innerText ?? '';
      return ['도출','분석','견문','관리','확장'].every((x) => h.includes(x));
    });
    if (!grid) return { hasHeader: false, sampleParts: [] };
    const heads = Array.from(grid.querySelectorAll('thead th')).map((th) => th.innerText.trim());
    const partIdx = heads.indexOf('파트');
    const rows = Array.from(grid.querySelectorAll('tbody tr'));
    const sampleParts = rows.slice(0, 5).map((r) => {
      const cells = r.querySelectorAll('td');
      return cells[partIdx]?.innerText?.trim() ?? '';
    });
    return { hasHeader: partIdx >= 0, partIdx, rowCount: rows.length, sampleParts };
  })()`);
  check("[3] [파트] 헤더 컬럼 유지", partColInfo.hasHeader, JSON.stringify(partColInfo.sampleParts));
  check("[3] 파트 컬럼 값 유지(비어있지 않음)",
    partColInfo.rowCount === 0 || partColInfo.sampleParts.some((p) => p && p !== "-"),
    `rows=${partColInfo.rowCount}`);

  // 카테고리 헤더는 그대로(표시 무손상).
  check("[유지] 카테고리 헤더(도출/분석/견문/관리/확장)",
    ["도출", "분석", "견문", "관리", "확장"].every((h) => board.includes(h)));

  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-overall-header-cleanup.png"), fullPage: true });
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
  try { await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-overall-header-cleanup-error.png"), fullPage: true }); } catch {}
} finally {
  await browser.close();
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);

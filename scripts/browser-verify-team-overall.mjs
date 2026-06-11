// 브라우저 검증 — 실무 경험 [팀 총괄] (:3000, 어드민 세션 쿠키 주입).
//   /admin/line-opening/practical-experience?org=oranke&tab=open
//   (5) 팀 총괄 진입(5열 그리드 + 라인별 아웃풋 + 버튼 4종) 렌더.
//   (6) 개설 검수 → 재접속(reload) → "개설 검수 (임시저장)" 배지 복원.
//   (9) 개설 검수 직후 상태창/로그창 refetch(refreshKey 배선) — opening-status/opening-logs GET 증가.
//   review 전용(고객 페이지 무접촉). 검수 헤더는 말미 service-role 삭제(잔여 없음).
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
const TEAM_NAME = "콘텐츠";
const TEAM_ID = "f5c4fad2-0719-4d0d-958c-1988883a674a";

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

const sb = createClient(SUPABASE_URL, SERVICE);
const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1800 } });
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();

// 네트워크 카운터(refresh 배선 검증).
let logGets = 0, statusGets = 0;
page.on("request", (req) => {
  const u = req.url();
  if (u.includes("/experience/opening-logs")) logGets++;
  if (u.includes("/experience/opening-status")) statusGets++;
});

async function selectTeamOverall() {
  // 팀 탭 클릭.
  await page.getByRole("button", { name: TEAM_NAME }).first().click();
  // 파트 드롭다운에서 '팀 총괄 (집계)' 선택(value=__overall__).
  const partSelect = page.locator("select", { has: page.locator("option", { hasText: "팀 총괄 (집계)" }) });
  await partSelect.waitFor({ timeout: 30000 });
  await partSelect.selectOption("__overall__");
}

try {
  // 깨끗한 시작.
  const today = new Date().toISOString().slice(0, 10);

  await page.goto(`${BASE}/admin/line-opening/practical-experience?org=${ORG}&tab=open`, { waitUntil: "domcontentloaded" });
  // 상태창 + 로그창 + 파트장 입력 카드 렌더 대기.
  await page.waitForFunction("document.body.innerText.includes('상태창') && document.body.innerText.includes('로그창') && document.body.innerText.includes('파트장 입력')", undefined, { timeout: 60000 });
  check("[9] 상태창 + 로그창 렌더", true);

  // ── 팀 총괄 진입 ──
  await selectTeamOverall();
  // 보드 렌더 대기(아웃풋 섹션 + 버튼).
  await page.waitForFunction("document.body.innerText.includes('라인별 아웃풋') && document.body.innerText.includes('개설 검수') && document.body.innerText.includes('개설 완료')", undefined, { timeout: 30000 });
  const bodyText = await page.evaluate("document.body.innerText");
  check("[5] 팀 총괄 5열 헤더(도출/분석/견문/관리/확장)",
    ["도출", "분석", "견문", "관리", "확장"].every((h) => bodyText.includes(h)));
  check("[5] 버튼 4종(개설 검수/초기화/개설 완료/개설 취소)",
    ["개설 검수", "초기화", "개설 완료", "개설 취소"].every((b) => bodyText.includes(b)));
  check("[5] 확장 비활성 안내(확장 기간 외 — fail-closed)",
    bodyText.includes("확장 비활성") || bodyText.includes("확장 주간 외"));
  // 개설 취소는 기본 disabled(완료 전).
  const cancelDisabled = await page.getByRole("button", { name: "개설 취소" }).isDisabled();
  check("[5] 개설 취소 기본 disabled", cancelDisabled === true);
  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-team-overall-entry.png"), fullPage: true });

  // ── 개설 검수 → refresh 배선 ──
  const logBefore = logGets, statusBefore = statusGets;
  await page.getByRole("button", { name: "개설 검수" }).click();
  await page.waitForFunction("document.body.innerText.includes('임시 저장') || document.body.innerText.includes('개설 검수 (임시저장)')", undefined, { timeout: 20000 });
  check("[6] 개설 검수 → 성공 배너(임시 저장)", true);
  // refreshKey 증가 → 상태창/로그창 refetch.
  await page.waitForTimeout(1500);
  check("[9] 개설 검수 직후 상태창 refetch(opening-status GET 증가)", statusGets > statusBefore, `before=${statusBefore} after=${statusGets}`);
  check("[9] 개설 검수 직후 로그창 refetch(opening-logs GET 증가)", logGets > logBefore, `before=${logBefore} after=${logGets}`);

  // ── 재접속(reload) → 복원 ──
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction("document.body.innerText.includes('파트장 입력')", undefined, { timeout: 60000 });
  await selectTeamOverall();
  await page.waitForFunction("document.body.innerText.includes('라인별 아웃풋')", undefined, { timeout: 30000 });
  const afterReload = await page.evaluate("document.body.innerText");
  check("[6] 재접속 후 status 배지 '개설 검수 (임시저장)' 복원", afterReload.includes("개설 검수 (임시저장)"));
  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-team-overall-restored.png"), fullPage: true });

  // ── 정리: 검수 헤더 삭제(CASCADE) — 잔여 없음 ──
  const { data: wk } = await sb.from("weeks").select("id").eq("start_date", "2026-06-01").maybeSingle();
  if (wk?.id) {
    await sb.from("cluster4_experience_team_overall").delete().eq("organization_slug", ORG).eq("week_id", wk.id).eq("team_id", TEAM_ID);
  }
  // review 는 고객 라인 생성 안 함 — 단언.
  const { data: residLines } = await sb.from("cluster4_lines").select("id").eq("part_type", "experience").eq("team_id", TEAM_ID).gte("created_at", today + "T00:00:00Z");
  check("[cleanup] review 는 고객 라인 미생성 + 검수 헤더 삭제", (residLines ?? []).length === 0, `created-today lines=${(residLines ?? []).length}`);
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
  try { await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-team-overall-error.png"), fullPage: true }); } catch {}
} finally {
  await browser.close();
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);

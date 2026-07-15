// 브라우저 검증 — 실무 경험 [팀 총괄] 미개설 파트 행 비활성 + 활성 행 장식배경 제거.
//   한 파트만 [개설 신청] seed → 나머지 파트 행은 비활성(muted/opacity/커서), 활성 행은 기본 배경.
//   실행: node scripts/browser-verify-inactive-rows.mjs  (dev :3000 필요)
//   screenshot: claudedocs/browser-inactive-rows.png (claudedocs 는 gitignore).
import { createRequire } from "node:module";
import { readFileSync, mkdirSync } from "node:fs";
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
const TEAM_NAME = "과일(T)";

async function makeAdminCookies() {
  const admin = createClient(SUPABASE_URL, SERVICE);
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const otp = link.properties?.email_otp;
  const { data: verifyData } = await browser.auth.verifyOtp({ email: adminEmail, token: otp, type: "magiclink" });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (items) => captured.push(...items) } });
  await server.auth.setSession({ access_token: verifyData.session.access_token, refresh_token: verifyData.session.refresh_token });
  return captured.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => { console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); ok ? pass++ : fail++; };

const sb = createClient(SUPABASE_URL, SERVICE);
mkdirSync(resolve(adminRoot, "claudedocs"), { recursive: true });

async function teamId() {
  const { data } = await sb.from("cluster4_teams").select("id").eq("organization_slug", ORG).eq("team_name", TEAM_NAME).maybeSingle();
  return data?.id ?? null;
}
async function cleanAll(weekId, tid) {
  await sb.from("cluster4_experience_team_overall").delete().eq("organization_slug", ORG).eq("week_id", weekId).eq("team_id", tid);
  await sb.from("cluster4_experience_part_submissions").delete().eq("organization_slug", ORG).eq("week_id", weekId).eq("team_id", tid);
}

const cookies = await makeAdminCookies();
const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1600 } });
await context.addCookies(cookies);
const page = await context.newPage();
const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

async function gotoBoard() {
  await page.getByRole("button", { name: TEAM_NAME }).first().waitFor({ timeout: 60000 });
}
async function selectTeamOverall() {
  await page.getByRole("button", { name: TEAM_NAME }).first().click();
  const partSelect = page.locator("select", { has: page.locator("option", { hasText: "팀 총괄" }) });
  await partSelect.waitFor({ timeout: 30000 });
  await partSelect.selectOption("__overall__");
  // 팀 총괄 보드에만 있는 '개설 완료' 버튼으로 렌더 확인(파트 입력 뷰와 구분).
  await page.waitForFunction("document.body.innerText.includes('개설 완료') && document.body.innerText.includes('관리')", undefined, { timeout: 30000 });
}

const tid = await teamId();
let weekId = null;
try {
  if (!tid) throw new Error(`${TEAM_NAME} team_id 없음`);

  await page.goto(`${BASE}/admin/line-opening/practical-experience?org=${ORG}&tab=open`, { waitUntil: "domcontentloaded" });
  await gotoBoard();
  await selectTeamOverall();

  // 현재 보드가 조회 중인 개설 주차 id 읽기(seed 대상 주차 일치 보장).
  const weekSelect = page.locator("select", { has: page.locator("option", { hasText: "시즌" }) });
  weekId = await weekSelect.inputValue();
  check("[prep] 개설 주차 id 획득", !!weekId, weekId ?? "");

  // 대상 파트 목록(HTTP GET) → 첫 파트만 [개설 신청] seed(=활성), 나머지 미개설(=비활성).
  const gres = await fetch(`${BASE}/api/admin/cluster4/experience/team-overall?organization=${ORG}&week_id=${weekId}&team_id=${tid}&team_name=${encodeURIComponent(TEAM_NAME)}`, { headers: { cookie: cookieHeader } });
  const gjson = await gres.json();
  const parts = (gjson?.data?.parts ?? []).map((p) => p.partName);
  check("[prep] 대상 파트 ≥2", parts.length >= 2, JSON.stringify(parts));
  if (parts.length < 2) throw new Error("파트 부족");

  await cleanAll(weekId, tid);
  const activePart = parts[0];
  const inactiveParts = parts.slice(1);
  await sb.from("cluster4_experience_part_submissions").upsert(
    { organization_slug: ORG, week_id: weekId, team_id: tid, part_name: activePart, submitted_by: null, submitted_at: new Date().toISOString() },
    { onConflict: "organization_slug,week_id,team_id,part_name" },
  );

  // 반영된 상태로 재조회 — 전체 reload 대신 파트를 실파트로 전환했다가 다시 팀 총괄 선택
  //   → 보드 컴포넌트 remount(신규 GET)로 seed 된 신청 상태를 반영(안정적).
  const partSelect = page.locator("select", { has: page.locator("option", { hasText: "팀 총괄" }) });
  await partSelect.selectOption(activePart);
  await page.waitForTimeout(800);
  await partSelect.selectOption("__overall__");
  await page.waitForFunction("document.body.innerText.includes('개설 완료') && document.body.innerText.includes('관리')", undefined, { timeout: 30000 });
  await page.waitForTimeout(500);

  // 행별 상태 수집: 파트 컬럼 텍스트 + 비활성 title + 컴퓨티드 opacity/cursor.
  const rows = await page.evaluate(() => {
    const trs = Array.from(document.querySelectorAll("table tbody tr"));
    return trs.map((tr) => {
      const tds = tr.querySelectorAll("td");
      const cs = getComputedStyle(tr);
      const firstTd = tds[0] ? getComputedStyle(tds[0]) : null;
      return {
        name: tds[0]?.textContent?.trim() ?? "",
        part: tds[1]?.textContent?.trim() ?? "",
        inactiveTitle: tr.getAttribute("title") ?? "",
        ariaDisabled: tr.getAttribute("aria-disabled") ?? "",
        opacity: cs.opacity,
        cursor: cs.cursor,
        tdBg: firstTd?.backgroundColor ?? "",
      };
    });
  });

  const activeRows = rows.filter((r) => r.part === activePart);
  const inactiveRows = rows.filter((r) => inactiveParts.includes(r.part));
  console.log(`  활성 파트='${activePart}'(${activeRows.length}행) / 미개설 파트=${JSON.stringify(inactiveParts)}(${inactiveRows.length}행)`);

  check("[활성] 활성 파트 행 존재", activeRows.length >= 1);
  check("[활성] 활성 행 opacity=1(정상 명도)", activeRows.every((r) => r.opacity === "1"), activeRows.map((r) => r.opacity).join(","));
  check("[활성] 활성 행 cursor≠not-allowed", activeRows.every((r) => r.cursor !== "not-allowed"), activeRows.map((r) => r.cursor).join(","));
  check("[활성] 활성 행 비활성 title 없음", activeRows.every((r) => !r.inactiveTitle));

  check("[비활성] 미개설 파트 행 존재", inactiveRows.length >= 1);
  check("[비활성] 미개설 행 opacity 감소(≤0.6, <1 — 전역 aria-disabled 플로어)", inactiveRows.every((r) => parseFloat(r.opacity) <= 0.6 && parseFloat(r.opacity) < 1), inactiveRows.map((r) => r.opacity).join(","));
  check("[비활성] 미개설 행 cursor=not-allowed", inactiveRows.every((r) => r.cursor === "not-allowed"), inactiveRows.map((r) => r.cursor).join(","));
  check("[비활성] 미개설 행 muted 배경(td bg ≠ 활성 td bg)", inactiveRows.every((r) => r.tdBg !== activeRows[0]?.tdBg), `active=${activeRows[0]?.tdBg} inactive=${inactiveRows[0]?.tdBg}`);
  check("[비활성] 미개설 행 aria-disabled=true", inactiveRows.every((r) => r.ariaDisabled === "true"));

  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-inactive-rows.png"), fullPage: true });
  console.log("  screenshot → claudedocs/browser-inactive-rows.png");
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
  try { await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-inactive-rows-error.png"), fullPage: true }); } catch {}
} finally {
  if (weekId && tid) await cleanAll(weekId, tid);
  await browser.close();
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);

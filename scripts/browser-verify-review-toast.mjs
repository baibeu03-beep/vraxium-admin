// 브라우저 검증 — 실무 경험 [팀 총괄] 개설 검수: 항상 활성 버튼 + 미신청 시 하단 Toast 안내.
//   버튼은 항상 활성 → 클릭 → 미신청이면 서버 409 차단 + 하단 고정 Toast(경고) 표시(상태/스냅샷 무변경).
//   전 파트 신청 후 같은 버튼 재클릭 → Toast 없이 정상 검수(status=reviewed).
//   실행: node scripts/browser-verify-review-toast.mjs  (dev :3000 필요)
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
const INCOMPLETE_MSG = "아직 모든 파트의 [개설 신청]이 완료되지 않았습니다.";
// operating 뷰에 노출되는 실파트 보유 팀들(디폴트 operating 모드에서 렌더).
const TEAMS = ["음료(T)", "과일(T)"];

async function makeAdminCookies() {
  const admin = createClient(SUPABASE_URL, SERVICE);
  const b = createClient(SUPABASE_URL, ANON);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: v } = await b.auth.verifyOtp({ email: adminEmail, token: link.properties?.email_otp, type: "magiclink" });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (i) => captured.push(...i) } });
  await server.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return captured.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}

let pass = 0, fail = 0;
const check = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };
const sb = createClient(SUPABASE_URL, SERVICE);
mkdirSync(resolve(adminRoot, "claudedocs"), { recursive: true });

const cookies = await makeAdminCookies();
const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1400 } });
await context.addCookies(cookies);
const page = await context.newPage();

async function teamId(name) {
  const { data } = await sb.from("cluster4_teams").select("id").eq("organization_slug", ORG).eq("team_name", name).maybeSingle();
  return data?.id ?? null;
}
async function cleanAll(weekId, tid) {
  await sb.from("cluster4_experience_team_overall").delete().eq("organization_slug", ORG).eq("week_id", weekId).eq("team_id", tid);
  await sb.from("cluster4_experience_part_submissions").delete().eq("organization_slug", ORG).eq("week_id", weekId).eq("team_id", tid);
}
async function seedApply(weekId, tid, part) {
  await sb.from("cluster4_experience_part_submissions").upsert(
    { organization_slug: ORG, week_id: weekId, team_id: tid, part_name: part, submitted_by: null, submitted_at: new Date().toISOString() },
    { onConflict: "organization_slug,week_id,team_id,part_name" });
}
async function overallCount(weekId, tid) {
  const { count } = await sb.from("cluster4_experience_team_overall").select("*", { count: "exact", head: true }).eq("week_id", weekId).eq("team_id", tid);
  return count ?? 0;
}
async function overallStatus(weekId, tid) {
  const { data } = await sb.from("cluster4_experience_team_overall").select("status").eq("week_id", weekId).eq("team_id", tid).maybeSingle();
  return data?.status ?? null;
}
async function selectTeamOverall(teamName) {
  await page.getByRole("button", { name: teamName }).first().waitFor({ timeout: 60000 });
  await page.getByRole("button", { name: teamName }).first().click();
  const partSelect = page.locator("select", { has: page.locator("option", { hasText: "팀 총괄" }) });
  await partSelect.waitFor({ timeout: 30000 });
  await partSelect.selectOption("__overall__");
  await page.waitForFunction("document.body.innerText.includes('개설 완료') && document.body.innerText.includes('관리')", undefined, { timeout: 30000 });
}
async function toastText(needle, timeout = 10000) {
  await page.waitForFunction((n) => Array.from(document.querySelectorAll('[role="status"],[role="alert"]')).some((e) => (e.textContent || "").includes(n)), needle, { timeout });
  return page.evaluate((n) => {
    const el = Array.from(document.querySelectorAll('[role="status"],[role="alert"]')).find((e) => (e.textContent || "").includes(n));
    return el ? el.textContent : "";
  }, needle);
}

let weekId = null;
try {
  await page.goto(`${BASE}/admin/line-opening/practical-experience?org=${ORG}&tab=open`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: TEAMS[0] }).first().waitFor({ timeout: 60000 });
  await selectTeamOverall(TEAMS[0]);
  weekId = await page.locator("select", { has: page.locator("option", { hasText: "시즌" }) }).inputValue();
  console.log(`대상 주차 = ${weekId}`);

  for (const teamName of TEAMS) {
    console.log(`\n=== [operating] ${teamName} ===`);
    const tid = await teamId(teamName);
    await cleanAll(weekId, tid);
    await selectTeamOverall(teamName); // 해당 팀 탭 + 팀 총괄 진입.

    // 대상 파트 파악 후 첫 파트만 신청(부분 미신청 상태).
    const g = await fetch(`${BASE}/api/admin/cluster4/experience/team-overall?organization=${ORG}&week_id=${weekId}&team_id=${tid}&team_name=${encodeURIComponent(teamName)}`, { headers: { cookie: cookieHeader } });
    const parts = ((await g.json())?.data?.parts ?? []).map((p) => p.partName);
    if (parts.length < 2) { check(`[${teamName}] 대상 파트 ≥2`, false, JSON.stringify(parts)); continue; }
    await seedApply(weekId, tid, parts[0]);
    const unapplied = parts.slice(1);

    // 보드 재조회(remount) — seed 반영.
    const partSel = page.locator("select", { has: page.locator("option", { hasText: "팀 총괄" }) });
    await partSel.selectOption(parts[0]); await page.waitForTimeout(600);
    await partSel.selectOption("__overall__");
    await page.waitForFunction("document.body.innerText.includes('개설 완료')", undefined, { timeout: 30000 });

    // (1) 버튼 항상 활성.
    const disabled = await page.getByRole("button", { name: "개설 검수" }).isDisabled();
    check(`[${teamName}] (1)미신청 상태에서 개설 검수 버튼 활성`, disabled === false);

    const before = await overallCount(weekId, tid);
    // (2)(3) 클릭 → 하단 Toast(경고).
    await page.getByRole("button", { name: "개설 검수" }).click();
    let tText = "";
    try { tText = await toastText(INCOMPLETE_MSG); } catch { /* no toast */ }
    check(`[${teamName}] (3)클릭 시 하단 Toast 표시 + 안내 문구`, tText.includes(INCOMPLETE_MSG));
    check(`[${teamName}] (3)Toast 에 미신청 파트명 표시`, unapplied.every((p) => tText.includes(p)) && tText.includes("미신청 파트:"), tText.replace(/\s+/g, " ").trim());
    check(`[${teamName}] (3)Toast 에 UUID 미노출`, !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(tText));

    // (2)(6) 서버 차단 — overall 헤더 미생성(상태/스냅샷 무변경).
    const after = await overallCount(weekId, tid);
    check(`[${teamName}] (2)(6)차단: overall 헤더 미생성(상태/스냅샷 무변경)`, before === 0 && after === 0, `before=${before} after=${after}`);

    // (5) 전 파트 신청 후 재클릭 → 정상 검수(status=reviewed).
    for (const p of parts) await seedApply(weekId, tid, p);
    await page.getByRole("button", { name: "개설 검수" }).click();
    await page.waitForTimeout(1500);
    const status = await overallStatus(weekId, tid);
    check(`[${teamName}] (5)전 파트 신청 후 재클릭 → 정상 검수(status=reviewed)`, status === "reviewed", `status=${status}`);

    if (teamName === TEAMS[0]) await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-review-toast.png"), fullPage: true });
    await cleanAll(weekId, tid);
  }
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
  try { await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-review-toast-error.png"), fullPage: true }); } catch {}
} finally {
  await browser.close();
}
console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);

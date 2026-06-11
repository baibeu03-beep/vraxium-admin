// 브라우저 검증 — [라인 개설] 탭 필터행 우측 "팀 활동 책임 / 관리" 팀장 배지.
//   /admin/line-opening/practical-experience?org=oranke&tab=open
//   팀 탭 변경 시 선택 팀 팀장으로 배지 갱신. direct(line-manage API) == 화면 표시 일치.
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
  const { data: verifyData } = await browser.auth.verifyOtp({ email: adminEmail, token: linkData.properties.email_otp, type: "magiclink" });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (items) => captured.push(...items) } });
  await server.auth.setSession({ access_token: verifyData.session.access_token, refresh_token: verifyData.session.refresh_token });
  return captured.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => { console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); ok ? pass++ : fail++; };

// 기대 배지 문구(컴포넌트 포맷과 동일).
function expectedText(leader) {
  if (!leader) return "팀 활동 책임 / 관리 : 미지정";
  const academic = [leader.school, leader.department].filter((v) => v && String(v).trim()).join(" ");
  return `팀 활동 책임 / 관리 : ${leader.name} 팀장${academic ? ` (${academic})` : ""}`;
}

const cookies = await makeAdminCookies();
const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

// direct/HTTP SoT = line-manage API.
const api = await (await fetch(`${BASE}/api/admin/cluster4/experience/line-manage?organization=${ORG}`, { headers: { cookie: cookieHeader } })).json();
const leaderByTeam = new Map((api.data?.teams ?? []).map((t) => [t.teamName, t.teamLeader]));

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1400 } });
await context.addCookies(cookies);
const page = await context.newPage();

try {
  await page.goto(`${BASE}/admin/line-opening/practical-experience?org=${ORG}&tab=open`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("document.body.innerText.includes('파트장 입력') && document.body.innerText.includes('팀 활동 책임 / 관리')", undefined, { timeout: 60000 });
  check("[UI] 필터행에 '팀 활동 책임 / 관리' 배지 렌더", true);

  // 배지 위치(우측) — 파트 select 보다 오른쪽인지.
  const layout = await page.evaluate(() => {
    const badge = [...document.querySelectorAll("span")].find((s) => (s.textContent || "").startsWith("팀 활동 책임 / 관리"));
    const selects = [...document.querySelectorAll("select")];
    if (!badge || selects.length === 0) return null;
    const br = badge.getBoundingClientRect();
    const lastSel = selects[Math.min(1, selects.length - 1)].getBoundingClientRect();
    return { badgeLeft: br.left, selRight: lastSel.right, sameRowish: Math.abs(br.top - lastSel.top) < 120 };
  });
  check("[1] 배지가 드롭다운 우측(ml-auto) + 같은 행", layout && layout.badgeLeft > layout.selRight && layout.sameRowish, JSON.stringify(layout));

  // 팀 탭들을 순회하며 배지 == 기대값.
  const teamNames = (api.data?.teams ?? []).map((t) => t.teamName);
  for (const team of teamNames) {
    await page.getByRole("button", { name: team, exact: true }).first().click();
    await page.waitForTimeout(400);
    const badgeText = await page.evaluate(() => {
      const b = [...document.querySelectorAll("span")].find((s) => (s.textContent || "").startsWith("팀 활동 책임 / 관리"));
      return (b?.textContent || "").replace(/\s+/g, " ").trim();
    });
    const exp = expectedText(leaderByTeam.get(team)).replace(/\s+/g, " ").trim();
    check(`[3/4] '${team}' 팀 선택 → 배지 == direct`, badgeText === exp, `화면='${badgeText}' 기대='${exp}'`);
  }

  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-open-leader.png"), fullPage: true });
  console.log("  screenshot → claudedocs/browser-open-leader.png");
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e); fail++;
  try { await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-open-leader-error.png"), fullPage: true }); } catch {}
} finally {
  await browser.close();
}
console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);

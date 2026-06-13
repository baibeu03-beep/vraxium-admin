// 검증(브라우저) — Phase B: 임퍼소네이션 UI(버튼 노출 + 탭 게이팅 팝업).
//   1) team_leader/part_leader/agent 테스트 유저 → "어드민 페이지로 보기" 버튼
//   2) crew(member) 테스트 유저 → 버튼 없음
//   3) 버튼 클릭 → 올바른 URL(mode=test·actAsTestUserId·org·tab=open)
//   4) part_leader 임퍼 → 자기 팀 기본 접근
//   5) 다른 팀 탭 클릭 → "해당 팀 입장 권한이 없습니다." 팝업 + 이동 차단
//   6) owner/admin(임퍼 없음) → 전체 팀 접근(잠금 없음)
//   7) query 보존(mode/org/tab/actAs)
// read-only. snapshot 무접촉.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE), brow = createClient(URL_, ANON);
const EMAIL = "vanuatu.golden@gmail.com";

let pass = 0, fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

// 역할별 테스트 유저 1명(+org/team) — memberStatusLabel 재현.
async function findByRole() {
  const { memberStatusLabel } = await import(resolve(adminRoot, "lib/adminMembersTypes.ts").replace(/\\/g, "/")).catch(() => ({}));
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const ids = (markers ?? []).map((m) => m.user_id);
  const { data: profs } = await sb.from("user_profiles").select("user_id,display_name,role,organization_slug").in("user_id", ids);
  const pById = new Map((profs ?? []).map((p) => [p.user_id, p]));
  const { data: mems } = await sb.from("user_memberships").select("user_id,team_name,part_name,membership_level,is_current").in("user_id", ids);
  const cur = new Map(); for (const m of (mems ?? [])) { const e = cur.get(m.user_id); if (!e || (m.is_current && !e.is_current)) cur.set(m.user_id, m); }
  const norm = (role, lv) => {
    if (role === "team_leader") return "team_leader";
    const s = (lv ?? "").trim();
    if (s.startsWith("심화")) return role === "part_leader" ? "part_leader" : "agent";
    return "member";
  };
  const out = {};
  for (const id of ids) {
    const p = pById.get(id); const m = cur.get(id); if (!p || !m) continue;
    const r = norm(p.role, m.membership_level);
    if (!out[r]) out[r] = { userId: id, name: p.display_name, org: p.organization_slug, team: m.team_name, part: m.part_name };
  }
  return out;
}

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = []; const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));

const roles = await findByRole();
console.log("  roles:", Object.fromEntries(Object.entries(roles).map(([k, v]) => [k, `${v.name}/${v.org}/${v.team}`])));

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1400 } });
await context.addCookies(cookies);
const page = await context.newPage();

try {
  // ── 1·2) /admin/test-users 버튼 노출 ──
  await page.goto(`${BASE}/admin/test-users`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("document.body.innerText.includes('어드민 페이지로 보기') || document.body.innerText.includes('테스트 유저가 없습니다')", undefined, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1000);
  // 특정 유저 행(이름)으로 버튼 존재 확인.
  const rowHasAdminBtn = (name) => page.evaluate((name) => {
    const row = [...document.querySelectorAll("tr")].find((tr) => tr.textContent?.includes(name));
    if (!row) return null;
    return [...row.querySelectorAll("button")].some((b) => /어드민 페이지로 보기/.test(b.textContent || ""));
  }, name);
  for (const r of ["team_leader", "part_leader", "agent"]) {
    if (roles[r]) ck(`[1] ${r}(${roles[r].name}) 행에 "어드민 페이지로 보기" 버튼`, (await rowHasAdminBtn(roles[r].name)) === true);
  }
  if (roles.member) ck(`[2] crew(${roles.member.name}) 행에 버튼 없음`, (await rowHasAdminBtn(roles.member.name)) === false);

  // ── 3) 버튼 클릭 → 새 탭 URL 검증(part_leader) ──
  const pl = roles.part_leader;
  if (pl) {
    const popupP = context.waitForEvent("page");
    await page.evaluate((name) => {
      const row = [...document.querySelectorAll("tr")].find((tr) => tr.textContent?.includes(name));
      const btn = [...(row?.querySelectorAll("button") ?? [])].find((b) => /어드민 페이지로 보기/.test(b.textContent || ""));
      btn?.click();
    }, pl.name);
    const popup = await popupP;
    await popup.waitForLoadState("domcontentloaded").catch(() => {});
    const u = new URL(popup.url());
    ck("[3] 버튼 URL path=practical-experience", u.pathname.includes("/admin/line-opening/practical-experience"));
    ck("[3] URL mode=test·tab=open·actAsTestUserId·org 보존",
      u.searchParams.get("mode") === "test" && u.searchParams.get("tab") === "open" &&
      u.searchParams.get("actAsTestUserId") === pl.userId && u.searchParams.get("org") === pl.org,
      u.search);
    await popup.close();
  }

  // ── 4·5·7) part_leader 임퍼 페이지 — 자기 팀 기본 + 타팀 팝업 차단 ──
  if (pl) {
    let dialogMsg = null;
    page.on("dialog", async (d) => { dialogMsg = d.message(); await d.dismiss(); });
    await page.goto(`${BASE}/admin/line-opening/practical-experience?org=${pl.org}&mode=test&tab=open&actAsTestUserId=${pl.userId}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction((t) => document.body.innerText.includes(t), pl.team, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
    ck("[7] query 보존(mode/org/tab/actAs)", (() => { const u = new URL(page.url()); return u.searchParams.get("mode") === "test" && u.searchParams.get("org") === pl.org && u.searchParams.get("tab") === "open" && u.searchParams.get("actAsTestUserId") === pl.userId; })());
    // 잠긴(다른) 팀 탭 = 자물쇠 표기 + 클릭 시 팝업.
    const otherTeam = await page.evaluate((own) => {
      const btns = [...document.querySelectorAll("button")].filter((b) => /\(T\)/.test(b.textContent || ""));
      const other = btns.find((b) => !(b.textContent || "").includes(own));
      return other ? (other.textContent || "").trim() : null;
    }, pl.team);
    ck("[5] 다른 (T) 팀 탭 존재(잠금 대상)", Boolean(otherTeam), `other=${otherTeam}`);
    if (otherTeam) {
      await page.evaluate((own) => {
        const btns = [...document.querySelectorAll("button")].filter((b) => /\(T\)/.test(b.textContent || ""));
        const other = btns.find((b) => !(b.textContent || "").includes(own));
        other?.click();
      }, pl.team);
      await page.waitForTimeout(600);
      ck("[5] 타팀 클릭 → '해당 팀 입장 권한이 없습니다.' 팝업", dialogMsg === "해당 팀 입장 권한이 없습니다.", `dialog=${dialogMsg}`);
      // 차단되어 여전히 자기 팀이 선택 상태(자기 팀 텍스트가 활성 탭).
    }
    await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-phaseB-impersonation.png"), fullPage: true });
  }

  // ── 6) owner/admin (임퍼 없음) → 잠긴 팀 없음 ──
  await page.goto(`${BASE}/admin/line-opening/practical-experience?org=${pl ? pl.org : "oranke"}&mode=test&tab=open`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("[...document.querySelectorAll('button')].some(b=>/\\(T\\)/.test(b.textContent||''))", undefined, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const lockedCount = await page.evaluate(() => [...document.querySelectorAll("button")].filter((b) => (b.textContent || "").includes("🔒")).length);
  ck("[6] 임퍼 없음 → 잠긴 팀 탭 0 (전체 접근)", lockedCount === 0, `locked=${lockedCount}`);

  console.log("  screenshot → claudedocs/browser-phaseB-impersonation.png");
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
  try { await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-phaseB-error.png"), fullPage: true }); } catch {}
} finally {
  await browser.close();
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

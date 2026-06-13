// 검증(브라우저) — Phase C: 역할별 버튼 게이팅(서버 가드와 짝).
//   agent 임퍼 → [개설 검수] 노출 · [개설 완료] 비노출
//   team_leader 임퍼 → [개설 완료] 노출
//   part_leader 임퍼 → 파트 드롭다운 잠금(disabled, 자기 파트 고정)
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

async function findByRole(want) {
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const ids = (markers ?? []).map((m) => m.user_id);
  const { data: profs } = await sb.from("user_profiles").select("user_id,role,organization_slug").in("user_id", ids);
  const pById = new Map((profs ?? []).map((p) => [p.user_id, p]));
  const { data: mems } = await sb.from("user_memberships").select("user_id,team_name,part_name,membership_level,is_current").in("user_id", ids);
  const cur = new Map(); for (const m of (mems ?? [])) { const e = cur.get(m.user_id); if (!e || (m.is_current && !e.is_current)) cur.set(m.user_id, m); }
  const norm = (role, lv) => role === "team_leader" ? "team_leader" : (lv ?? "").startsWith("심화") ? (role === "part_leader" ? "part_leader" : "agent") : "member";
  for (const id of ids) {
    const p = pById.get(id); const m = cur.get(id); if (!p || !m) continue;
    if (norm(p.role, m.membership_level) === want) return { userId: id, org: p.organization_slug, team: m.team_name, part: m.part_name };
  }
  return null;
}

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = []; const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));

const ag = await findByRole("agent"), tl = await findByRole("team_leader"), pl = await findByRole("part_leader");
console.log("  roles:", { agent: ag?.team, team_leader: tl?.team, part_leader: pl && `${pl.team}/${pl.part}` });

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1600 } });
await context.addCookies(cookies);
const page = await context.newPage();

const impUrl = (u) => `${BASE}/admin/line-opening/practical-experience?org=${u.org}&mode=test&tab=open&actAsTestUserId=${u.userId}`;
const hasBtn = (label) => page.evaluate((label) => [...document.querySelectorAll("button")].some((b) => (b.textContent || "").trim().includes(label)), label);

try {
  // ── agent: 검수 O, 개설 완료 X ──
  if (ag) {
    await page.goto(impUrl(ag), { waitUntil: "domcontentloaded" });
    await page.waitForFunction("document.body.innerText.includes('개설 검수') || document.body.innerText.includes('평가 대상 크루')", undefined, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
    ck("[agent] [개설 검수] 버튼 노출", await hasBtn("개설 검수"));
    ck("[agent] [개설 완료] 버튼 비노출", !(await hasBtn("개설 완료")));
    await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-phaseC-agent.png"), fullPage: true });
  }

  // ── team_leader: 개설 완료 O ──
  if (tl) {
    await page.goto(impUrl(tl), { waitUntil: "domcontentloaded" });
    await page.waitForFunction("document.body.innerText.includes('개설 검수')", undefined, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
    ck("[team_leader] [개설 완료] 버튼 노출", await hasBtn("개설 완료"));
    ck("[team_leader] [개설 검수] 버튼 노출", await hasBtn("개설 검수"));
  }

  // ── part_leader: 파트 드롭다운 잠금(자기 파트 고정) ──
  if (pl) {
    await page.goto(impUrl(pl), { waitUntil: "domcontentloaded" });
    await page.waitForFunction((t) => document.body.innerText.includes(t), pl.team, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const partSel = await page.evaluate(() => {
      const labels = [...document.querySelectorAll("label")];
      const partLabel = labels.find((l) => (l.textContent || "").trim() === "파트");
      const sel = partLabel?.parentElement?.querySelector("select");
      if (!sel) return null;
      return { disabled: sel.disabled, value: sel.value, options: [...sel.options].map((o) => o.textContent?.trim()) };
    });
    ck("[part_leader] 파트 드롭다운 disabled(잠금)", partSel?.disabled === true, JSON.stringify(partSel));
    ck("[part_leader] 파트 값=자기 파트 고정", partSel?.value === pl.part, `value=${partSel?.value} expect=${pl.part}`);
    await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-phaseC-partleader.png"), fullPage: true });
  }

  console.log("  screenshots → claudedocs/browser-phaseC-{agent,partleader}.png");
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
  try { await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-phaseC-error.png"), fullPage: true }); } catch {}
} finally {
  await browser.close();
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

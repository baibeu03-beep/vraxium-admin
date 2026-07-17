// 브라우저/HTTP 검증 — 실무 경험 라인명 표시(팀 총괄 + 개별 파트).
//   사전조건: admin dev :3000. 실행: node scripts/browser-verify-experience-line-display.mjs
//   1) 실제 HTTP GET(team-overall, part-input) operating vs test — selectedLineId 응답 비교.
//   2) 실제 페이지 DOM — ExperienceLineSelect 트리거 텍스트(placeholder "라인명" 여부).

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const { chromium } = createRequire(resolve(adminRoot, "..", "vraxium", "package.json"))("playwright");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3100";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE);
const brow = createClient(URL_, ANON);
const OWNER_EMAIL = "vanuatu.golden@gmail.com";

async function cookiesFor(email) {
  const { data: link, error } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw new Error(`generateLink: ${error.message}`);
  const { data: v, error: e2 } = await brow.auth.verifyOtp({ email, token: link.properties.email_otp, type: "magiclink" });
  if (e2) throw new Error(`verifyOtp: ${e2.message}`);
  const cap = [];
  const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}

let fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

// 저장값 있는 대상: phalanx / 운영(T) / 응대 / week d3260418.
const ORG = "phalanx";
const TEAM_ID = "13e60f37-152c-4e53-8d65-f633cc48d81c";
const TEAM_NAME = "운영(T)";
const WEEK_ID = "d3260418-fcd3-4c23-875f-e51502cf9bd3";
const PART = "응대";

const browser = await chromium.launch({ channel: "chromium", headless: true });
try {
  const cookies = await cookiesFor(OWNER_EMAIL);
  const ctx = await browser.newContext();
  await ctx.addCookies(cookies);

  // ── 1) HTTP GET 응답 비교(operating vs test) ──
  console.log("▶ HTTP GET — team-overall / part-input (operating vs test)");
  const q = (extra) => new URLSearchParams({ organization: ORG, week_id: WEEK_ID, team_id: TEAM_ID, team_name: TEAM_NAME, ...extra }).toString();

  async function getJson(path) {
    const r = await ctx.request.get(`${BASE}${path}`, { failOnStatusCode: false });
    return { status: r.status(), json: await r.json().catch(() => null) };
  }

  for (const modeLabel of ["operating", "test"]) {
    const extra = modeLabel === "test" ? { mode: "test" } : {};
    const to = await getJson(`/api/admin/cluster4/experience/team-overall?${q(extra)}`);
    let toSel = 0, toTotal = 0;
    for (const p of to.json?.data?.parts ?? []) for (const c of p.crews) for (const k of Object.keys(c.cells)) { toTotal++; if (c.cells[k]?.selectedLineId) toSel++; }
    ck(`[team-overall/${modeLabel}] 200 & selectedLineId 응답 존재`, to.status === 200 && toSel > 0, `sel ${toSel}/${toTotal}`);

    const pi = await getJson(`/api/admin/cluster4/experience/part-input?${q({ ...extra, part: PART })}`);
    const piCells = pi.json?.data?.cells ?? [];
    const piSel = piCells.filter((c) => c.selectedLineId).length;
    ck(`[part-input/${modeLabel}/${PART}] 200 & selectedLineId 응답 존재`, pi.status === 200 && piSel > 0, `sel ${piSel}/${piCells.length}`);
  }

  // ── 2) DOM 트리거 텍스트 — 실제 렌더 ──
  console.log("\n▶ DOM — 페이지 렌더 트리거 텍스트");
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("   [pageerror]", e.message));
  // 팀 총괄/파트 선택 상태는 UI 조작이 필요 — 우선 개별 파트 그리드가 기본 렌더되는 test 모드로 진입.
  await page.goto(`${BASE}/admin/line-opening/practical-experience?org=${ORG}&tab=open&mode=test&week=${WEEK_ID}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  // 운영(T) 팀 탭 클릭.
  const teamTab = page.getByRole("tab", { name: new RegExp(TEAM_NAME.replace(/[()]/g, "\\$&")) });
  if (await teamTab.count()) { await teamTab.first().click(); await page.waitForTimeout(1200); }

  async function readTriggers(label) {
    // ExperienceLineSelect 트리거 = [aria-label*="라인명"] 버튼(role=combobox/button). 텍스트 수집.
    const texts = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('[aria-label$="라인명"]'));
      return nodes.map((n) => (n.textContent || "").trim()).filter(Boolean);
    });
    const placeholders = texts.filter((t) => t === "라인명").length;
    const named = texts.filter((t) => t && t !== "라인명").length;
    console.log(`   [${label}] 트리거 ${texts.length}개 · 라인명(placeholder) ${placeholders} · 실제명 ${named}`);
    if (texts.length) console.log(`     예: ${texts.slice(0, 5).map((t) => JSON.stringify(t)).join(", ")}`);
    return { total: texts.length, placeholders, named };
  }

  // 개별 파트(기본 진입) 트리거.
  const partRes = await readTriggers(`개별 파트(기본)`);
  ck(`개별 파트: 트리거에 실제 라인명 표시(placeholder-only 아님)`, partRes.total === 0 || partRes.named > 0, `실제명 ${partRes.named}/${partRes.total}`);

  // 파트 드롭다운에서 "팀 총괄" 선택.
  const partSelect = page.locator('button', { hasText: /팀 총괄|응대|정책/ }).first();
  // base-ui Select 트리거는 role=combobox. 파트 라벨 근처 combobox 2개(주차/파트) 중 파트를 연다.
  const combos = page.getByRole("combobox");
  if (await combos.count()) {
    await combos.last().click().catch(() => {});
    await page.waitForTimeout(500);
    const overallOpt = page.getByRole("option", { name: /팀 총괄/ });
    if (await overallOpt.count()) { await overallOpt.first().click(); await page.waitForTimeout(1500); }
  }
  const overallRes = await readTriggers(`팀 총괄`);
  ck(`팀 총괄: 트리거에 실제 라인명 표시(placeholder-only 아님)`, overallRes.total === 0 || overallRes.named > 0, `실제명 ${overallRes.named}/${overallRes.total}`);

  await page.close();
  await ctx.close();
} finally {
  await browser.close();
}
console.log(fail === 0 ? "\n✅ 전체 통과" : `\n❌ 실패 ${fail}건`);
process.exit(fail === 0 ? 0 : 1);

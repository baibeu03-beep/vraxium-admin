// 브라우저 검증 — 실무 경험 [라인 개설] 라인 선택 드롭다운 폭 축소.
//   /admin/line-opening/practical-experience?org=<org>&tab=open&mode=test 에서 (T) 팀 기준.
//   ① 라인 선택 트리거 폭 ≈180px, 전 트리거 동일(파트그리드 도출/분석/견문 · 팀총괄 5열)
//   ② 펼친 목록(팝업) 폭 ≥280px (트리거보다 넓음)
//   ③ 긴 라인명 선택 시 트리거 값 line-clamp:3 · 트리거가 셀 밖으로 넘치지 않음
//   owner 세션(vanuatu.golden). 사용자 지정 팀: phalanx 운영/전략/제품실험(T) + 타 org 각 1팀.
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
const TARGETS = [
  { org: "phalanx", teams: ["운영(T)", "전략(T)", "제품실험(T)"], partGridTeam: "운영(T)" },
  { org: "oranke", teams: ["음료(T)"] },
  { org: "encre", teams: ["사운드(T)"] },
];

let pass = 0, fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };
const triggerWidths = () => page.$$eval("[data-slot=select-trigger]", (els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = [];
const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1200 } });
await context.addCookies(cookies);
const page = await context.newPage();

async function clickTeamTab(name) {
  const tabs = await page.$$("button[role=tab]");
  for (const tab of tabs) {
    const txt = (await tab.textContent())?.replace(/🔒/g, "").trim() ?? "";
    if (txt.includes(name)) { await tab.click(); return true; }
  }
  return false;
}
// 파트 <select>(옵션에 "팀 총괄" 포함) 값 지정 후 라인 트리거가 렌더될 때까지 대기.
async function selectPartAndWait(label) {
  const set = await page.evaluate((wanted) => {
    for (const s of Array.from(document.querySelectorAll("select"))) {
      const opts = Array.from(s.options).map((o) => o.textContent.trim());
      if (!opts.includes("팀 총괄")) continue;
      const target = wanted === "팀 총괄"
        ? Array.from(s.options).find((o) => o.textContent.trim() === "팀 총괄")
        : Array.from(s.options).find((o) => o.textContent.trim() !== "팀 총괄");
      if (!target) return false;
      s.value = target.value; s.dispatchEvent(new Event("change", { bubbles: true })); return true;
    }
    return false;
  }, label);
  if (!set) return false;
  try { await page.waitForFunction(() => document.querySelectorAll("[data-slot=select-trigger]").length > 0, { timeout: 15000 }); }
  catch { return false; }
  await page.waitForTimeout(500);
  return true;
}
async function measureBlock(tag) {
  const w = await triggerWidths();
  if (w.length === 0) { ck(`${tag} 라인 트리거 렌더`, false, "0 트리거"); return false; }
  const min = Math.min(...w), max = Math.max(...w);
  ck(`${tag} 트리거 폭 ≈180px`, min >= 168 && max <= 192, `n=${w.length} min=${min} max=${max}`);
  ck(`${tag} 트리거 동일 폭`, max - min <= 1, `spread=${max - min}px`);
  // 팝업 폭 + 긴 라인명 선택. (활성 트리거만 클릭 — 팀총괄 도출/분석/견문·관리는 비활성 다수)
  let trg = null;
  for (const h of await page.$$("[data-slot=select-trigger]")) {
    if (await h.isEnabled().catch(() => false)) { trg = h; break; }
  }
  try {
  if (trg) {
    const trigW = Math.round((await trg.boundingBox())?.width ?? 0);
    await trg.click(); await page.waitForTimeout(700);
    const popup = await page.$("[data-slot=select-content]");
    const popW = popup ? Math.round((await popup.boundingBox())?.width ?? 0) : 0;
    ck(`${tag} 팝업 폭 ≥280px`, popW >= 280, `popup=${popW}px`);
    ck(`${tag} 팝업 > 트리거`, popW > trigW, `popup=${popW} > trig=${trigW}`);
    const items = await page.$$("[data-slot=select-content] [data-slot=select-item]");
    if (items.length > 1) {
      let longest = items[0], len = 0;
      for (const it of items) { const t = (await it.textContent())?.length ?? 0; if (t > len) { len = t; longest = it; } }
      await longest.click(); await page.waitForTimeout(900);
      const info = await page.evaluate(() => {
        const val = document.querySelector("[data-slot=select-trigger] [data-slot=select-value]");
        const t = val?.closest("[data-slot=select-trigger]"); if (!val || !t) return null;
        const cs = getComputedStyle(val); const r = t.getBoundingClientRect();
        return { lc: cs.webkitLineClamp || cs.getPropertyValue("-webkit-line-clamp"), w: Math.round(r.width), h: Math.round(r.height), sw: val.scrollWidth, cw: val.clientWidth };
      });
      if (info) {
        ck(`${tag} 선택값 line-clamp:3`, info.lc === "3", `lc=${info.lc}`);
        ck(`${tag} 선택 후 트리거 폭 유지(≤192)`, info.w <= 192, `w=${info.w}px h=${info.h}px`);
        ck(`${tag} 선택값 가로 넘침 없음`, info.sw <= info.cw + 2, `scrollW=${info.sw} clientW=${info.cw}`);
      }
    } else { await page.keyboard.press("Escape"); }
  }
  } catch (e) { ck(`${tag} 팝업/선택 상호작용`, false, `harness: ${e?.message ?? e}`.slice(0, 80)); try { await page.keyboard.press("Escape"); } catch {} }
  return true;
}

try {
  for (const { org, teams, partGridTeam } of TARGETS) {
    await page.goto(`${BASE}/admin/line-opening/practical-experience?org=${org}&tab=open&mode=test`, { waitUntil: "domcontentloaded" });
    try { await page.waitForSelector("button[role=tab]", { timeout: 20000 }); }
    catch { ck(`[${org}] 팀 탭 로드`, false, "20s 내 미렌더"); continue; }
    for (const team of teams) {
      console.log(`\n── ${org} · ${team} ──`);
      const clicked = await clickTeamTab(team);
      ck(`[${org}/${team}] 팀 탭 선택`, clicked);
      if (!clicked) continue;
      await page.waitForTimeout(1500);
      // 팀 총괄(5열).
      if (await selectPartAndWait("팀 총괄")) {
        await measureBlock(`[${org}/${team}·팀총괄]`);
        await page.screenshot({ path: resolve(adminRoot, "claudedocs", `exp-line-width-${org}-${team.replace(/[()]/g, "")}-overall.png`), fullPage: false });
      } else ck(`[${org}/${team}·팀총괄] 렌더`, false, "트리거 미출현");
      // 파트 그리드(도출/분석/견문) — 지정 팀만.
      if (partGridTeam === team) {
        await clickTeamTab(team); await page.waitForTimeout(800);
        if (await selectPartAndWait("part")) {
          await measureBlock(`[${org}/${team}·파트그리드]`);
          await page.screenshot({ path: resolve(adminRoot, "claudedocs", `exp-line-width-${org}-${team.replace(/[()]/g, "")}-part.png`), fullPage: false });
        } else ck(`[${org}/${team}·파트그리드] 렌더`, false, "트리거 미출현");
      }
    }
  }
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e); fail++;
  try { await page.screenshot({ path: resolve(adminRoot, "claudedocs", "exp-line-width-error.png"), fullPage: true }); } catch {}
} finally {
  await browser.close();
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

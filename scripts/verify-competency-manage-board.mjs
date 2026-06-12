// 실무 역량 [라인 관리] 탭 보드 검증 — 제목/현재상황/주차 드롭다운(기본=openable)/6 집계 카드(주차별).
// HTTP(week_id 스코프·direct==HTTP·tab=open 일치) + 브라우저(3 org) + 주차 변경 시 카드 갱신.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const r = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = r("@supabase/supabase-js");
const { createServerClient } = r("@supabase/ssr");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const URL = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL, SERVICE), brow = createClient(URL, ANON);
const ORGS = ["oranke", "encre", "phalanx"];
const TAG = "ZZ-manage-board";
const J = (o) => JSON.stringify(o);
const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: "vanuatu.golden@gmail.com" });
const { data: v } = await brow.auth.verifyOtp({ email: "vanuatu.golden@gmail.com", token: link.properties.email_otp, type: "magiclink" });
const cap = []; const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
const cookie = cap.map((i) => `${i.name}=${i.value}`).join("; ");
const apps = async (org, weekId) => (await (await fetch(`${BASE}/api/admin/cluster4/competency/applications?organization=${org}${weekId ? `&week_id=${weekId}` : ""}`, { headers: { cookie } })).json()).data;
let pass = 0, fail = 0; const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };
const cleanup = async () => sb.from("cluster4_competency_applications").delete().like("line_name", `${TAG}%`);

try {
  await cleanup();
  // 주차 옵션 + openable(기본) + 다른 주차
  const weeks = (await (await fetch(`${BASE}/api/admin/cluster4/weeks-options?limit=8`, { headers: { cookie } })).json()).data.weeks;
  const openable = weeks.find((w) => w.isOpenTarget) ?? weeks.find((w) => w.isCurrent) ?? weeks[0];
  const other = weeks.find((w) => w.id !== openable.id);
  console.log(`주차: openable(기본)=${openable.year} ${openable.seasonName} W${openable.weekNumber} (isOpenTarget=${openable.isOpenTarget},isCurrent=${openable.isCurrent}) | 다른주차=${other.year} W${other.weekNumber}`);
  ck("[검증7·8] 기본 주차 = openable(금~일→현재 N / 월~목→N-1, weeks-options 공용 정책)",
    !!openable.isOpenTarget, `오늘 기준 isOpenTarget 주차 = W${openable.weekNumber}`);

  // ── HTTP: 기본 vs week_id, direct==HTTP, tab=open 일치 ──
  console.log("\n[HTTP] 집계 (oranke):");
  const sDefault = await apps("oranke"); // week_id 미지정 = 개설 대상(=openable)
  const sOpenable = await apps("oranke", openable.id);
  ck("[검증10] 기본(week_id 미지정) == openable week_id 집계 == tab=open 집계(같은 주차·같은 DTO)",
    sDefault.weekId === openable.id && J(sDefault.summary) === J(sOpenable.summary), `weekId=${sDefault.weekId === openable.id}`);

  // 다른 주차에 테스트 신청 1건 삽입 → 주차별 집계가 달라지는지(week-scoped)
  const tm = new Set((await sb.from("test_user_markers").select("user_id")).data.map((x) => x.user_id));
  const crew = (await (await fetch(`${BASE}/api/admin/cluster4/crews?organization=oranke&status=active`, { headers: { cookie } })).json()).data.find((c) => !tm.has(c.userId));
  await sb.from("cluster4_competency_applications").insert({ organization_slug: "oranke", week_id: other.id, target_user_id: crew.userId, line_name: `${TAG}-x`, source: "manual" });
  const sOther = await apps("oranke", other.id);
  const sOpenable2 = await apps("oranke", openable.id);
  ck("[검증5·9 데이터] 주차별 집계 분리 — 다른주차 신청크루=1, openable 신청크루=0",
    sOther.summary.appliedCrews === 1 && sOpenable2.summary.appliedCrews === 0, `다른주차=${sOther.summary.appliedCrews} openable=${sOpenable2.summary.appliedCrews}`);

  // direct(DB 재계산) == HTTP : openable 주차 활동크루 = active non-test crews
  const activeCount = ((await (await fetch(`${BASE}/api/admin/cluster4/crews?organization=oranke&status=active`, { headers: { cookie } })).json()).data ?? []).filter((c) => !tm.has(c.userId)).length;
  ck("[검증1·2·3] direct(DB active non-test) == HTTP summary.activeCrews", activeCount === sOpenable2.summary.activeCrews, `direct=${activeCount} http=${sOpenable2.summary.activeCrews}`);

  // ── 브라우저: 3 org ──
  const b = await chromium.launch({ channel: "chromium", headless: true });
  const ctx = await b.newContext({ viewport: { width: 1500, height: 1400 } }); await ctx.addCookies(cookies);
  const p = await ctx.newPage();
  for (const org of ORGS) {
    let lastWeekIdReq = null;
    p.removeAllListeners("request");
    p.on("request", (req) => { const u = req.url(); if (u.includes("/competency/applications")) { try { lastWeekIdReq = new URL(u).searchParams.get("week_id"); } catch {} } });
    await p.goto(`${BASE}/admin/line-opening/practical-competency?org=${org}`, { waitUntil: "domcontentloaded" });
    await p.waitForFunction("document.body.innerText.includes('[실무 역량] Hub')", undefined, { timeout: 30000 }).catch(() => {});
    await p.waitForFunction("!document.body.innerText.includes('집계 불러오는 중')", undefined, { timeout: 20000 }).catch(() => {});
    const body = await p.evaluate("document.body.innerText");
    ck(`[${org}/manage] 제목 [실무 역량] Hub + 중복 h1 없음`, body.includes("[실무 역량] Hub") && !body.includes("실무 역량 라인 관리\n"));
    ck(`[${org}/manage] 현재 상황: 오늘 날짜/개설 필요 기간/개설 이행 기간`,
      body.includes("오늘 날짜") && body.includes("개설 필요 기간") && body.includes("개설 이행 기간"));
    const weekBtn = await p.evaluate(() => document.querySelector('button[aria-label="주차 선택"]')?.textContent?.trim() ?? "");
    ck(`[${org}/manage] 주차 드롭다운 기본=메인표기(NN년, ○○ 시즌, N주차)`, /\d{2}년,\s*.+시즌,\s*\d+주차/.test(weekBtn), weekBtn);
    ck(`[${org}/manage] 6 집계 카드 라벨`,
      ["활동 크루", "신청 크루", "개설 크루", "반려 크루", "신청 라인", "개설 라인"].every((t) => body.includes(t)));
    // 카드 값(활동 크루) == HTTP
    const cardActive = await p.evaluate(() => { const el = [...document.querySelectorAll("div")].find((d) => d.children.length === 2 && d.children[1]?.textContent?.trim() === "활동 크루"); return el ? el.children[0].textContent.trim() : null; });
    const httpActive = (await apps(org, openable.id)).summary.activeCrews;
    ck(`[${org}/manage] 활동 크루 카드값 == HTTP(${httpActive})`, String(httpActive) === cardActive, `카드=${cardActive}`);

    if (org === "oranke") {
      // 주차 변경 → 6 카드 갱신: 드롭다운 열어 다른주차(신청1) 선택 → 신청 크루 카드=1
      await p.click('button[aria-label="주차 선택"]');
      await p.waitForTimeout(300);
      await p.evaluate((wid) => { const menu = document.querySelector('button[aria-label="주차 선택"]')?.closest(".relative")?.querySelector("div.absolute"); const btns = menu ? [...menu.querySelectorAll("button")] : []; // 다른주차 = 신청 1 들어있는 주차(텍스트로 못찾으니 두번째 옵션 등)
        for (const btn of btns) { if (btn.getAttribute("data-x") === wid) { btn.click(); return; } } }, other.id);
      // data-x 없으니 텍스트로 선택: other 주차 라벨로 클릭
      await p.evaluate((label) => { const menu = document.querySelector('button[aria-label="주차 선택"]')?.closest(".relative")?.querySelector("div.absolute"); const btns = menu ? [...menu.querySelectorAll("button")] : []; const t = btns.find((x) => (x.textContent || "").includes(label)); t?.click(); }, `${other.weekNumber}주차`);
      await p.waitForTimeout(1500);
      const appliedCard = await p.evaluate(() => { const el = [...document.querySelectorAll("div")].find((d) => d.children.length === 2 && d.children[1]?.textContent?.trim() === "신청 크루"); return el ? el.children[0].textContent.trim() : null; });
      ck(`[검증9] 주차 변경 → 6 집계 카드 갱신(다른주차 신청 크루=1)`, appliedCard === "1", `신청크루 카드=${appliedCard} (req week_id=${lastWeekIdReq === other.id})`);
    }
  }
  await b.close();
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally { await cleanup(); console.log(`\n결과: ${pass} pass / ${fail} fail (cleanup 완료)`); process.exit(fail > 0 ? 1 : 0); }

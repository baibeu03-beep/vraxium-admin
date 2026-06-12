// 실무 역량 실제 DB 연동 검증 — 수동 추가 → 개설 → 개설 취소 (브라우저 UI 구동).
// 각 단계: direct DB(Supabase) + HTTP API + 브라우저 결과. 격리: oranke + 테스트 크루 + common 마스터, 끝에 정리.
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
const URL = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const IKEY = get("INTERNAL_API_KEY");
const sb = createClient(URL, SERVICE);
const brow = createClient(URL, ANON);
const ORG = "oranke";
const LINE = "ZZ-검증-역량라인";
const SUB = "https://verify.example/submission-crew";
const CAFE = "https://verify.example/cafe-common";
const DESC = "검증공통설명";
const J = (o) => JSON.stringify(o);

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: "vanuatu.golden@gmail.com" });
const { data: v } = await brow.auth.verifyOtp({ email: "vanuatu.golden@gmail.com", token: link.properties.email_otp, type: "magiclink" });
const cap = [];
const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
const cookie = cap.map((i) => `${i.name}=${i.value}`).join("; ");

const httpApps = async () => (await (await fetch(`${BASE}/api/admin/cluster4/competency/applications?organization=${ORG}`, { headers: { cookie } })).json()).data;
const httpLine = async (id) => {
  const j = await (await fetch(`${BASE}/api/admin/cluster4/lines?partType=competency&detailed=1&organization=${ORG}&limit=500`, { headers: { cookie } })).json();
  return (j.data?.rows ?? []).find((x) => x.id === id) ?? null;
};
const dbApp = async () => (await sb.from("cluster4_competency_applications").select("*").eq("organization_slug", ORG).eq("line_name", LINE).maybeSingle()).data;

async function cleanup() {
  const a = await dbApp();
  if (a?.opened_line_id) {
    await sb.from("cluster4_line_targets").delete().eq("line_id", a.opened_line_id);
    await sb.from("cluster4_lines").delete().eq("id", a.opened_line_id);
  }
  await sb.from("cluster4_competency_applications").delete().eq("organization_slug", ORG).eq("line_name", LINE);
}

const b = await chromium.launch({ channel: "chromium", headless: true });
const ctx = await b.newContext({ viewport: { width: 1500, height: 1600 } });
await ctx.addCookies(cookies);
const p = await ctx.newPage();
p.on("dialog", async (d) => { await d.accept(); });

try {
  await cleanup();
  const weekId = (await httpApps()).weekId;
  const tm = (await sb.from("test_user_markers").select("user_id")).data.map((x) => x.user_id);
  const prof = (await sb.from("user_profiles").select("user_id,display_name").eq("organization_slug", ORG).in("user_id", tm)).data;
  const crew = prof[0];
  const master = (await sb.from("cluster4_competency_line_masters").select("id,line_code").eq("line_code", "CPBS-NN0001").maybeSingle()).data;
  console.log(`\n=== SETUP === week=${weekId} crew=${crew.display_name}(${crew.user_id.slice(0, 8)}) master=${master.line_code}`);

  await p.goto(`${BASE}/admin/line-opening/practical-competency?org=${ORG}&tab=open`, { waitUntil: "domcontentloaded" });
  await p.waitForFunction("document.body.innerText.includes('오늘은')", undefined, { timeout: 30000 }).catch(() => {});
  await p.waitForFunction("document.body.innerText.includes('신청 데이터가 없습니다') || !!document.querySelector('table')", undefined, { timeout: 20000 }).catch(() => {});

  // ── STEP 1: 수동 추가 (UI) ──
  console.log("\n=== STEP 1: 수동 추가 (브라우저 UI) ===");
  await p.fill('input[aria-label="수동 추가 크루 검색"]', crew.display_name);
  await p.waitForTimeout(2500);
  await p.evaluate(() => {
    const menu = document.querySelector('input[aria-label="수동 추가 크루 검색"]')?.closest(".relative")?.querySelector("div.absolute");
    menu?.querySelector("button")?.click();
  });
  await p.waitForTimeout(300);
  await p.evaluate(() => [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim().startsWith("추가"))?.click());
  await p.waitForTimeout(400);
  await p.fill('input[aria-label="수동 추가 라인명"]', LINE);
  await p.fill('input[aria-label="수동 추가 제출 링크"]', SUB);
  await p.evaluate(() => { const btns = [...document.querySelectorAll("button")].filter((x) => (x.textContent || "").trim() === "확인"); btns[btns.length - 1]?.click(); });
  await p.waitForTimeout(2500);
  const a1 = await dbApp();
  const h1 = (await httpApps()).applications.find((x) => x.lineName === LINE);
  const browserRow1 = await p.evaluate((L) => {
    const tr = [...document.querySelectorAll("tr")].find((t) => (t.textContent || "").includes(L));
    return tr ? { text: tr.innerText.replace(/\s+/g, " ").trim().slice(0, 90), hasX: !!tr.querySelector('button[aria-label*="삭제"]') } : null;
  }, LINE);
  console.log("  [direct DB row] ", a1 ? J({ id: a1.id.slice(0, 8), source: a1.source, line_name: a1.line_name, submission_link: a1.submission_link, resolution: a1.resolution, target: a1.target_user_id.slice(0, 8) }) : "NULL");
  console.log("  [HTTP applications]", h1 ? J({ source: h1.source, lineName: h1.lineName, submissionLink: h1.submissionLink, resolution: h1.resolution, crewLabel: h1.crewLabel }) : "NULL");
  console.log("  [browser row] ", J(browserRow1));
  console.log(`  => 생성 확인: DB=${!!a1} HTTP=${!!h1} 브라우저=${!!browserRow1} source=${a1?.source}`);

  await sb.from("cluster4_competency_applications").update({ competency_line_master_id: master.id }).eq("id", a1.id);
  console.log(`  [셋업] 고객 가시성 위해 common 마스터(${master.line_code}) 연결`);

  // ── STEP 2: 개설 (UI) ──
  console.log("\n=== STEP 2: 개설 (브라우저 UI 버튼) ===");
  await p.fill('input[aria-label="아웃풋 링크 1"]', CAFE);
  await p.fill('input[aria-label="설명 1"]', DESC);
  await p.evaluate(() => [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "개설")?.click());
  await p.waitForTimeout(4500);
  const a2 = await dbApp();
  const dbLine = a2?.opened_line_id ? (await sb.from("cluster4_lines").select("id,line_code,is_active,output_link_1,output_link_2,competency_line_master_id").eq("id", a2.opened_line_id).maybeSingle()).data : null;
  const dbTgt = a2?.opened_line_id ? (await sb.from("cluster4_line_targets").select("id,week_id,target_user_id").eq("line_id", a2.opened_line_id)).data : [];
  const hLine = a2?.opened_line_id ? await httpLine(a2.opened_line_id) : null;
  const sumH = (await httpApps()).summary;
  let custReflect = "조회불가";
  try {
    const wc = await (await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${a2.target_user_id}`, { headers: { "x-internal-api-key": IKEY } })).text();
    custReflect = wc.includes(SUB) ? "노출(제출링크 발견)" : (wc.includes("CPBS-NN0001") || wc.includes(a2.opened_line_id) ? "라인 노출" : "미발견");
  } catch (e) { custReflect = "오류:" + e.message; }
  const browserSum2 = await p.evaluate(() => document.body.innerText.match(/(\d+)\s*개설 크루[\s\S]*?(\d+)\s*개설 라인/)?.slice(1, 3) ?? null);
  console.log("  [direct DB app] ", a2 ? J({ resolution: a2.resolution, opened_line_id: a2.opened_line_id?.slice(0, 8), opened_target_id: a2.opened_target_id?.slice(0, 8) }) : "NULL");
  console.log("  [direct DB cluster4_lines] ", dbLine ? J({ line_code: dbLine.line_code, is_active: dbLine.is_active, output_link_1: dbLine.output_link_1, output_link_2: dbLine.output_link_2 }) : "NULL");
  console.log("  [direct DB line_targets] ", J(dbTgt.map((t) => ({ week: t.week_id === weekId ? "W(대상)" : t.week_id.slice(0, 8), target: t.target_user_id.slice(0, 8) }))));
  console.log("  [HTTP admin lines]", hLine ? J({ mainTitle: hLine.mainTitle, lineCode: hLine.lineCode, targets: hLine.targets?.length }) : "NULL(미노출)");
  console.log("  [HTTP summary] 개설크루=" + sumH.openedCrews + " 개설라인=" + sumH.openedLines);
  console.log("  [고객 weekly-cards] " + custReflect);
  console.log("  [browser summary] 개설크루/개설라인=" + J(browserSum2));
  console.log(`  => 개설 확인: resolution=${a2?.resolution} 라인생성=${!!dbLine} 타깃=${dbTgt.length} link2=${dbLine?.output_link_2 === SUB ? "제출링크OK" : "X"} link1=${dbLine?.output_link_1 === CAFE ? "공통OK" : "X"}`);

  // ── STEP 3: 개설 취소 (UI) ──
  console.log("\n=== STEP 3: 개설 취소 (브라우저 UI 버튼) ===");
  const lineIdWas = a2.opened_line_id;
  await p.evaluate(() => [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "개설 취소" && !x.disabled)?.click());
  await p.waitForTimeout(4500);
  const a3 = await dbApp();
  const lineGone = (await sb.from("cluster4_lines").select("id").eq("id", lineIdWas)).data ?? [];
  const tgtGone = (await sb.from("cluster4_line_targets").select("id").eq("line_id", lineIdWas)).data ?? [];
  const hLineAfter = await httpLine(lineIdWas);
  const sumH3 = (await httpApps()).summary;
  let custAfter = "조회불가";
  try {
    const wc = await (await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${a3.target_user_id}`, { headers: { "x-internal-api-key": IKEY } })).text();
    custAfter = wc.includes(SUB) ? "아직 노출(원복실패)" : "미노출(원복됨)";
  } catch (e) { custAfter = "오류"; }
  console.log("  [direct DB app] ", J({ resolution: a3.resolution, opened_line_id: a3.opened_line_id }));
  console.log("  [direct DB] cluster4_lines 잔존=" + lineGone.length + " line_targets 잔존=" + tgtGone.length);
  console.log("  [HTTP admin lines] " + (hLineAfter ? "아직 노출(원복실패)" : "제거됨"));
  console.log("  [HTTP summary] 개설크루=" + sumH3.openedCrews + " 개설라인=" + sumH3.openedLines);
  console.log("  [고객 weekly-cards] " + custAfter);
  console.log(`  => 취소 확인: resolution=${a3?.resolution} 라인삭제=${lineGone.length === 0} 타깃삭제=${tgtGone.length === 0}`);
} catch (e) {
  console.error("ERROR:", e?.stack ?? e?.message ?? e);
} finally {
  await cleanup();
  const left = await dbApp();
  console.log("\n=== CLEANUP === 테스트 행 제거 — 잔존:", left ? "남음(주의)" : "없음(net-zero)");
  await b.close();
}

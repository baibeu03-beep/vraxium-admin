// 검증 — 실무 역량 [라인 관리] 크루별 라인 개설 결과 표 브라우저 반영.
//   seed A=opened B=rejected C=pending(개설 대상 주차) → 표에서 성공/실패/성공 + 미신청 실패.
//   주차 변경 시 표 갱신. net-zero 정리. snapshot 무접촉(읽기 전용).
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
const URL = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL, SERVICE), brow = createClient(URL, ANON);
const EMAIL = "vanuatu.golden@gmail.com", ORG = "oranke", TAG = "ZZ-cresUI";

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = []; const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookieHeader = cap.map((i) => `${i.name}=${i.value}`).join("; ");
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
let pass = 0, fail = 0; const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

const httpGet = async (weekId) =>
  (await (await fetch(`${BASE}/api/admin/cluster4/competency/applications?organization=${ORG}${weekId ? `&week_id=${weekId}` : ""}`, { headers: { cookie: cookieHeader } })).json()).data;
async function cleanup(weekId) {
  if (weekId) await sb.from("cluster4_competency_applications").delete().eq("organization_slug", ORG).eq("week_id", weekId).like("line_name", `${TAG}%`);
}

let WEEK = null;
const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 2400 } });
await context.addCookies(cookies);
const page = await context.newPage();

// 결과표 섹션의 tbody 행 → 셀 텍스트 배열.
const readResultRows = () => page.evaluate(() => {
  const header = [...document.querySelectorAll("div")].find((d) => (d.textContent || "").trim().startsWith("크루별 라인 개설 결과") && d.className.includes("font-semibold"));
  const sec = header?.parentElement;
  const table = sec?.querySelector("table");
  if (!table) return null;
  return [...table.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent?.trim() ?? ""));
});

try {
  WEEK = (await httpGet(null)).weekId;
  await cleanup(WEEK);
  const testSet = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x) => x.user_id));
  const crews = ((await (await fetch(`${BASE}/api/admin/cluster4/crews?organization=${ORG}&status=active`, { headers: { cookie: cookieHeader } })).json()).data ?? []).filter((c) => !testSet.has(c.userId));
  const [A, B, C] = crews;
  await sb.from("cluster4_competency_applications").insert([
    { organization_slug: ORG, week_id: WEEK, target_user_id: A.userId, line_name: `${TAG}-A`, source: "manual", resolution: "opened", approval_checked: true },
    { organization_slug: ORG, week_id: WEEK, target_user_id: B.userId, line_name: `${TAG}-B`, source: "manual", resolution: "rejected", approval_checked: false },
    { organization_slug: ORG, week_id: WEEK, target_user_id: C.userId, line_name: `${TAG}-C`, source: "manual", resolution: "pending", approval_checked: false },
  ]);

  // [라인 관리] 탭(기본) — org 스코프.
  await page.goto(`${BASE}/admin/line-opening/practical-competency?org=${ORG}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("document.body.innerText.includes('크루별 라인 개설 결과')", undefined, { timeout: 30000 });
  // 표 로딩(시드 행 등장) 대기.
  await page.waitForFunction((t) => document.body.innerText.includes(t), `${TAG}-A`, { timeout: 30000 });

  // 컬럼 헤더 7종
  const body = await page.evaluate("document.body.innerText");
  const heads = ["크루 번호", "크루명", "소속 팀", "학교", "진행 라인", "라인 결과", "신청 시간"];
  ck("[표] 7컬럼 헤더(크루 번호/크루명/소속 팀/학교/진행 라인/라인 결과/신청 시간)", heads.every((h) => body.includes(h)));

  const rows = await readResultRows();
  ck("[표] 결과표 행 로드", Array.isArray(rows) && rows.length > 0, `rows=${rows?.length}`);
  // 컬럼 인덱스: 0 크루번호 1 크루명 2 소속팀 3 학교 4 진행라인 5 라인결과 6 신청시간
  const rowA = rows.find((r) => r[4] === `${TAG}-A`);
  const rowB = rows.find((r) => r[4] === `${TAG}-B`);
  const rowC = rows.find((r) => r[4] === `${TAG}-C`);
  ck("[검증5] 승인 크루 A → 라인 결과 '강화 성공'", !!rowA && rowA[5] === "강화 성공", rowA && `결과=${rowA[5]}`);
  ck("[검증6] 반려 크루 B → 라인 결과 '강화 실패'(진행 라인 표시)", !!rowB && rowB[5] === "강화 실패", rowB && `결과=${rowB[5]}`);
  ck("[정책] 강화 대기 크루 C → '강화 성공'", !!rowC && rowC[5] === "강화 성공", rowC && `결과=${rowC[5]}`);
  // 신청 시간 포맷 "26.07.06(월), 21:52"
  ck("[검증8] 신청 시간 포맷(YY.MM.DD(요일), HH:mm)", !!rowA && /\d{2}\.\d{2}\.\d{2}\(.\),\s*\d{2}:\d{2}/.test(rowA[6]), rowA && rowA[6]);
  // 미신청 활동 크루: 진행 라인 '미신청' + 강화 실패 + 신청 시간 '-'
  const rowUnapplied = rows.find((r) => r[4] === "미신청");
  ck("[검증7] 미신청 활동 크루 → 진행 라인 '미신청' · 강화 실패 · 신청 시간 '-'",
    !!rowUnapplied && rowUnapplied[5] === "강화 실패" && rowUnapplied[6] === "-", rowUnapplied && `결과=${rowUnapplied[5]} 시간=${rowUnapplied[6]}`);

  // 집계 카드 공존(회귀) — 활동/신청/개설/반려/신청라인/개설라인
  ck("[회귀] 집계 카드 6종 공존", ["활동 크루", "신청 크루", "개설 크루", "반려 크루", "신청 라인", "개설 라인"].every((t) => body.includes(t)));

  // 주차 변경 → 표 갱신(시드 행 사라짐)
  await page.click('button[aria-label="주차 선택"]');
  await page.waitForTimeout(300);
  const switched = await page.evaluate((week) => {
    const menu = [...document.querySelectorAll("div.absolute")].find((d) => d.querySelector("button"));
    const btns = menu ? [...menu.querySelectorAll("button")] : [];
    // 현재 선택과 다른 주차 옵션 클릭(두 번째 옵션 등).
    const target = btns[1] ?? btns[0];
    if (!target) return false;
    target.click();
    return true;
  }, WEEK);
  ck("[검증4] 주차 드롭다운에서 다른 주차 선택", switched);
  await page.waitForFunction((t) => !document.body.innerText.includes(t), `${TAG}-A`, { timeout: 15000 }).catch(() => {});
  const body2 = await page.evaluate("document.body.innerText");
  ck("[검증4] 주차 변경 시 표 갱신 — 이전 주차 시드 미노출", !body2.includes(`${TAG}-A`));

  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-competency-line-results.png"), fullPage: true });
  console.log("  screenshot → claudedocs/browser-competency-line-results.png");
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
  try { await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-competency-line-results-error.png"), fullPage: true }); } catch {}
} finally {
  await browser.close();
  await cleanup(WEEK);
  console.log("(cleanup 완료 — net-zero)");
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

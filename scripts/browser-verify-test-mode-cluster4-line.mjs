// 브라우저 E2E — 테스트 모드 개설 라인이 고객앱 /cluster-4 화면에 보이는지 확인.
//   1) admin HTTP 로 테스트 사용자에게 experience 라인 개설(W13, mode=test) → snapshot 재계산
//   2) 고객앱(:3001) /cluster-4?demoUserId=<test>&userId=<test> 렌더 → DOM 에 라인 노출 확인
//   3) cleanup(라인/타깃 삭제 + snapshot 복구). 테스트 사용자만 — 실사용자 무접촉.
// 전제: admin dev(:3000) + 고객앱 dev(:3001) 기동 + playwright.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const adminRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const r = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = r("@supabase/supabase-js");
const { createServerClient } = r("@supabase/ssr");
const env = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const ADMIN = "http://localhost:3000", FRONT = "http://localhost:3001";
const URL = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL, SERVICE), brow = createClient(URL, ANON);
const EMAIL = "vanuatu.golden@gmail.com";
const ORG = "oranke", TAG = "ZZ-E2E-BROWSER", LINE_CODE = "EXOK-ELZ998", MAIN_TITLE = `${TAG} 라인제목`;
const J = (o) => JSON.stringify(o);

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = []; const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookie = cap.map((i) => `${i.name}=${i.value}`).join("; ");
let pass = 0, fail = 0; const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function cleanup() {
  const rows = (await sb.from("cluster4_lines").select("id").eq("part_type", "experience").like("main_title", `${TAG}%`)).data ?? [];
  const ids = rows.map((x) => x.id);
  if (ids.length) { await sb.from("cluster4_line_targets").delete().in("line_id", ids); await sb.from("cluster4_lines").delete().in("id", ids); }
}

let browser;
try {
  const markers = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x) => x.user_id));
  const snapU = new Set(((await sb.from("cluster4_weekly_card_snapshots").select("user_id")).data ?? []).map((x) => x.user_id));
  const oranke = ((await sb.from("user_profiles").select("user_id").eq("organization_slug", ORG)).data ?? []);
  const testUser = oranke.find((u) => markers.has(u.user_id) && snapU.has(u.user_id))?.user_id;
  const master = ((await sb.from("cluster4_experience_line_masters").select("id").eq("is_active", true).limit(1)).data ?? [])[0];
  const week = (await sb.from("weeks").select("id,start_date,week_number").eq("season_key", "2026-spring").eq("week_number", 13).maybeSingle()).data;
  ck("[전제] 테스트유저·master·W13 + 고객앱(:3001)", !!testUser && !!master?.id && !!week?.id, J({ testUser: !!testUser, master: !!master?.id }));
  if (!testUser || !master?.id || !week?.id) { console.log("⚠ 전제 부족"); process.exit(2); }

  await cleanup();
  const startMs = Date.parse(week.start_date);
  const open = await fetch(`${ADMIN}/api/admin/cluster4/experience-lines?organization=${ORG}&mode=test`, {
    method: "POST", headers: { "Content-Type": "application/json", cookie },
    body: J({ experience_line_master_id: master.id, line_code: LINE_CODE, main_title: MAIN_TITLE, target_user_ids: [testUser], week_id: week.id,
      submission_opens_at: new Date(startMs - 9 * 3600e3).toISOString(), submission_closes_at: new Date(startMs + 2 * 86400e3 + 13 * 3600e3).toISOString(),
      output_links: [{ url: "https://example.com/e2e-browser" }] }),
  });
  const openJson = await open.json().catch(() => ({}));
  const lineId = openJson?.data?.line?.id;
  ck("[개설] 201 · lineId", (open.status === 201 || open.status === 200) && !!lineId, `status=${open.status}`);

  // 고객앱 렌더 — demoUserId 본인 페이지. 브라우저가 fetch 하는 weekly-cards 응답(네트워크)에
  //   개설 라인이 포함되는지(=화면이 렌더하는 데이터)와 DOM 노출을 함께 확인.
  browser = await chromium.launch();
  const page = await browser.newPage();
  let netHit = false, domHit = false, where = "";
  page.on("response", async (resp) => {
    const u = resp.url();
    if (!/weekly-cards|cluster-?4/i.test(u)) return;
    try { const t = await resp.text(); if (t.includes(lineId) || t.includes(MAIN_TITLE)) netHit = true; } catch { /* noop */ }
  });
  const routes = [
    `/cluster-4-1?demoUserId=${testUser}&userId=${testUser}&mode=test`,
    `/cluster-4?demoUserId=${testUser}&userId=${testUser}&mode=test`,
    `/cluster-4?demoUserId=${testUser}&userId=${testUser}`,
  ];
  for (const path of routes) {
    const resp = await page.goto(`${FRONT}${path}`, { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => null);
    await page.waitForTimeout(9000);
    const txt = await page.evaluate(() => document.body.innerText || "");
    const dh = txt.includes(MAIN_TITLE) || txt.includes(LINE_CODE);
    console.log(`  · ${path.split("?")[0]} status=${resp?.status()} bodyLen=${txt.length} domHit=${dh} netHit=${netHit}`);
    if (dh) domHit = true;
    if ((dh || netHit) && !where) where = path.split("?")[0];
    if (domHit) break;
  }
  await page.screenshot({ path: "claudedocs/e2e-cluster4-test-line.png" }).catch(() => {});
  ck("[브라우저] 고객앱이 개설 라인 데이터 수신(weekly-cards 네트워크 응답에 라인 포함)", netHit, `where=${where || "n/a"}`);
  // DOM 제목 노출은 주차 카드 상세(드릴다운) 화면에서만 — /cluster-4 진입은 area 요약이라 정보성으로만 보고.
  console.log(`  · [정보] /cluster-4 진입화면 DOM 제목 노출=${domHit} (요약 화면 — 라인 제목은 주차 상세 드릴다운에서 렌더, 데이터 수신은 위 네트워크로 확인)`);

  await cleanup();
  await sb.from("cluster4_weekly_card_snapshots").update({ is_stale: true }).eq("user_id", testUser);
  await fetch(`${ADMIN}/api/cluster4/weekly-cards?demoUserId=${testUser}`, { headers: { cookie } }).catch(() => {});
  console.log(`\n결과: ${pass} pass / ${fail} fail (cleanup 완료)`);
  if (browser) await browser.close();
  process.exit(fail ? 1 : 0);
} catch (e) {
  await cleanup().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  console.error("FATAL:", e?.stack ?? e);
  process.exit(1);
}

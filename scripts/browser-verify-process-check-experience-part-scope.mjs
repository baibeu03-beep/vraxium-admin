// 브라우저 검증 — 실무 경험 체크 팀·파트 스코프(실제 팀 구조 기준) (2026-06-15 개정).
//   드롭다운 파트 = 실제 팀 파트(user_memberships) · 스코프별 액트 필터 · 팀 전체=읽기전용 ·
//   (v4 적용 시) 파트별 독립 체크 클릭. seed 후 검증, net-zero. snapshot/points 무접촉.
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
const EMAIL = "vanuatu.golden@gmail.com", BASE = "http://localhost:3000";
const URL = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const HUB = "experience", ORG = "oranke", TEAM_NAME = "F&B", TAG = "ZZ-bpchk-part";
const J = (o) => JSON.stringify(o);
const sb = createClient(URL, SERVICE);

async function session() {
  const admin = createClient(URL, SERVICE), browser = createClient(URL, ANON);
  const { data: l } = await admin.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const { data: v } = await browser.auth.verifyOtp({ email: EMAIL, token: l.properties.email_otp, type: "magiclink" });
  const cap = [];
  const s = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await s.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return {
    cookieObjs: cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" })),
    cookieStr: cap.map((i) => `${i.name}=${i.value}`).join("; "),
  };
}
let pass = 0, fail = 0; const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function cleanup() {
  const g = (await sb.from("process_line_groups").select("id").eq("hub", HUB).like("name", `${TAG}%`)).data ?? [];
  const ids = g.map((x) => x.id);
  if (ids.length) {
    const acts = (await sb.from("process_acts").select("id").in("line_group_id", ids)).data ?? [];
    const aIds = acts.map((x) => x.id);
    if (aIds.length) {
      await sb.from("process_check_logs").delete().in("act_id", aIds);
      await sb.from("process_check_statuses").delete().in("act_id", aIds);
      await sb.from("process_acts").delete().in("id", aIds);
    }
    await sb.from("process_line_groups").delete().in("id", ids);
  }
}

const { cookieObjs, cookieStr } = await session();
const apiSeed = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json", cookie: cookieStr }, body: J(body) });
  return (await res.json().catch(() => ({}))).data;
};
const seedGroup = (name) => apiSeed("/api/admin/processes/line-groups", { hub: HUB, name });
const seedAct = (groupId, name) => apiSeed("/api/admin/processes/acts", {
  line_group_id: groupId, hub: HUB, act_name: name, duration_minutes: 10,
  occur_week: "N", occur_dow: 2, occur_time: "06:30", check_week: "N", check_dow: 3, check_time: "21:00",
  point_check: 1, point_advantage: 0, point_penalty: 0, cafe: "occur", check_target: "check", act_type: "required",
  overview: null, remarks: null,
});

const browser = await chromium.launch();
try {
  await cleanup();
  const v4 = !(await sb.from("process_check_statuses").select("part_name").limit(1)).error;
  console.log(v4 ? "▶ v4 적용 — 독립 클릭 포함" : "▶ v4 미적용 — UI(드롭다운/필터/읽기전용)만");

  const gOverall = await seedGroup(`${TAG} 총괄관리`);
  const gPart = await seedGroup(`${TAG} 가공파트`);
  await seedAct(gOverall?.id ?? gOverall, `${TAG} 총괄액트`);
  await seedAct(gPart?.id ?? gPart, `${TAG} 가공파트액트`);
  ck("[시드] 총괄+파트 라인급·액트", !!gOverall && !!gPart);

  const ctx = await browser.newContext();
  await ctx.addCookies(cookieObjs);
  const page = await ctx.newPage();
  // F&B 팀 직접 컨텍스트 — 첫 팀이 아닐 수 있어 탭 클릭으로 선택.
  await page.goto(`${BASE}/admin/processes/check/experience?org=${ORG}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  const fnbTab = page.locator("button", { hasText: new RegExp(`^${TEAM_NAME} 팀$`) }).first();
  if (await fnbTab.count()) { await fnbTab.click(); await page.waitForTimeout(1200); }

  const select = page.locator('select[aria-label="팀 & 파트 범위"]');
  await select.waitFor({ timeout: 8000 });
  const optLabels = await select.locator("option").allTextContents();
  ck("[드롭다운] 팀 전체/팀 총괄 옵션", optLabels.some((t) => t.includes("팀 전체")) && optLabels.some((t) => t.includes("팀 총괄")));
  ck("[드롭다운] 실제 팀 파트(맛집/음식·트렌드) 노출", optLabels.some((t) => t.includes("맛집/음식")) && optLabels.some((t) => t.includes("트렌드")), J(optLabels));

  // 스코프 전환 후 로딩(불러오는 중…)이 끝나고 테이블이 안정될 때까지 대기.
  const settle = async () => {
    await page.waitForFunction(() => !document.body.textContent?.includes("불러오는 중"), { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);
  };
  const measure = async () =>
    page.evaluate((tag) => {
      const rows = [...document.querySelectorAll("table tbody tr")].filter((tr) => (tr.textContent ?? "").includes(tag));
      let buttons = 0, badges = 0;
      for (const tr of rows) {
        const last = tr.querySelectorAll("td")[tr.querySelectorAll("td").length - 1];
        if (!last) continue;
        if (last.querySelector("button")) buttons++;
        else if (last.querySelector("span")) badges++;
      }
      return { rowCount: rows.length, buttons, badges };
    }, TAG);

  // "팀 & 파트" 컬럼 값 추출(TAG 행 한정, 첫 셀).
  const scopeCol = async () =>
    page.evaluate((tag) =>
      [...document.querySelectorAll("table tbody tr")]
        .filter((tr) => (tr.textContent ?? "").includes(tag))
        .map((tr) => tr.querySelector("td")?.textContent?.trim() ?? ""),
    TAG);

  await select.selectOption("all");
  await settle();
  let m = await measure();
  // 팀 전체 = 총괄액트 1 + 파트액트 펼침(맛집/음식·트렌드) 2 = 3행, 전부 읽기전용 배지.
  ck("[팀 전체] TAG 액트 3행(총괄 + 파트 펼침)", m.rowCount === 3, J(m));
  ck("[팀 전체] 읽기전용 배지(버튼 0)", m.buttons === 0 && m.badges === 3, J(m));
  const colAll = await scopeCol();
  ck(
    '[컬럼] 팀 전체 "팀 & 파트" = 팀 총괄/맛집·음식/트렌드 · "팀 전체" 미출현',
    colAll.includes("팀 총괄") && colAll.includes("맛집/음식") && colAll.includes("트렌드") && !colAll.includes("팀 전체"),
    J(colAll),
  );

  await select.selectOption("overall");
  await settle();
  m = await measure();
  ck("[팀 총괄] TAG 액트 1행(총괄만)·체크 버튼", m.rowCount === 1 && m.buttons === 1, J(m));
  ck('[컬럼] 팀 총괄 "팀 & 파트" = 팀 총괄', J(await scopeCol()) === J(["팀 총괄"]), J(await scopeCol()));

  await select.selectOption("맛집/음식");
  await settle();
  m = await measure();
  ck("[파트 맛집/음식] TAG 액트 1행(파트만)·체크 버튼", m.rowCount === 1 && m.buttons === 1, J(m));
  ck('[컬럼] 파트 "팀 & 파트" = 맛집/음식', J(await scopeCol()) === J(["맛집/음식"]), J(await scopeCol()));
  const body = (await page.locator("body").textContent()) ?? "";
  ck("[상태창2] 스코프 라벨(맛집/음식) 노출", /맛집\/음식/.test(body));

  if (v4) {
    // 파트별 독립 클릭 — 맛집/음식 체크 신청 → 트렌드 needed 무변경.
    const openCheck = async () => {
      await page.locator("table tbody tr", { hasText: TAG }).first().locator("button").click();
      await page.waitForTimeout(400);
    };
    await openCheck();
    await page.locator('input[placeholder^="https://cafe"]').fill("https://cafe.naver.com/x/1");
    // 날짜=내일, 시간 첫 슬롯.
    const d = await page.evaluate(() => { const t = new Date(Date.now() + 86400000); return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,"0")}-${String(t.getDate()).padStart(2,"0")}`; });
    await page.locator('input[type="date"]').fill(d);
    await page.locator('select[aria-label="검수 시각"]').selectOption({ index: 13 });
    await page.locator("button", { hasText: "체크 신청" }).click();
    await page.waitForTimeout(1200);
    m = await measure();
    ck("[독립] 맛집/음식 신청 후 상태 버튼=체크 대기", /체크 대기/.test((await page.locator("table tbody tr", { hasText: TAG }).first().textContent()) ?? ""), J(m));
    // 트렌드로 전환 → 여전히 체크 필요(무변경).
    await select.selectOption("트렌드");
    await page.waitForTimeout(700);
    const trendRow = (await page.locator("table tbody tr", { hasText: TAG }).first().textContent()) ?? "";
    ck("[독립] 트렌드 파트는 체크 필요(맛집/음식 신청 영향 없음)", /체크 필요/.test(trendRow), trendRow.slice(0, 40));
  }
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally {
  await browser.close();
  await cleanup().catch(() => {});
  console.log(`\n결과: ${pass} pass / ${fail} fail (cleanup — net-zero)`);
  process.exit(fail > 0 ? 1 : 0);
}

// 브라우저 검증 — 실무 경험 <확장> 류 활성 표시가 주차 최신 설정(cluster4_week_opening_configs)을 따르는가.
//   SoT = /admin/team-parts/info/weeks/[weekId] 저장값(.practicalExperience.<teamId>.expansion).
//   ⚠ 옛 원장 cluster4_experience_extension_periods 는 활성 판정 불참(종류 표시 힌트 전용).
//
//   검증 항목(encre 기준 · 확장 OFF ↔ ON 실토글 라운드트립):
//     · 확장 OFF: "확장 주간" 배지 없음 / "(확장 주간 외)" 표기 / 확장 류 필수(*) 표시 없음 / 입력 disabled
//     · 확장 ON : 배지 노출 / "(확장 주간 외)" 사라짐 / 확장 류 필수(*) 표시 / 입력 활성
//     · 새로고침 후에도 동일(옛 값으로 자동 복귀 없음)
//     · operating == test 동일 표시
//   config 는 finally 에서 원본 그대로 복원한다(라인/개설/포인트/snapshot write 없음).
//
// 실행: node scripts/browser-verify-experience-expansion-week-config-sot.mjs
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
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL"),
  ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE), brow = createClient(URL_, ANON);
const EMAIL = "vanuatu.golden@gmail.com";
const ORG = "encre";

let pass = 0, fail = 0;
const ck = (l, ok, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = [];
const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1400 } });
await context.addCookies(cookies);
const page = await context.newPage();

const gotoAndReady = async (url) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await page.goto(url, { waitUntil: "domcontentloaded" }); }
    catch { await page.waitForTimeout(900); continue; }
    const ready = await page.waitForSelector('[data-slot="select-trigger"].w-56', { timeout: 20000 }).then(() => true).catch(() => false);
    if (ready) { await page.waitForTimeout(1200); return; }
    await page.waitForTimeout(900);
  }
  throw new Error("파트 Select 트리거 미등장(부트 실패)");
};
const openSelect = async () => {
  await page.locator('[data-slot="select-trigger"].w-56').first().click({ timeout: 15000 });
  await page.waitForTimeout(500);
};
const pickOverall = async () => {
  await openSelect();
  await page.locator('[data-slot="select-item"]', { hasText: "팀 총괄" }).first().click({ timeout: 15000 });
  // 팀 총괄 보드(그리드+아웃풋)는 서버 재조회 후 렌더된다 — 아웃풋 섹션 등장까지 기다린다.
  //   (여기서 성급히 읽으면 확장 배지/필수 표시가 아직 없는 중간 상태를 잡아 오탐이 난다.)
  await page.waitForFunction(() => /아웃풋 링크/.test(document.body.innerText || ""), { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
};

// 화면에서 확장 류 표시 상태를 읽는다.
//   · 상태창 블록2 문구 = 허브·주차 단위로 항상 렌더(가장 안정적인 지표).
//   · 아웃풋 [확장 류] 블록 = 팀이 "개설 검수" 단계에 도달했을 때만 렌더 → 없으면 null(해당 단계 아님).
const readExpansionUi = () =>
  page.evaluate(() => {
    const bodyText = document.body.innerText || "";
    const titles = Array.from(document.querySelectorAll("p.text-sm.font-medium"));
    const extTitle = titles.find((p) => (p.textContent || "").includes("[확장 류]"));
    const block = extTitle ? extTitle.parentElement : null;
    let requiredStar = null, inputDisabled = null;
    if (block) {
      const label = Array.from(block.querySelectorAll("label")).find((l) => (l.textContent || "").includes("링크1"));
      requiredStar = label ? !!label.querySelector("span.text-destructive") : null;
      const input = block.querySelector("input");
      inputDisabled = input ? input.disabled : null;
    }
    return {
      // 상태창 블록2(lineOpeningStatusEngine buildBlock2)
      statusNotPeriod: /<확장> 류 라인 해당 기간이 아닙니다/.test(bodyText),
      statusIsPeriod: /<확장> 류 라인 중 .*해당 기간입니다/.test(bodyText),
      statusOnline: /<확장> 류 라인 중 [‘'"]?온라인/.test(bodyText),
      // 팀 총괄 아웃풋 섹션(개설 검수 단계에서만 렌더)
      badge: /확장 주간 ·/.test(bodyText),
      outsideNote: /\(확장 주간 외\)/.test(bodyText),
      hasExtTitle: !!extTitle,
      requiredStar,
      inputDisabled,
    };
  });

const teamIdsFor = async (weekId) => {
  const { data } = await sb
    .from("cluster4_week_opening_configs")
    .select("config")
    .eq("week_id", weekId).eq("organization_slug", ORG).maybeSingle();
  return Object.keys(data?.config?.practicalExperience ?? {});
};

// 대상 주차 = 개설 화면이 실제로 보고 있는 주차(상태창 API 의 targetWeekId).
const statusRes = await fetch(`${BASE}/api/admin/cluster4/experience/opening-status?organization=${ORG}`, {
  headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") },
});
const statusJson = await statusRes.json();
const weekId = statusJson?.data?.targetWeekId;
const { data: weekRow } = await sb.from("weeks").select("start_date,end_date,week_number").eq("id", weekId).maybeSingle();
console.log(`대상 주차: ${weekRow?.start_date}~${weekRow?.end_date} (W${weekRow?.week_number}) org=${ORG}`);

const { data: origRow } = await sb
  .from("cluster4_week_opening_configs")
  .select("config").eq("week_id", weekId).eq("organization_slug", ORG).maybeSingle();
const originalConfig = origRow?.config ?? null;
if (!originalConfig) { console.error("원본 config 없음 — 중단"); process.exit(1); }
const teamIds = await teamIdsFor(weekId);
console.log(`대상 팀 ${teamIds.length}개 · 현재 저장된 expansion = ${teamIds.map((t) => originalConfig.practicalExperience[t]?.expansion).join(",")}`);

const setExpansion = async (value) => {
  const next = JSON.parse(JSON.stringify(originalConfig));
  for (const t of teamIds) next.practicalExperience[t].expansion = value;
  await sb.from("cluster4_week_opening_configs").update({ config: next })
    .eq("week_id", weekId).eq("organization_slug", ORG);
};

try {
  // ── [1] 확장 OFF(현재 저장 상태 = 관리자가 끈 값) ──
  console.log("\n[1] 확장 OFF — 주차 최신 설정 = false (옛 기간 원장은 online 겹침)");
  await setExpansion(false);
  await gotoAndReady(`${BASE}/admin/line-opening/practical-experience?org=${ORG}&tab=open`);
  await pickOverall();
  const off = await readExpansionUi();
  ck("[1-1] 상태창: '<확장> 류 라인 해당 기간이 아닙니다' 노출", off.statusNotPeriod === true, `notPeriod=${off.statusNotPeriod}`);
  ck("[1-2] 상태창: '해당 기간입니다' 미노출(옛 원장 online 이어도)", off.statusIsPeriod === false, `isPeriod=${off.statusIsPeriod}`);
  ck("[1-3] '확장 주간 · 온라인' 배지 미노출", off.badge === false, `badge=${off.badge}`);
  if (off.hasExtTitle) {
    ck("[1-4] 확장 류 필수(*) 표시 없음", off.requiredStar === false, `star=${off.requiredStar}`);
    ck("[1-5] 확장 류 입력 비활성(선택 불필요)", off.inputDisabled === true, `disabled=${off.inputDisabled}`);
  } else {
    console.log("    · 아웃풋 [확장 류] 블록 미렌더 — 이 팀은 개설 검수 단계 이전(해당 없음, 미검증)");
  }
  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "expansion-sot-off.png"), fullPage: false }).catch(() => {});

  // 새로고침 후에도 동일(옛 값으로 자동 복귀 없음)
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-slot="select-trigger"].w-56', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await pickOverall();
  const offAgain = await readExpansionUi();
  ck("[1-6] 새로고침 후에도 확장 비활성 유지(옛 원장으로 복귀 없음)",
    offAgain.statusNotPeriod === true && offAgain.statusIsPeriod === false && offAgain.badge === false,
    `notPeriod=${offAgain.statusNotPeriod} isPeriod=${offAgain.statusIsPeriod} badge=${offAgain.badge}`);

  // ── [2] 확장 ON ──
  console.log("\n[2] 확장 ON — 주차 최신 설정 = true");
  await setExpansion(true);
  await gotoAndReady(`${BASE}/admin/line-opening/practical-experience?org=${ORG}&tab=open`);
  await pickOverall();
  const on = await readExpansionUi();
  ck("[2-1] 상태창: '<확장> 류 라인 중 온라인 해당 기간입니다' 노출", on.statusIsPeriod === true && on.statusOnline === true, `isPeriod=${on.statusIsPeriod} online=${on.statusOnline}`);
  ck("[2-2] 상태창: '해당 기간이 아닙니다' 사라짐", on.statusNotPeriod === false, `notPeriod=${on.statusNotPeriod}`);
  ck("[2-3] '확장 주간 · 온라인' 배지 노출", on.badge === true, `badge=${on.badge}`);
  if (on.hasExtTitle) {
    ck("[2-4] 확장 류 필수(*) 표시", on.requiredStar === true, `star=${on.requiredStar}`);
    ck("[2-5] 확장 류 입력 활성", on.inputDisabled === false, `disabled=${on.inputDisabled}`);
  } else {
    console.log("    · 아웃풋 [확장 류] 블록 미렌더 — 이 팀은 개설 검수 단계 이전(해당 없음, 미검증)");
  }
  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "expansion-sot-on.png"), fullPage: false }).catch(() => {});

  // ── [3] 다시 OFF (양방향 반영) ──
  console.log("\n[3] 다시 확장 OFF — 양방향 즉시 반영");
  await setExpansion(false);
  await gotoAndReady(`${BASE}/admin/line-opening/practical-experience?org=${ORG}&tab=open`);
  await pickOverall();
  const off2 = await readExpansionUi();
  ck("[3-1] 상태창 문구 다시 '해당 기간이 아닙니다'", off2.statusNotPeriod === true && off2.statusIsPeriod === false, `notPeriod=${off2.statusNotPeriod} isPeriod=${off2.statusIsPeriod}`);
  ck("[3-2] 배지 다시 미노출", off2.badge === false);

  // ── [4] operating == test ──
  console.log("\n[4] operating == test 동일 표시");
  await gotoAndReady(`${BASE}/admin/line-opening/practical-experience?org=${ORG}&tab=open&mode=test`);
  await pickOverall();
  const testUi = await readExpansionUi();
  ck("[4-1] test 모드도 확장 판정 동일(모드는 모집단만 가른다)",
    testUi.statusNotPeriod === off2.statusNotPeriod && testUi.statusIsPeriod === off2.statusIsPeriod && testUi.badge === off2.badge,
    `test notPeriod=${testUi.statusNotPeriod} badge=${testUi.badge} / op notPeriod=${off2.statusNotPeriod} badge=${off2.badge}`);
} finally {
  await sb.from("cluster4_week_opening_configs").update({ config: originalConfig })
    .eq("week_id", weekId).eq("organization_slug", ORG);
  const { data: restored } = await sb
    .from("cluster4_week_opening_configs").select("config")
    .eq("week_id", weekId).eq("organization_slug", ORG).maybeSingle();
  ck("[5] config 원본 완전 복원(잔여물 0)",
    JSON.stringify(restored?.config) === JSON.stringify(originalConfig));
  await browser.close();
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

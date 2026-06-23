// 브라우저 검증 — /admin/processes/check/{info,experience} 주차 선택 UI(공용 WeekSelectRow).
//   현재 주차 기본·미래 미노출·날짜/상태 배지·과거 주차 조회전용(쓰기 버튼 비활성)·experience 팀 탭 회귀.
//   스크린샷: claudedocs/process-check-week-ui.png. 전제: dev 서버.
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
const ORG = "oranke", TAG = "ZZ-pcw-browser";
const sb = createClient(URL, SERVICE);

async function cookies() {
  const browser = createClient(URL, ANON);
  const { data: l } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const { data: v } = await browser.auth.verifyOtp({ email: EMAIL, token: l.properties.email_otp, type: "magiclink" });
  const cap = [];
  const s = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await s.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}
let pass = 0, fail = 0; const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function cleanup() {
  const acts = (await sb.from("process_acts").select("id").like("act_name", `${TAG}%`)).data ?? [];
  const ids = acts.map((a) => a.id);
  if (ids.length) { await sb.from("process_check_statuses").delete().in("act_id", ids); await sb.from("process_check_logs").delete().in("act_id", ids); }
  await sb.from("process_acts").delete().like("act_name", `${TAG}%`);
  await sb.from("process_line_groups").delete().like("name", `${TAG}%`);
}

const browser = await chromium.launch();
try {
  const cks = await cookies();
  const cookieHdr = cks.map((c) => `${c.name}=${c.value}`).join("; ");
  await cleanup();

  // 필수 액트 시드(info) — '체크 필요' 버튼(쓰기 트리거) 노출용.
  const { data: g } = await sb.from("process_line_groups").insert({ hub: "info", name: `${TAG}라인` }).select("id").single();
  await sb.from("process_acts").insert({
    line_group_id: g.id, hub: "info", act_name: `${TAG}필수`, duration_minutes: 30,
    occur_week: "N", occur_dow: 1, occur_time: "10:00", check_week: "N", check_dow: 3, check_time: "12:00",
    point_check: 5, point_advantage: 2, point_penalty: 0, cafe: "occur", check_target: "check", act_type: "required", is_active: true,
  });

  // 현재/과거 주차 weekId.
  const board = JSON.parse(await (await fetch(`${BASE}/api/admin/processes/check?hub=info&org=${ORG}`, { headers: { cookie: cookieHdr } })).text());
  const curId = board.data.selectedWeekId;
  const pastOpt = (board.data.weeks ?? []).find((w) => !w.isCurrent && w.weekId);
  ck("[전제] 현재/과거 weekId 확보", !!curId && !!pastOpt, `cur=${!!curId} past=${pastOpt?.weekNumber}`);

  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await ctx.addCookies(cks);
  const page = await ctx.newPage();

  // ════ info(비팀) ════
  await page.goto(`${BASE}/admin/processes/check/info?org=${ORG}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);

  const sel = page.locator('#process-check-week-select-info');
  ck("[info] WeekSelectRow 드롭다운 존재", (await sel.count()) > 0);
  const opts = (await sel.locator('option').allTextContents()).map((t) => t.trim());
  ck("[info] 옵션 모두 연도+시즌+주차 형식", opts.length > 0 && opts.every((t) => /^\d{2}년 .+시즌 \d+주차( \(현재\))?$/.test(t)), JSON.stringify(opts.slice(0, 2)) + ` …(${opts.length})`);
  const selText = await page.$eval('#process-check-week-select-info', (el) => el.options[el.selectedIndex]?.textContent?.trim() ?? "");
  ck("[info] 현재 주차 기본 선택 '(현재)'", selText.includes("(현재)"), selText);
  const body = (await page.locator("body").textContent()) ?? "";
  ck("[info] 날짜 범위 표시", /\(\d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}\)/.test(body));
  ck("[info] 공식 활동/휴식 주차 배지", body.includes("공식 활동 주차") || body.includes("공식 휴식 주차"));

  // 한 줄 정렬(드롭다운/날짜/배지 center Y ±2px).
  const cy = async (loc) => { const b = await loc.boundingBox(); return b ? b.y + b.height / 2 : null; };
  const dateSpan = page.locator('span', { hasText: /^\(\d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}\)$/ }).first();
  const badge = page.locator('span', { hasText: /^공식 (활동|휴식) 주차$/ }).first();
  const centers = [await cy(sel), await cy(dateSpan), await cy(badge)].filter((x) => x != null);
  const spread = centers.length >= 2 ? Math.max(...centers) - Math.min(...centers) : 999;
  ck("[info] 한 줄 세로중앙 정렬(±2px)", spread <= 2, `spread=${spread.toFixed(2)}px`);
  await page.locator('#process-check-week-select-info').locator('xpath=..').screenshot({ path: resolve(adminRoot, "claudedocs", "process-check-week-ui.png") });

  // 현재 주차 — 시드 필수 액트 '체크 필요' 버튼 활성(쓰기 가능).
  const seedRow = page.locator(`tr:has-text("${TAG}필수")`).first();
  await seedRow.waitFor({ state: "visible", timeout: 8000 });
  const curBtn = seedRow.getByRole("button", { name: "체크 필요" });
  ck("[info·현재] '체크 필요' 버튼 활성(쓰기 가능)", (await curBtn.count()) > 0 && !(await curBtn.first().isDisabled()));

  // 과거 주차 선택 → 조회 전용 + 쓰기 버튼 비활성.
  await page.locator('#process-check-week-select-info').selectOption(pastOpt.weekId);
  await page.waitForTimeout(900);
  ck("[info·과거] 조회 전용 배지 표시", (await page.getByText("조회 전용").count()) > 0);
  const pastRow = page.locator(`tr:has-text("${TAG}필수")`).first();
  const pastBtn = pastRow.getByRole("button", { name: "체크 필요" });
  ck("[info·과거] '체크 필요' 버튼 비활성(쓰기 차단)", (await pastBtn.count()) > 0 && (await pastBtn.first().isDisabled()));

  // ════ experience(팀) — 회귀: 드롭다운 + 팀 탭 ════
  await page.goto(`${BASE}/admin/processes/check/experience?org=${ORG}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  ck("[exp] WeekSelectRow 드롭다운 존재", (await page.locator('#process-check-week-select-experience').count()) > 0);
  const expBody = (await page.locator("body").textContent()) ?? "";
  ck("[exp] 날짜/상태 배지 표시", /\(\d{4}-\d{2}-\d{2} ~/.test(expBody) && (expBody.includes("공식 활동 주차") || expBody.includes("공식 휴식 주차")));
  const teamTabs = await page.locator('button', { hasText: /팀$/ }).count();
  ck("[exp] 팀 탭 렌더(회귀)", teamTabs > 0, `tabs=${teamTabs}`);
  // 과거 주차 선택 → 조회 전용(팀 섹션도 쓰기 비활성 가드).
  await page.locator('#process-check-week-select-experience').selectOption(pastOpt.weekId);
  await page.waitForTimeout(900);
  ck("[exp·과거] 조회 전용 배지 표시", (await page.getByText("조회 전용").count()) > 0);

  // ════ club / competency(비팀) 스모크 — 드롭다운·현재 기본·과거 조회전용 ════
  for (const hub of ["club", "competency"]) {
    await page.goto(`${BASE}/admin/processes/check/${hub}?org=${ORG}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    const s = page.locator(`#process-check-week-select-${hub}`);
    const selT = (await s.count()) > 0 ? await page.$eval(`#process-check-week-select-${hub}`, (el) => el.options[el.selectedIndex]?.textContent?.trim() ?? "") : "";
    ck(`[${hub}] 드롭다운 + 현재 기본 '(현재)'`, (await s.count()) > 0 && selT.includes("(현재)"), selT);
    await s.selectOption(pastOpt.weekId);
    await page.waitForTimeout(700);
    ck(`[${hub}·과거] 조회 전용 배지`, (await page.getByText("조회 전용").count()) > 0);
  }
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally { await cleanup(); await browser.close(); console.log("(cleanup — net-zero)"); console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(fail > 0 ? 1 : 0); }

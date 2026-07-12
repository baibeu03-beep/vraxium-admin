// 브라우저 검증 — 프로세스 체크 예외 주차.
//   ① 설정 페이지(/admin/settings/process-check-windows) UX(주차+조직+허브 선택·목록) 렌더.
//   ② 예외 등록(oranke+info, 미래 주차) → 프로세스 체크 info 보드 드롭다운에 그 주차 등장 + 실제 선택 가능 +
//      선택 시 조회전용 아님(편집 가능·'체크 필요' 버튼 활성).
//   ③ 스코핑: 다른 org(encre) info 보드에는 그 주차 미노출.
//   ④ 삭제 후 즉시 드롭다운 제외.
//   스크린샷: claudedocs/process-check-windows-settings.png. 전제: dev 서버 + 마이그레이션.
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
const ORG = "oranke", OTHER = "encre", TAG = "ZZ-pcw-exc";
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

let futureWeekId = null;
async function cleanup() {
  const acts = (await sb.from("process_acts").select("id").like("act_name", `${TAG}%`)).data ?? [];
  const ids = acts.map((a) => a.id);
  if (ids.length) { await sb.from("process_check_statuses").delete().in("act_id", ids); await sb.from("process_check_logs").delete().in("act_id", ids); }
  await sb.from("process_acts").delete().like("act_name", `${TAG}%`);
  await sb.from("process_line_groups").delete().like("name", `${TAG}%`);
  if (futureWeekId) await sb.from("process_check_windows").delete().eq("week_id", futureWeekId);
}

const browser = await chromium.launch();
try {
  const cks = await cookies();
  const cookieHdr = cks.map((c) => `${c.name}=${c.value}`).join("; ");
  const H = { cookie: cookieHdr, "content-type": "application/json" };

  // 미래 주차(기본 드롭다운 미노출) 확보.
  const { data: latest } = await sb.from("weeks").select("id").order("start_date", { ascending: false }).limit(1).maybeSingle();
  futureWeekId = latest.id;
  await cleanup();

  // info 필수 액트 시드('체크 필요' 버튼 노출용).
  const { data: g } = await sb.from("process_line_groups").insert({ hub: "info", name: `${TAG}라인` }).select("id").single();
  await sb.from("process_acts").insert({
    line_group_id: g.id, hub: "info", act_name: `${TAG}필수`, duration_minutes: 30,
    occur_week: "N", occur_dow: 1, occur_time: "10:00", check_week: "N", check_dow: 3, check_time: "12:00",
    point_check: 5, point_advantage: 2, point_penalty: 0, cafe: "occur", check_target: "check", act_type: "required", is_active: true,
  });

  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await ctx.addCookies(cks);
  const page = await ctx.newPage();

  // ════ ① 설정 페이지 UX 렌더 ════
  await page.goto(`${BASE}/admin/settings/process-check-windows`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  ck("[설정] 제목 '프로세스 체크 예외 주차'", ((await page.locator("body").textContent()) ?? "").includes("프로세스 체크 예외 주차"));
  ck("[설정] 주차 선택 드롭다운(#pcw-week)", (await page.locator("#pcw-week").count()) > 0);
  ck("[설정] 클럽 범위 드롭다운(#pcw-org)", (await page.locator("#pcw-org").count()) > 0);
  ck("[설정] 프로세스 허브 드롭다운(#pcw-hub)", (await page.locator("#pcw-hub").count()) > 0);
  const orgOpts = (await page.locator("#pcw-org option").allTextContents()).map((t) => t.trim());
  ck("[설정] 조직 옵션(전체/Encre/Oranke/Phalanx)", ["전체 클럽", "Encre", "Oranke", "Phalanx"].every((o) => orgOpts.includes(o)), JSON.stringify(orgOpts));
  const hubOpts = (await page.locator("#pcw-hub option").allTextContents()).map((t) => t.trim());
  ck("[설정] 허브 옵션(전체/클럽/실무정보/실무경험/역량…)", hubOpts.some((o) => o.includes("클럽")) && hubOpts.some((o) => o.includes("실무 정보")) && hubOpts.some((o) => o.includes("실무 경험")) && hubOpts.some((o) => o.includes("역량")), `${hubOpts.length}개`);
  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "process-check-windows-settings.png"), fullPage: true });

  // ════ 예외 등록(API·oranke+info) — 등록 후 설정 목록 반영 ════
  const post = await (await fetch(`${BASE}/api/admin/process-check-windows`, { method: "POST", headers: H, body: JSON.stringify({ week_id: futureWeekId, organization_slug: ORG, hub: "info" }) })).json();
  ck("[등록] API POST 성공", !!post?.data?.window?.id);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  const listBody = (await page.locator("body").textContent()) ?? "";
  ck("[설정·목록] Oranke + 실무 정보 급 예외 표시", listBody.includes("Oranke") && listBody.includes("실무 정보 급") && listBody.includes("활성"));

  // ════ ② info 보드 — 예외 주차 드롭다운 등장 + 실제 선택 가능 + 편집 가능 ════
  await page.goto(`${BASE}/admin/processes/check/info?org=${ORG}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const sel = page.locator("#process-check-week-select-info");
  const optVals = await sel.locator("option").evaluateAll((els) => els.map((e) => e.value));
  ck("[info·oranke] 예외 주차가 드롭다운 옵션에 등장", optVals.includes(futureWeekId), `옵션 ${optVals.length}개`);
  // 실제 선택.
  await sel.selectOption(futureWeekId);
  await page.waitForTimeout(900);
  const selected = await page.$eval("#process-check-week-select-info", (el) => el.value);
  ck("[info·oranke] 예외 주차 실제 선택됨", selected === futureWeekId);
  ck("[info·oranke] 조회 전용 아님(편집 가능)", (await page.getByText("조회 전용").count()) === 0);
  const seedRow = page.locator(`tr:has-text("${TAG}필수")`).first();
  await seedRow.waitFor({ state: "visible", timeout: 8000 });
  const btn = seedRow.getByRole("button", { name: "체크 필요" });
  ck("[info·oranke] 예외 주차에서 '체크 필요' 버튼 활성(생성/설정 가능)", (await btn.count()) > 0 && !(await btn.first().isDisabled()));

  // ════ ③ 스코핑 — 다른 org(encre)에는 미노출 ════
  await page.goto(`${BASE}/admin/processes/check/info?org=${OTHER}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const otherVals = await page.locator("#process-check-week-select-info option").evaluateAll((els) => els.map((e) => e.value));
  ck("[info·encre] 예외 주차 미노출(org 스코핑)", !otherVals.includes(futureWeekId));

  // ════ ④ 삭제 후 즉시 제외 ════
  await fetch(`${BASE}/api/admin/process-check-windows/${post.data.window.id}`, { method: "DELETE", headers: { cookie: cookieHdr } });
  await page.goto(`${BASE}/admin/processes/check/info?org=${ORG}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const afterVals = await page.locator("#process-check-week-select-info option").evaluateAll((els) => els.map((e) => e.value));
  ck("[삭제] 삭제 후 드롭다운에서 즉시 제외", !afterVals.includes(futureWeekId));
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally { await cleanup(); await browser.close(); console.log("(cleanup — net-zero)"); console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(fail > 0 ? 1 : 0); }

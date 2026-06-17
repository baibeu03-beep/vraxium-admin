// 브라우저 검증 — /admin/processes/register 액트 종류 드롭다운 '기타' 라벨 + 목록 '기타' 표시.
//   1) 드롭다운 옵션 텍스트 = [필수, 자율, 선발, 기타] · '기본' 미노출 · value(저장값)는 basic 유지.
//   2) basic 액트(저장값) 시드 → 등록된 액트 목록에 '기타'로 표시.
// net-zero: TAG 행 service-role 정리.
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
const adminEmail = "vanuatu.golden@gmail.com";
const BASE = "http://localhost:3000";
const SUPABASE_URL = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const TAG = "ZZ-basicUI";
const sbAdmin = createClient(SUPABASE_URL, SERVICE);

async function makeAdminCookies() {
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await sbAdmin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await browser.auth.verifyOtp({ email: adminEmail, token: linkData.properties.email_otp, type: "magiclink" });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (items) => captured.push(...items) } });
  await server.auth.setSession({ access_token: verifyData.session.access_token, refresh_token: verifyData.session.refresh_token });
  return captured.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}
async function cleanup() {
  const groups = (await sbAdmin.from("process_line_groups").select("id").like("name", `${TAG}%`)).data ?? [];
  const ids = groups.map((g) => g.id);
  if (ids.length) { await sbAdmin.from("process_acts").delete().in("line_group_id", ids); await sbAdmin.from("process_line_groups").delete().in("id", ids); }
}
let pass = 0, fail = 0;
const check = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

const cookies = await makeAdminCookies();
await cleanup();
// 클럽 허브 라인급 + basic 액트 직접 시드(service-role) → 목록 표시 검증용.
const grp = (await sbAdmin.from("process_line_groups").insert({ hub: "club", name: `${TAG} 라인급` }).select("id").single()).data;
await sbAdmin.from("process_acts").insert({
  line_group_id: grp.id, hub: "club", act_name: `${TAG} 기타액트`, duration_minutes: 10,
  occur_week: "N", occur_dow: 3, occur_time: "09:00", check_week: "N", check_dow: 3, check_time: "21:00",
  point_check: 3, point_advantage: 2, point_penalty: 0, cafe: "none", check_target: "check", act_type: "basic",
});

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 2400 } });
await context.addCookies(cookies);
const page = await context.newPage();
try {
  await page.goto(`${BASE}/admin/processes/register`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("document.body.innerText.includes('프로세스 등록')", undefined, { timeout: 30000 }).catch(() => {});

  // 1) 액트 종류 드롭다운 옵션 텍스트 + value 읽기.
  const opts = await page.evaluate(() => {
    const sel = document.querySelector('select[aria-label="액트 종류"]');
    if (!sel) return null;
    return [...sel.options].map((o) => ({ value: o.value, text: (o.textContent || "").trim() }));
  });
  check("[드롭다운] 옵션 텍스트 = 필수/자율/선발/기타", opts && JSON.stringify(opts.map((o) => o.text)) === JSON.stringify(["필수", "자율", "선발", "기타"]), JSON.stringify(opts?.map((o) => o.text)));
  check("[드롭다운] '기본' 라벨 미노출", opts && !opts.some((o) => o.text === "기본"));
  check("[드롭다운] 저장값(value) basic 유지", opts && opts.find((o) => o.text === "기타")?.value === "basic", opts?.find((o) => o.text === "기타")?.value);

  // 2) 등록된 액트 목록 — basic 액트가 '기타'로 표시.
  await page.waitForFunction((n) => document.body.innerText.includes(n), `${TAG} 기타액트`, { timeout: 15000 }).catch(() => {});
  const body = await page.evaluate("document.body.innerText");
  // 액트 행 한 줄: "[라인급] · 기타 · ..." 형태.
  const line = body.split("\n").find((l) => l.includes(`${TAG} 기타액트`)) ?? "";
  check("[목록] basic 액트가 '기타'로 표시", line.includes("기타") && !line.includes("기본"), line.trim());

  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-process-act-basic-label.png"), fullPage: true });
  console.log("  screenshot → claudedocs/browser-process-act-basic-label.png");
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e); fail++;
} finally {
  await browser.close(); await cleanup(); console.log("(cleanup 완료 — net-zero)");
}
console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);

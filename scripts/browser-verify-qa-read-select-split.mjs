// 브라우저(인증)+HTTP 검증: read=운영노출 / select+write=test전용.
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
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const SUPABASE_URL = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(SUPABASE_URL, SERVICE);
async function makeAdminCookies() {
  const b = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await sb.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await b.auth.verifyOtp({ email: adminEmail, token: linkData.properties.email_otp, type: "magiclink" });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (items) => captured.push(...items) } });
  await server.auth.setSession({ access_token: verifyData.session.access_token, refresh_token: verifyData.session.refresh_token });
  return captured.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}
let pass = 0, fail = 0;
const check = (label, ok, detail = "") => { console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); ok ? pass++ : fail++; };

// 표본 확보: 실유저 대상 experience 라인 (spring) + info 운영 라인 week/org
const testSet = new Set((await sb.from("test_user_markers").select("user_id")).data?.map((r) => r.user_id) ?? []);
const { data: sw } = await sb.from("weeks").select("id,week_number").eq("season_key","2026-spring");
const springIds = (sw??[]).map(w=>w.id); const wnum = Object.fromEntries((sw??[]).map(w=>[w.id,w.week_number]));
let exp=null, info=null;
for (const wid of springIds) {
  const { data } = await sb.from("cluster4_line_targets")
    .select("line_id,target_user_id,cluster4_lines!inner(part_type,is_active,line_code)")
    .eq("target_mode","user").eq("week_id",wid).eq("cluster4_lines.is_active",true);
  for (const r of (data??[])) {
    if (testSet.has(r.target_user_id)) continue;
    const code=r.cluster4_lines.line_code||""; const org=/EC/.test(code)?"encre":/OK/.test(code)?"oranke":/PX/.test(code)?"phalanx":"common";
    if (r.cluster4_lines.part_type==="experience" && !exp && org!=="common") exp={wid,org,lineId:r.line_id,uid:r.target_user_id};
    if (r.cluster4_lines.part_type==="info" && !info && org!=="common") info={wid,org,lineId:r.line_id};
  }
  if (exp&&info) break;
}
console.log(`표본 exp=${exp?`W${wnum[exp.wid]}/${exp.org}`:"없음"} info=${info?`W${wnum[info.wid]}/${info.org}`:"없음"}`);

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext();
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();
const org = exp?.org ?? info?.org ?? "oranke";
await page.goto(`${BASE}/admin/line-opening/practical-info?org=${org}`, { waitUntil: "domcontentloaded" });
const api = (path) => page.evaluate(async (u) => { const r = await fetch(u); const j = await r.json().catch(()=>({})); return { status: r.status, j }; }, `${BASE}${path}`);

console.log("\n── READ (운영 노출) ──");
if (exp) {
  const r = await api(`/api/admin/cluster4/lines?partType=experience&week_id=${exp.wid}&organization=${exp.org}`);
  const rows = r.j?.data?.rows ?? []; check("[HTTP] lines?partType=experience → 운영 라인 노출", rows.length>0 && rows.some(x=>x.id===exp.lineId), `rows=${rows.length}`);
  const t = await api(`/api/admin/cluster4/lines/${exp.lineId}/targets`);
  const trows = t.j?.data?.rows ?? []; check("[HTTP] 라인상세 targets → 실유저 포함", trows.some(x=>x.targetUserId===exp.uid), `targets=${trows.length}`);
}
if (info) {
  const r = await api(`/api/admin/cluster4/info-lines?week_id=${info.wid}&organization=${info.org}`);
  check("[HTTP] info-lines → 운영 라인 노출", (r.j?.data?.rows ?? []).length>0, `rows=${(r.j?.data?.rows??[]).length}`);
  const rr = await api(`/api/admin/cluster4/info-line-results?week_id=${info.wid}&organization=${info.org}`);
  check("[HTTP] info-line-results → openedLineCount>0", (rr.j?.data?.openedLineCount ?? 0)>0, `opened=${rr.j?.data?.openedLineCount}`);
}

console.log("\n── SELECT (test 전용 유지) ──");
const u = await api(`/api/admin/cluster4/users?organization=${org}`);
const uarr = u.j?.data ?? u.j ?? []; const uList = Array.isArray(uarr)?uarr:(uarr.users??[]);
check("[HTTP] /users 크루선택기 전원 test", uList.length>0 && uList.every(x=>testSet.has(x.userId)), `n=${uList.length}`);
const c = await api(`/api/admin/cluster4/crews?organization=${org}`);
const carr = c.j?.data ?? c.j ?? []; const cList = Array.isArray(carr)?carr:(carr.crews??[]);
check("[HTTP] /crews 선택기 전원 test", cList.every(x=>testSet.has(x.userId)), `n=${cList.length}`);

console.log("\n── 브라우저 DOM (화면 렌더) ──");
try {
  // 주차별 개설 결과 드롭다운에서 spring info 주차 선택 → 개설 라인 요약 반영
  const target = info ?? exp;
  await page.selectOption('select[aria-label="개설 결과 주차 선택"]', target.wid).catch(()=>{});
  await page.waitForTimeout(1500);
  const bodyText = await page.textContent("body");
  check("[DOM] practical-info 화면 정상 렌더(에러 배너 없음)", !!bodyText && !/불러오지 못했습니다/.test(bodyText));
} catch(e) { check("[DOM] practical-info 렌더", false, String(e).slice(0,60)); }

console.log(`\n결과: pass=${pass} fail=${fail}`);
await browser.close();
process.exit(fail>0?1:0);

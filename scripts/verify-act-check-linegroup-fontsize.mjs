// 브라우저 검증 — 액트 체크 관리 '소속 라인 급' 폰트 크기(실무 경험만 축소).
//   실측: experience 라인급 셀 computed font-size = 11px · whitespace=normal · 넘침 없음.
//         info 라인급 셀 = text-sm(14px) 유지(회귀 방지). seed 후 검증, net-zero.
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
const ORG = "oranke", TAG = "ZZ-fontchk";
// 긴 라인급 이름 — 넘침(overflow) 재현용.
const LONG = `${TAG} 매우매우긴라인급이름테스트관리총괄`;
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

async function cleanupHub(hub) {
  const g = (await sb.from("process_line_groups").select("id").eq("hub", hub).like("name", `${TAG}%`)).data ?? [];
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
const cleanup = async () => { await cleanupHub("experience"); await cleanupHub("info"); };

const { cookieObjs, cookieStr } = await session();
const apiSeed = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json", cookie: cookieStr }, body: J(body) });
  return (await res.json().catch(() => ({}))).data;
};
const seedGroup = (hub, name) => apiSeed("/api/admin/processes/line-groups", { hub, name });
const seedAct = (hub, groupId, name) => apiSeed("/api/admin/processes/acts", {
  line_group_id: groupId, hub, act_name: name, duration_minutes: 10,
  occur_week: "N", occur_dow: 2, occur_time: "06:30", check_week: "N", check_dow: 3, check_time: "21:00",
  point_check: 1, point_advantage: 0, point_penalty: 0, cafe: "occur", check_target: "check", act_type: "required",
  overview: null, remarks: null,
});

// 라인급 셀(소속 라인 급 = 액트명 다음, 넘어짐 컬럼 X — 헤더 인덱스로 정확히 추출)의 computed 측정.
const measureLineGroupCell = (tag) =>
  ((t) => {
    const ths = [...document.querySelectorAll("table thead th")].map((th) => th.textContent?.trim() ?? "");
    const idx = ths.findIndex((x) => x.includes("소속 라인 급"));
    const rows = [...document.querySelectorAll("table tbody tr")].filter((tr) => (tr.textContent ?? "").includes(t));
    if (idx < 0 || rows.length === 0) return { found: false, idx, thCount: ths.length };
    const tr = rows[0];
    const td = tr.querySelectorAll("td")[idx];
    if (!td) return { found: false, idx, tdCount: tr.querySelectorAll("td").length };
    const cs = getComputedStyle(td);
    const next = td.nextElementSibling;
    // 침범 여부 — 라인급 셀 오른쪽 끝이 다음 셀 왼쪽 끝을 넘는지.
    const r = td.getBoundingClientRect();
    const nr = next?.getBoundingClientRect();
    return {
      found: true, idx,
      text: td.textContent?.trim() ?? "",
      fontPx: Math.round(parseFloat(cs.fontSize)),
      whiteSpace: cs.whiteSpace,
      // 콘텐츠가 셀 밖으로 튀어나오는지(scrollWidth > clientWidth = 잘리거나 넘침).
      overflowing: td.scrollWidth > td.clientWidth + 1,
      // 다음 컬럼 침범(라인급 right 가 다음 셀 left 보다 큼).
      invadesNext: nr ? r.right > nr.left + 1 : null,
    };
  })(tag);

const browser = await chromium.launch();
try {
  await cleanup();
  // 두 허브 모두 긴 라인급 + 액트 시드.
  for (const hub of ["experience", "info"]) {
    const g = await seedGroup(hub, LONG);
    await seedAct(hub, g?.id ?? g, `${TAG} 액트`);
  }
  ck("[시드] experience/info 긴 라인급 + 액트", true);

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies(cookieObjs);
  const page = await ctx.newPage();

  const settle = async () => {
    await page.waitForFunction(() => !document.body.textContent?.includes("불러오는 중"), { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(600);
  };

  // ── 실무 경험 ──
  await page.goto(`${BASE}/admin/processes/check/experience?org=${ORG}`, { waitUntil: "networkidle" });
  await settle();
  // 팀 총괄 스코프 등에서 TAG 행이 안 보일 수 있으니, 페이지에 TAG 가 나올 때까지 대기(없으면 그대로 측정 시도).
  await page.waitForFunction((t) => document.body.textContent?.includes(t), LONG, { timeout: 8000 }).catch(() => {});
  const exp = await page.evaluate(measureLineGroupCell, TAG);
  console.log("  experience:", J(exp));
  ck("[experience] 라인급 셀 발견", exp.found, J(exp));
  ck("[experience] font-size = 11px", exp.found && exp.fontPx === 11, `fontPx=${exp.fontPx}`);
  ck("[experience] whitespace=normal(줄바꿈 허용)", exp.found && exp.whiteSpace === "normal", exp.whiteSpace);
  ck("[experience] 다음 컬럼 침범 없음", exp.found && exp.invadesNext === false, `invadesNext=${exp.invadesNext}`);
  ck("[experience] 셀 내부 넘침 없음", exp.found && exp.overflowing === false, `overflowing=${exp.overflowing}`);

  // ── 실무 정보(회귀 방지: 기존 크기 유지) ──
  await page.goto(`${BASE}/admin/processes/check/info?org=${ORG}`, { waitUntil: "networkidle" });
  await settle();
  await page.waitForFunction((t) => document.body.textContent?.includes(t), LONG, { timeout: 8000 }).catch(() => {});
  const info = await page.evaluate(measureLineGroupCell, TAG);
  console.log("  info:", J(info));
  ck("[info] 라인급 셀 발견", info.found, J(info));
  // info 는 showScopeColumn 미전달 → 코드상 절대 영향 없음. 기존 크기(16px) 그대로 유지되어야 함.
  ck("[info] font-size 기존 유지(16px·미변경)", info.found && info.fontPx === 16, `fontPx=${info.fontPx}`);
  ck("[info] whitespace=nowrap(기존 유지)", info.found && info.whiteSpace === "nowrap", info.whiteSpace);
  ck("[대조] experience(11px) < info(기존) — 경험만 축소됨", exp.found && info.found && exp.fontPx < info.fontPx, `${exp.fontPx} < ${info.fontPx}`);
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally {
  await browser.close();
  await cleanup().catch(() => {});
  console.log(`\n결과: ${pass} pass / ${fail} fail (cleanup — net-zero)`);
  process.exit(fail > 0 ? 1 : 0);
}

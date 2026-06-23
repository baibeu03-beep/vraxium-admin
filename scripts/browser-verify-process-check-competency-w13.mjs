// 브라우저 검증 — /admin/processes/check/competency 테스트 모드 W13 체크 버튼/모달 활성.
//   operating → "16주차"(현재·휴식, 버튼 비활성 가능) · test → "13주차"(예외) + 체크 버튼 활성 + 모달 오픈.
//   competency 액트 1건 시드(체크대상) → 검증 → cleanup(net-zero).
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
const sb = createClient(URL, SERVICE);
const HUB = "competency", ORG = "oranke", TAG = "ZZ-pchk-bw13";
const J = (o) => JSON.stringify(o);

async function session() {
  const browser = createClient(URL, ANON);
  const { data: l } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const { data: v } = await browser.auth.verifyOtp({ email: EMAIL, token: l.properties.email_otp, type: "magiclink" });
  const cap = [];
  const s = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await s.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return { tokens: v.session, cookies: cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" })) };
}
let pass = 0, fail = 0; const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function cleanup() {
  const g = (await sb.from("process_line_groups").select("id").eq("hub", HUB).like("name", `${TAG}%`)).data ?? [];
  const ids = g.map((x) => x.id);
  if (ids.length) {
    const acts = (await sb.from("process_acts").select("id").in("line_group_id", ids)).data ?? [];
    const actIds = acts.map((x) => x.id);
    if (actIds.length) {
      await sb.from("process_check_logs").delete().in("act_id", actIds);
      await sb.from("process_check_statuses").delete().in("act_id", actIds);
      await sb.from("process_acts").delete().in("id", actIds);
    }
    await sb.from("process_line_groups").delete().in("id", ids);
  }
}

const { cookies } = await session();
const api = async (path, body) => {
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: J(body) });
  return (await res.json().catch(() => ({}))).data;
};

const browser = await chromium.launch();
try {
  await cleanup();
  // 시드 — competency 체크대상 액트 1건.
  const g = await api("/api/admin/processes/line-groups", { hub: HUB, name: `${TAG} 라인급` });
  const a1 = await api("/api/admin/processes/acts", {
    line_group_id: g.id, hub: HUB, act_name: `${TAG} 대상1`, duration_minutes: 10,
    occur_week: "N", occur_dow: 2, occur_time: "06:30", check_week: "N", check_dow: 3, check_time: "21:00",
    point_check: 1, point_advantage: 0, point_penalty: 0, cafe: "occur", check_target: "check", act_type: "required",
    overview: null, remarks: null,
  });
  ck("[시드] competency 체크대상 액트", !!g?.id && !!a1?.id);

  const ctx = await browser.newContext();
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();

  // operating — 주차명 16주차.
  await page.goto(`${BASE}/admin/processes/check/${HUB}?org=${ORG}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const opLabel = (await page.getByLabel("주차명").textContent())?.trim() ?? "";
  ck("[운영] 주차명 = 16주차(현재 주차)", /16주차/.test(opLabel) && !/13주차/.test(opLabel), opLabel);

  // test — 주차명 13주차 + 체크 버튼 활성 + 모달 오픈.
  await page.goto(`${BASE}/admin/processes/check/${HUB}?org=${ORG}&mode=test`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const teLabel = (await page.getByLabel("주차명").textContent())?.trim() ?? "";
  ck("[테스트] 주차명 = 13주차(예외)", /13주차/.test(teLabel) && !/16주차/.test(teLabel), teLabel);

  // 시드 액트 행의 체크 버튼("체크 필요") — 활성(enabled) 확인.
  const btn = page.getByRole("button", { name: "체크 필요" }).first();
  await btn.waitFor({ state: "visible", timeout: 5000 });
  const enabled = await btn.isEnabled();
  ck("[테스트] '체크 필요' 버튼 활성(W13 변경 가능)", enabled);

  // 클릭 → 체크 신청 모달 오픈(링크 입력 노출).
  await btn.click();
  const modalOpen = await page.locator('input[placeholder="https://cafe.naver.com/..."]').first().isVisible().catch(() => false);
  ck("[테스트] 버튼 클릭 → 체크 신청 모달 오픈(링크 입력)", modalOpen);
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally { await browser.close(); await cleanup(); console.log("(cleanup — net-zero)"); console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(fail > 0 ? 1 : 0); }

/**
 * main(875a4b2) 기준 재검증 — "쿠키 파트의 모든 인원을 다른 파트로 이동" 시 선택 주차·이후 주차의
 *   존재표 및 상단 "운용 파트" 배지 강조가 **새로고침 없이** 즉시 사라지는지 확인.
 * 대상: encre QA 팀 "사운드(T)" — 실 데이터 오염 없이 검증할 수 있도록 "쿠키"/"케이크" 파트를 임시
 *   생성하고 테스트 전용 크루 1명을 배정한다. 종료 후 override·생성 파트 전부 정리.
 * 사전조건: dev :3000. Usage: node scripts/browser-verify-cookie-part-clear-badge.mjs
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const rq = createRequire(resolve(adminRoot, "package.json"));
let chromium;
try {
  ({ chromium } = rq("playwright-core"));
} catch {
  ({ chromium } = rq("playwright"));
}
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const sb = createClient(URL_, get("SUPABASE_SERVICE_ROLE_KEY"));
const brow = createClient(URL_, ANON);
const OVR = "cluster4_team_week_position_overrides";

let fail = 0;
let pass = 0;
const ck = (l, ok, d = "") => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${JSON.stringify(d)}` : ""}`);
};

async function cookiesFor() {
  const { data: admins } = await sb.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = admins?.[0]?.email;
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await brow.auth.verifyOtp({ email, token: link.properties.email_otp, type: "magiclink" });
  const cap = [];
  const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}

async function main() {
  const ORG = "encre";
  const MODE = "test";
  const TEAM = "사운드(T)";
  const COOKIE_PART = "쿠키";
  const OTHER_PART = "케이크";
  const WEEK5 = { id: "954f56af-0c07-4246-ae7d-b476c5225b30", start: "2026-07-27" };
  const WEEK6 = { id: "2c359d24-2251-406d-aa40-c42917a52878", start: "2026-08-03", label: "여름 6" };
  const WEEK7 = { id: "1dc3bcec-7fff-43a0-ba84-e1a0565e3875", start: "2026-08-10", label: "여름 7" };
  const WEEK8 = { id: "fa11886e-e465-4b1e-accf-1ce6c13d146c", start: "2026-08-17", label: "여름 8" };

  const { data: th } = await sb.from("cluster4_team_halves").select("id,team_name,half_key").eq("organization_slug", ORG).eq("team_name", TEAM).eq("half_key", "2026-H2").limit(1);
  const team = th?.[0];
  if (!team) {
    console.log("대상 팀 없음 — abort");
    process.exit(1);
  }

  const cookieHdr = (await cookiesFor()).map((c) => `${c.name}=${c.value}`).join("; ");
  const call = (path, init) =>
    fetch(`${BASE}${path}`, { ...init, headers: { cookie: cookieHdr, "content-type": "application/json", ...(init?.headers ?? {}) }, cache: "no-store" }).then(
      async (r) => ({ status: r.status, j: await r.json().catch(() => null) }),
    );

  let createdPartIds = [];
  let targetUser = null;
  const browser = await chromium.launch({ headless: true });
  try {
    // ── 0) 기존 카탈로그에 "쿠키"/"케이크"가 이미 있는지 확인 후, 없으면 생성 ──
    const { data: existingParts } = await sb.from("cluster4_team_parts").select("id,part_name").eq("team_half_id", team.id);
    const haveCookie = (existingParts ?? []).some((p) => p.part_name === COOKIE_PART);
    const haveOther = (existingParts ?? []).some((p) => p.part_name === OTHER_PART);
    for (const [name, have] of [[COOKIE_PART, haveCookie], [OTHER_PART, haveOther]]) {
      if (have) {
        console.log(`파트 이미 존재 — 생성 생략: ${name}`);
        continue;
      }
      const r = await call(`/api/admin/team-parts/info/team-detail/parts?mode=${MODE}`, {
        method: "POST",
        body: JSON.stringify({ organization: ORG, teamHalfId: team.id, name }),
      });
      ck(`파트 생성: ${name}`, r.status === 200 && r.j?.success, r.j);
    }
    const { data: partsAfter } = await sb.from("cluster4_team_parts").select("id,part_name").eq("team_half_id", team.id);
    createdPartIds = (partsAfter ?? [])
      .filter((p) => (p.part_name === COOKIE_PART && !haveCookie) || (p.part_name === OTHER_PART && !haveOther))
      .map((p) => p.id);

    // ── 1) 테스트 전용 크루(override 이력 없음·role=crew·현역) 확보 → 여름5부터 "쿠키"로 배정 ──
    const { data: mems } = await sb.from("user_memberships").select("user_id,part_name").eq("team_name", TEAM).eq("is_current", true);
    const { data: existingOvr } = await sb.from(OVR).select("user_id").eq("organization", ORG).eq("raw_team", TEAM);
    const dirty = new Set((existingOvr ?? []).map((r) => r.user_id));
    const { data: profs } = await sb.from("user_profiles").select("user_id,role,growth_status").in("user_id", (mems ?? []).map((m) => m.user_id));
    const roleByUser = new Map((profs ?? []).map((p) => [p.user_id, p]));
    const candidate = (mems ?? []).find((m) => {
      const p = roleByUser.get(m.user_id);
      return !dirty.has(m.user_id) && p?.role === "crew" && p?.growth_status !== "graduated";
    });
    ck("실험용 crew(override 이력 없음·현역) 확보", Boolean(candidate), candidate);
    targetUser = candidate.user_id;
    const { data: uprof } = await sb.from("user_profiles").select("display_name").eq("user_id", targetUser).limit(1);
    console.log(`대상 크루: ${uprof?.[0]?.display_name} (${targetUser})`);

    const { error: setupErr } = await sb.from(OVR).upsert(
      { user_id: targetUser, organization: ORG, week_id: WEEK5.id, week_start_date: WEEK5.start, raw_team: TEAM, raw_part: COOKIE_PART, position_code: "regular", created_by: "verify-script", updated_by: "verify-script" },
      { onConflict: "user_id,week_start_date,organization,raw_team" },
    );
    ck("여름5에 대상 크루를 '쿠키'로 배정(carry-forward 로 6·7·8도 쿠키)", !setupErr, setupErr?.message);

    // ── 2) 로그인 + 페이지 진입(여름6 선택 상태) ──
    const context = await browser.newContext({ viewport: { width: 1700, height: 1400 } });
    await context.addCookies(await cookiesFor());
    const page = await context.newPage();
    await page.goto(`${BASE}/admin/team-parts/info/${ORG}/${team.id}?mode=${MODE}&weekId=${WEEK6.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-team-detail-crew-table]", { timeout: 25000 });
    await page.waitForFunction(() => {
      const sel = document.getElementById("team-detail-week-select");
      return sel && sel.value !== "";
    }, { timeout: 25000 });

    const readMatrix = async () =>
      page.evaluate(() => {
        const rows = [...document.querySelectorAll("[data-pw-row]")];
        const out = {};
        for (const row of rows) {
          const part = row.getAttribute("data-pw-row");
          out[part] = [...row.querySelectorAll("[data-pw-cell]")].map((c) => c.getAttribute("data-pw-cell"));
        }
        return out;
      });
    const colIndexOf = async (label) =>
      (await page.evaluate((lbl) => [...document.querySelectorAll("table thead th")].findIndex((th) => th.textContent?.trim() === lbl), label)) - 1; // 라벨열 보정.
    const readBadge = async (name) =>
      page.evaluate((n) => {
        const el = document.querySelector(`[data-generated-part="${n}"]`);
        return el ? { operated: el.getAttribute("data-generated-part-operated"), text: el.textContent } : null;
      }, name);
    const readPartCount = async () => page.$eval("[data-team-detail-operated-part-count]", (el) => el.textContent.trim());

    const idx6 = await colIndexOf(WEEK6.label);
    const idx7 = await colIndexOf(WEEK7.label);
    const idx8 = await colIndexOf(WEEK8.label);
    ck("매트릭스 헤더 인덱스 확보", idx6 >= 0 && idx7 >= 0 && idx8 >= 0, { idx6, idx7, idx8 });

    // ── 3) 사전 상태 — 쿠키 ● (선택 주차+이후), 배지 강조(1) ──
    const pre = await readMatrix();
    ck("[사전] 여름6·7·8 쿠키 = ●", pre[COOKIE_PART]?.[idx6] === "1" && pre[COOKIE_PART]?.[idx7] === "1" && pre[COOKIE_PART]?.[idx8] === "1", pre[COOKIE_PART]);
    const preBadge = await readBadge(COOKIE_PART);
    ck("[사전] 상단 배지 쿠키 강조(data-generated-part-operated=1)", preBadge?.operated === "1", preBadge);

    // ── 4) 실제 UI로 "쿠키" 크루를 다른 파트("케이크")로 이동 후 저장 ──
    const partSelect = page.locator(`[data-crew-part-select="${targetUser}"]`);
    await partSelect.waitFor({ timeout: 15000 });
    ck("[사전] [B] 표에서 대상 크루의 현재 선택값 = 쿠키", (await partSelect.inputValue()) === COOKIE_PART, await partSelect.inputValue());
    await partSelect.selectOption(OTHER_PART);
    await page.click("[data-save-team-week-part-class]");
    await page.waitForFunction(() => {
      const btn = document.querySelector("[data-save-team-week-part-class]");
      return btn && btn.textContent?.includes("저장") && !btn.textContent?.includes("저장 중");
    }, { timeout: 20000 });
    await page.waitForTimeout(200); // React flush 만.

    // ── 5) 새로고침 없이 — 선택 주차·이후 주차 쿠키 즉시 빈칸 + 배지 강조 즉시 해제 ──
    const postNoReload = await readMatrix();
    ck("[핵심·새로고침 없음] 여름6 쿠키 = 빈칸", postNoReload[COOKIE_PART]?.[idx6] === "0", postNoReload[COOKIE_PART]);
    ck("[핵심·새로고침 없음] 여름7 쿠키 = 빈칸(이월)", postNoReload[COOKIE_PART]?.[idx7] === "0", postNoReload[COOKIE_PART]);
    ck("[핵심·새로고침 없음] 여름8 쿠키 = 빈칸(이월)", postNoReload[COOKIE_PART]?.[idx8] === "0", postNoReload[COOKIE_PART]);
    const postBadge = await readBadge(COOKIE_PART);
    ck("[핵심·새로고침 없음] 상단 배지 쿠키 강조 즉시 해제(operated=0)", postBadge?.operated === "0", postBadge);
    const postOtherBadge = await readBadge(OTHER_PART);
    ck("[핵심·새로고침 없음] 상단 배지 케이크는 강조로 전환(operated=1)", postOtherBadge?.operated === "1", postOtherBadge);
    const postCount = await readPartCount();
    console.log("새로고침 없음 — 파트 수 표시:", postCount);

    // ── 6) 새로고침 후에도 동일한지 ──
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-team-detail-crew-table]", { timeout: 25000 });
    await page.waitForTimeout(1000);
    const postReload = await readMatrix();
    ck(
      "[새로고침 후] 여름6·7·8 쿠키 = 빈칸 유지",
      postReload[COOKIE_PART]?.[idx6] === "0" && postReload[COOKIE_PART]?.[idx7] === "0" && postReload[COOKIE_PART]?.[idx8] === "0",
      postReload[COOKIE_PART],
    );
    const reloadBadge = await readBadge(COOKIE_PART);
    ck("[새로고침 후] 상단 배지 쿠키 강조 계속 해제", reloadBadge?.operated === "0", reloadBadge);

    console.log(`\n=== RESULT: PASS ${pass} / FAIL ${fail} ===`);
    await context.close();
  } finally {
    await browser.close();
    console.log("\n정리...");
    if (targetUser) {
      const { error } = await sb.from(OVR).delete().eq("organization", ORG).eq("raw_team", TEAM).eq("user_id", targetUser);
      console.log("override 삭제:", error?.message ?? "OK");
    }
    if (createdPartIds.length) {
      const { error } = await sb.from("cluster4_team_parts").delete().in("id", createdPartIds);
      console.log("생성 파트 삭제:", error?.message ?? "OK");
    } else {
      console.log("생성 파트 없음(기존 카탈로그 재사용) — 삭제 생략");
    }
  }
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

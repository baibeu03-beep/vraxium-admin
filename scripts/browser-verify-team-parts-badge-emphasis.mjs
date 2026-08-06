/**
 * 브라우저 검증 — 팀 상세 상단 "생성 파트" 배지의 선택 주차 기준 강조/중립 구분(2026-08).
 *   생성 파트는 전부 보여주되(삭제 없음), data-generated-part-operated="1|0" 로 강조 여부를 구분하고,
 *   "파트 수" 숫자와 강조 배지 개수가 정확히 일치해야 한다.
 * 사전조건: dev :3000. 대상 = encre QA 팀 "사운드(T)". 테스트용 유휴 파트 2개를 만들고 종료 시 정리한다.
 * Usage: node scripts/browser-verify-team-parts-badge-emphasis.mjs
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

let fail = 0;
let pass = 0;
const ck = (l, ok, d = "") => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${JSON.stringify(d)}` : ""}`);
};

async function cookies() {
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
  const TEAM = "사운드(T)";
  const { data: th } = await sb
    .from("cluster4_team_halves")
    .select("id,team_name")
    .eq("organization_slug", ORG)
    .eq("team_name", TEAM)
    .eq("half_key", "2026-H2")
    .eq("is_active", true)
    .limit(1);
  const team = th?.[0];
  if (!team) {
    console.log("대상 팀 없음 — abort");
    process.exit(1);
  }

  const IDLE1 = "배지검증idle1";
  const IDLE2 = "배지검증idle2";
  const cookieHdr = (await cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const call = (path, init) =>
    fetch(`${BASE}${path}`, { ...init, headers: { cookie: cookieHdr, "content-type": "application/json", ...(init?.headers ?? {}) }, cache: "no-store" }).then(
      async (r) => ({ status: r.status, j: await r.json().catch(() => null) }),
    );

  let createdPartIds = [];
  const browser = await chromium.launch({ headless: true });
  try {
    for (const name of [IDLE1, IDLE2]) {
      const r = await call(`/api/admin/team-parts/info/team-detail/parts?mode=test`, {
        method: "POST",
        body: JSON.stringify({ organization: ORG, teamHalfId: team.id, name }),
      });
      ck(`유휴 파트 생성: ${name}`, r.status === 200 && r.j?.success, r.j);
    }
    const { data: parts } = await sb.from("cluster4_team_parts").select("id,part_name").eq("team_half_id", team.id);
    createdPartIds = (parts ?? []).filter((p) => p.part_name === IDLE1 || p.part_name === IDLE2).map((p) => p.id);

    // 서버 기대값 — 선택 주차(=현재 주차, weekId 미지정) 운용 파트 집합('일반' 제외).
    const summaryRes = await call(
      `/api/admin/team-parts/info/team-detail/week-summary?organization=${ORG}&teamHalfId=${team.id}&mode=test`,
    );
    const operatedSet = new Set((summaryRes.j?.data?.operatedParts ?? []).map((p) => p.partName).filter((n) => n !== "일반"));
    console.log("서버 기대 운용 파트 집합:", [...operatedSet]);
    ck("유휴 파트 2개는 서버 기대 운용 집합에 없음", !operatedSet.has(IDLE1) && !operatedSet.has(IDLE2));

    const context = await browser.newContext({ viewport: { width: 1600, height: 1300 } });
    await context.addCookies(await cookies());
    const page = await context.newPage();
    await page.goto(`${BASE}/admin/team-parts/info/${ORG}/${team.id}?mode=test`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-team-detail-generated-parts]", { timeout: 25000 });
    await page.waitForFunction(
      () => document.querySelectorAll("[data-generated-part]").length > 0,
      { timeout: 25000 },
    );
    // week-summary 비동기 로드 대기(운용 파트 배지가 붙을 시간).
    await page.waitForTimeout(1500);

    const badges = await page.$$eval("[data-generated-part]", (els) =>
      els.map((el) => ({
        name: el.getAttribute("data-generated-part"),
        operated: el.getAttribute("data-generated-part-operated"),
        cls: el.className,
      })),
    );
    console.log("렌더된 배지:", badges);
    const countText = await page.$eval("[data-team-detail-operated-part-count]", (el) => el.textContent.trim());
    console.log("파트 수 표시:", countText);

    ck("모든 생성 파트가 여전히 표시됨(삭제 없음)", badges.some((b) => b.name === IDLE1) && badges.some((b) => b.name === IDLE2));
    ck(`유휴 파트 ${IDLE1} → data-generated-part-operated="0"`, badges.find((b) => b.name === IDLE1)?.operated === "0");
    ck(`유휴 파트 ${IDLE2} → data-generated-part-operated="0"`, badges.find((b) => b.name === IDLE2)?.operated === "0");
    for (const name of operatedSet) {
      const b = badges.find((x) => x.name === name);
      ck(`운용 파트 ${name} → data-generated-part-operated="1"`, b?.operated === "1", b);
    }
    const operatedBadgeCount = badges.filter((b) => b.operated === "1").length;
    ck("강조 배지 개수 == 파트 수 표시", String(operatedBadgeCount) === countText, {
      operatedBadgeCount,
      countText,
    });
    ck("강조 배지 개수 == 서버 운용 파트 집합 크기", operatedBadgeCount === operatedSet.size, {
      operatedBadgeCount,
      expected: operatedSet.size,
    });
    // 강조 배지 클래스에 emerald 계열이 실제로 적용됐는지(요구된 색상 계열).
    const emeraldBadge = badges.find((b) => b.operated === "1");
    if (emeraldBadge) {
      ck("강조 배지 클래스에 emerald 계열 포함", /emerald/.test(emeraldBadge.cls), emeraldBadge.cls);
    }

    console.log(`\n=== RESULT: PASS ${pass} / FAIL ${fail} ===`);
    await context.close();
  } finally {
    await browser.close();
    if (createdPartIds.length) {
      const { error } = await sb.from("cluster4_team_parts").delete().in("id", createdPartIds);
      console.log("정리(유휴 파트 삭제):", error?.message ?? "OK");
    }
  }
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

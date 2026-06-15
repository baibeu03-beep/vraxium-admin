// 브라우저(인증) HTTP 검증 — 실무 역량(practical-competency) 라인 개설 org+mode 스코프.
//   실제 admin 세션 쿠키로 호출:
//     1) 크루 검색/자동매칭 = cafe-line-crew GET (org+mode)
//     2) 활동 크루 집계/결과 = competency/applications GET (org+mode) → direct==HTTP
//     3) 수동 추가 가드 = competency/applications POST (운영+테스트 / 테스트+실 / 타org → 422, write 0)
//   direct==HTTP: direct 스냅샷(claudedocs/verify-competency-mode-scope-direct.json)과 결과 set 동일 비교.
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

const direct = JSON.parse(
  readFileSync(resolve(adminRoot, "claudedocs/verify-competency-mode-scope-direct.json"), "utf8"),
);

async function makeAdminCookies() {
  const admin = createClient(SUPABASE_URL, SERVICE);
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await browser.auth.verifyOtp({
    email: adminEmail, token: linkData.properties.email_otp, type: "magiclink",
  });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  return captured.map((i) => ({
    name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax",
  }));
}

// 테스트 마커 + 실사용자/타org 표본 확보(가드 422 케이스용, write 없음).
async function fixtures() {
  const admin = createClient(SUPABASE_URL, SERVICE);
  const { data: markers } = await admin.from("test_user_markers").select("user_id");
  const testIds = new Set((markers ?? []).map((m) => m.user_id));
  const { data: oranke } = await admin
    .from("user_profiles").select("user_id").eq("organization_slug", "oranke");
  const { data: encre } = await admin
    .from("user_profiles").select("user_id").eq("organization_slug", "encre");
  const orankeReal = (oranke ?? []).map((r) => r.user_id).find((id) => !testIds.has(id));
  const encreReal = (encre ?? []).map((r) => r.user_id).find((id) => !testIds.has(id));
  const testId = [...testIds][0];
  return { testId, orankeReal, encreReal };
}

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext();
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();
await page.goto(`${BASE}/admin/line-opening/practical-competency?org=oranke&tab=open`, { waitUntil: "domcontentloaded" });

async function httpGet(url) {
  return page.evaluate(async (u) => {
    const r = await fetch(u);
    const j = await r.json().catch(() => ({}));
    return { status: r.status, data: j?.data ?? null, success: j?.success ?? false };
  }, url);
}
async function httpPost(url, body) {
  return page.evaluate(async ({ u, b }) => {
    const r = await fetch(u, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b),
    });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, success: j?.success ?? false, error: j?.error ?? null };
  }, { u: url, b: body });
}

try {
  const fx = await fixtures();
  const ORGS = ["oranke", "encre", "phalanx"];

  // 1) 크루 검색(cafe-line-crew) operating/test — T 접두 분리.
  console.log("\n[1] 크루 검색 cafe-line-crew (org=oranke)");
  const csOp = await httpGet(`/api/admin/cluster4/cafe-line-crew?q=${encodeURIComponent("지")}&organization=oranke`);
  const csTs = await httpGet(`/api/admin/cluster4/cafe-line-crew?q=${encodeURIComponent("지")}&organization=oranke&mode=test`);
  const opT = (csOp.data?.crews ?? []).filter((c) => (c.name ?? "").startsWith("T"));
  const tsReal = (csTs.data?.crews ?? []).filter((c) => !(c.name ?? "").startsWith("T"));
  check("operating 검색 테스트(T) 0", csOp.status === 200 && opT.length === 0, `n=${csOp.data?.crews?.length}, T=${opT.length}`);
  check("test 검색 실사용자 0", csTs.status === 200 && tsReal.length === 0, `n=${csTs.data?.crews?.length}, real=${tsReal.length}`);

  // 2) 활동 크루 집계/결과 GET — direct==HTTP (set 동일).
  console.log("\n[2] applications GET — direct == HTTP");
  for (const org of ORGS) {
    for (const mode of ["operating", "test"]) {
      const qs = new URLSearchParams({ organization: org });
      if (mode === "test") qs.set("mode", "test");
      const r = await httpGet(`/api/admin/cluster4/competency/applications?${qs.toString()}`);
      const httpIds = (r.data?.results ?? []).map((x) => x.userId).sort();
      const d = direct.snapshot[org]?.[mode];
      const sameLen = d && d.userIds.length === httpIds.length;
      const sameSet = sameLen && d.userIds.every((id, i) => id === httpIds[i]);
      const activeEq = r.data?.summary?.activeCrews === d?.activeCrews;
      check(
        `${org}/${mode}: direct==HTTP (activeCrews ${d?.activeCrews}=${r.data?.summary?.activeCrews}, ids ${httpIds.length})`,
        r.status === 200 && sameSet && activeEq,
      );
      const tIds = new Set([...(r.data?.results ?? [])].map((x) => x.userId));
      void tIds;
    }
  }

  // 3) 수동 추가 POST 가드 — 혼입/타org 422 (write 0).
  console.log("\n[3] applications POST 수동추가 가드 (write 0)");
  const FAKE_MASTER = "00000000-0000-0000-0000-000000000000"; // master 검증 전에 스코프 가드가 먼저 422.
  // operating + 테스트계정 → 422(mode)
  const g1 = await httpPost(`/api/admin/cluster4/competency/applications`, {
    organization: "oranke", target_user_id: fx.testId, competency_line_master_id: FAKE_MASTER, line_name: "X",
  });
  check("operating + 테스트계정 → 422", g1.status === 422, `status=${g1.status}`);
  // test + 실사용자 → 422(mode)
  const g2 = await httpPost(`/api/admin/cluster4/competency/applications?mode=test`, {
    organization: "oranke", target_user_id: fx.orankeReal, competency_line_master_id: FAKE_MASTER, line_name: "X",
  });
  check("test + 실사용자 → 422", g2.status === 422, `status=${g2.status}`);
  // operating + 타org(encre 실사용자) → 422(org)
  const g3 = await httpPost(`/api/admin/cluster4/competency/applications`, {
    organization: "oranke", target_user_id: fx.encreReal, competency_line_master_id: FAKE_MASTER, line_name: "X",
  });
  check("operating + 타org 사용자 → 422", g3.status === 422, `status=${g3.status}`);

  // 부작용 0 — 가드 422 이후 oranke applications 행이 늘지 않았는지(가드는 insert 전 차단).
  const admin = createClient(SUPABASE_URL, SERVICE);
  const { count } = await admin
    .from("cluster4_competency_applications")
    .select("id", { count: "exact", head: true })
    .eq("organization_slug", "oranke")
    .in("target_user_id", [fx.testId, fx.encreReal].filter(Boolean));
  check("가드 422 → DB write 0(혼입 행 없음)", (count ?? 0) === 0, `count=${count}`);
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
} finally {
  await browser.close();
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);

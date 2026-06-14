// 브라우저(인증) HTTP 검증 — info-lines POST 의 org + mode target 가드.
//   cluster4_line_targets 에 (현재 org 소속) AND (현재 mode 모집단) 만 저장되도록 422 가드 확인.
//   가드는 parseBody 직후·주차검증 전 → dummy week UUID 로 충분(생성 0, 부작용 없음).
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

// id 확보: oranke 실/테스트, encre 실(cross-org).
const testSet = new Set((await sb.from("test_user_markers").select("user_id")).data?.map((r) => r.user_id) ?? []);
const { data: oranke } = await sb.from("user_profiles").select("user_id").eq("organization_slug", "oranke");
const { data: encre } = await sb.from("user_profiles").select("user_id").eq("organization_slug", "encre");
const orankeReal = (oranke ?? []).map((r) => r.user_id).find((id) => !testSet.has(id));
const orankeTest = (oranke ?? []).map((r) => r.user_id).find((id) => testSet.has(id));
const encreReal = (encre ?? []).map((r) => r.user_id).find((id) => !testSet.has(id));
const DUMMY_WEEK = "00000000-0000-4000-8000-000000000000";

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext();
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();
await page.goto(`${BASE}/admin/line-opening/practical-info?org=oranke&tab=open`, { waitUntil: "domcontentloaded" });

function body(targetId) {
  return { activity_type_id: "wisdom", main_title: "ORG-MODE-GUARD-HTTP(저장안됨)", output_links: [{ url: "https://example.com", label: "t" }], output_images: [], target_user_ids: [targetId], week_id: DUMMY_WEEK, submission_opens_at: "2026-01-01T00:00:00.000Z", submission_closes_at: "2026-01-02T00:00:00.000Z" };
}
async function post(org, mode, targetId) {
  const sp = new URLSearchParams();
  if (org) sp.set("organization", org);
  if (mode === "test") sp.set("mode", "test");
  return page.evaluate(async ({ url, b }) => {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, error: j?.error ?? "" };
  }, { url: `/api/admin/cluster4/info-lines${sp.toString() ? `?${sp.toString()}` : ""}`, b: body(targetId) });
}

try {
  console.log("orankeReal=", orankeReal, "orankeTest=", orankeTest, "encreReal=", encreReal);

  console.log("\n[org=oranke & mode=operating]");
  const a = await post("oranke", "operating", orankeReal);
  check("oranke 실사용자 → 가드 통과(이후 409, 422 아님)", a.status !== 422, `status=${a.status} ${a.error}`);
  const b = await post("oranke", "operating", encreReal);
  check("encre 실사용자(타org) → 422 org 가드", b.status === 422, `status=${b.status} ${b.error}`);
  const c = await post("oranke", "operating", orankeTest);
  check("oranke 테스트계정(운영모드) → 422 mode 가드", c.status === 422, `status=${c.status} ${c.error}`);

  console.log("\n[org=oranke & mode=test]");
  const d = await post("oranke", "test", orankeTest);
  check("oranke 테스트계정 → 가드 통과(이후 409, 422 아님)", d.status !== 422, `status=${d.status} ${d.error}`);
  const e = await post("oranke", "test", orankeReal);
  check("oranke 실사용자(테스트모드) → 422 mode 가드", e.status === 422, `status=${e.status} ${e.error}`);
  const f = await post("oranke", "test", encreReal);
  check("encre 사용자(타org, 테스트모드) → 422", f.status === 422, `status=${f.status} ${f.error}`);

  // 부작용 없음 — dummy week 라인 미생성.
  const { count } = await sb.from("cluster4_lines").select("id", { count: "exact", head: true }).eq("week_id", DUMMY_WEEK);
  check("dummy week 라인 미생성(부작용 0)", (count ?? 0) === 0, `count=${count}`);
} catch (err) {
  console.error("browser error:", err?.stack ?? err?.message ?? err); fail++;
} finally {
  await browser.close();
}
console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);

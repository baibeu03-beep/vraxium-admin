// 브라우저(인증) HTTP 검증 — info-lines POST 의 target 스코프 가드(422).
//   operating 에 테스트계정 / test 에 실사용자를 보내면 422(가드는 DB write 전 동작 → 생성 안 됨).
//   가드가 parseBody 직후·주차검증 전에 있으므로 week_id 는 임의 UUID 로 충분(존재 불필요).
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
const admin = createClient(SUPABASE_URL, ANON ? SERVICE : SERVICE);

async function makeAdminCookies() {
  const a = createClient(SUPABASE_URL, SERVICE);
  const b = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await a.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await b.auth.verifyOtp({
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

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

// 테스트/실사용자 id 확보.
const { data: markers } = await admin.from("test_user_markers").select("user_id").limit(1);
const testId = markers?.[0]?.user_id;
const { data: profs } = await admin.from("user_profiles").select("user_id").eq("organization_slug", "oranke");
const testSet = new Set((await admin.from("test_user_markers").select("user_id")).data?.map((r) => r.user_id) ?? []);
const realId = (profs ?? []).map((r) => r.user_id).find((id) => !testSet.has(id));
const DUMMY_WEEK = "00000000-0000-4000-8000-000000000000";

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext();
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();
await page.goto(`${BASE}/admin/line-opening/practical-info?org=oranke&tab=open`, { waitUntil: "domcontentloaded" });

function body(targetId) {
  return {
    activity_type_id: "wisdom",
    main_title: "SCOPE-GUARD-HTTP-TEST(저장안됨)",
    output_links: [{ url: "https://example.com", label: "t" }],
    output_images: [],
    target_user_ids: [targetId],
    week_id: DUMMY_WEEK,
    submission_opens_at: "2026-01-01T00:00:00.000Z",
    submission_closes_at: "2026-01-02T00:00:00.000Z",
  };
}
async function post(mode, targetId) {
  const qs = mode === "test" ? "?mode=test" : "";
  return page.evaluate(async ({ url, b }) => {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, error: j?.error ?? "" };
  }, { url: `/api/admin/cluster4/info-lines${qs}`, b: body(targetId) });
}

try {
  console.log("testId=", testId, "realId=", realId);
  const r1 = await post("operating", testId);
  check("operating + 테스트계정 → 422", r1.status === 422, `status=${r1.status} ${r1.error}`);
  const r2 = await post("test", realId);
  check("test + 실사용자 → 422", r2.status === 422, `status=${r2.status} ${r2.error}`);

  // 가드 통과 후엔 주차검증(존재X dummy)에서 막혀야 → 422 아님(=가드는 통과했다는 의미), 생성도 안 됨.
  const r3 = await post("operating", realId);
  check("operating + 실사용자 → 스코프 가드 통과(이후 주차검증서 4xx, 422 아님)", r3.status !== 422, `status=${r3.status} ${r3.error}`);

  // 실제 생성 안 됐는지 확인 — dummy week 로는 라인 미생성.
  const { count } = await admin.from("cluster4_lines").select("id", { count: "exact", head: true }).eq("week_id", DUMMY_WEEK);
  check("dummy week 로 라인 미생성(부작용 없음)", (count ?? 0) === 0, `count=${count}`);
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
} finally {
  await browser.close();
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);

/**
 * 검증 — 카카오 연결 7개 T사용자가 app-users 운영 모드에서 제외/테스트 모드에서 포함되는지.
 * direct function 결과 + 실제 HTTP 응답 + 둘의 일치 여부를 검증한다.
 *   1) dev 서버를 먼저 띄운다(localhost:3000).
 *   2) npx tsx --env-file=.env.local scripts/verify-kakao-operating-exclusion.ts
 *
 * READ-ONLY — 어떤 데이터도 수정하지 않는다.
 */
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { listAppUsers } from "@/lib/adminAppUsersData";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const SEVEN: Array<{ name: string; id: string }> = [
  { name: "T임시우", id: "a80ea67a-8836-4c13-8568-66dff79d7a66" },
  { name: "T황민서", id: "614f78f4-c372-4c11-a17f-46b9e7bd4523" },
  { name: "T조예린", id: "98807fea-2137-4160-ba5c-dedcbdced0e8" },
  { name: "T임다인", id: "42864260-e4ea-4150-a87f-cff545b02af1" },
  { name: "T장소율", id: "f980b257-12b1-4f9c-ae71-307336071785" },
  { name: "T정하은", id: "fff3941f-071c-4cca-b99a-da8bd6d2fae2" },
  { name: "T정시현", id: "70abfec0-660b-4af3-a940-5d318f76bd4e" },
];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function makeAdminCookies() {
  const { data: admins, error } = await supabaseAdmin
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  if (error) throw error;
  const email = (admins?.[0] as { email: string } | undefined)?.email;
  assert(email, "No active admin email");
  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  assert(link.properties?.email_otp && !linkError, linkError?.message ?? "generateLink failed");
  const { data: verified, error: verifyError } = await anon.auth.verifyOtp({
    email, token: link.properties.email_otp, type: "magiclink",
  });
  assert(verified.session && !verifyError, verifyError?.message ?? "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items.map(({ name, value }) => ({ name, value }))) },
  });
  await server.auth.setSession({
    access_token: verified.session.access_token,
    refresh_token: verified.session.refresh_token,
  });
  return captured.map(({ name, value }) => ({
    name, value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" as const,
  }));
}

async function main() {
  // ── 1) direct function ──
  const dOp = await listAppUsers({ mode: "operating", limit: 500 });
  const dTest = await listAppUsers({ mode: "test", limit: 500 });
  const dOpIds = new Set(dOp.data.map((u) => u.userId));
  const dTestIds = new Set(dTest.data.map((u) => u.userId));

  // ── 2) HTTP (authenticated) ──
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addCookies(await makeAdminCookies());
  let hOpIds: Set<string>, hTestIds: Set<string>, hOpTotal: number, hTestTotal: number;
  try {
    const opRes = await context.request.get(`${baseUrl}/api/admin/app-users`);
    const testRes = await context.request.get(`${baseUrl}/api/admin/app-users?mode=test`);
    assert(opRes.ok(), `operating HTTP ${opRes.status()}`);
    assert(testRes.ok(), `test HTTP ${testRes.status()}`);
    const opJson = await opRes.json();
    const testJson = await testRes.json();
    hOpIds = new Set((opJson.data ?? []).map((u: { userId: string }) => u.userId));
    hTestIds = new Set((testJson.data ?? []).map((u: { userId: string }) => u.userId));
    hOpTotal = Number(opJson.total ?? 0);
    hTestTotal = Number(testJson.total ?? 0);
  } finally {
    await browser.close();
  }

  // ── 3) report ──
  console.log(`\n[direct] operating total=${dOp.total} | test total=${dTest.total}`);
  console.log(`[http]   operating total=${hOpTotal} | test total=${hTestTotal} (기본 limit 200 적용)`);

  console.log(`\n사용자\t\tmode=test 포함(HTTP)\tmode=operating 제외(HTTP)\tdirect==HTTP`);
  let allPass = true;
  for (const { name, id } of SEVEN) {
    const testIn = hTestIds.has(id);                  // 포함돼야 PASS
    const opOut = !hOpIds.has(id);                    // 제외돼야 PASS
    const dirTestIn = dTestIds.has(id);
    const dirOpOut = !dOpIds.has(id);
    const match = testIn === dirTestIn && opOut === dirOpOut;
    const pass = testIn && opOut && match;
    if (!pass) allPass = false;
    console.log(
      `${name}\t test=${testIn ? "포함✅" : "누락❌"}\t operating=${opOut ? "제외✅" : "노출❌"}\t direct==HTTP=${match ? "✅" : "❌"}\t→ ${pass ? "PASS" : "FAIL"}`,
    );
  }
  console.log(`\n전체: ${allPass ? "PASS ✅" : "FAIL ❌"}`);
  if (!allPass) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });

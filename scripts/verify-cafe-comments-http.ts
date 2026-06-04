// HTTP API 검증: POST /api/admin/cluster4/cafe-comments
//   1) 무세션 → 401 (auth 게이트)
//   2) admin 세션 → 200 + 수집 결과
//   3) direct function 결과와 HTTP 응답 동일성 비교
// 사용법: npx tsx --env-file=.env.local scripts/verify-cafe-comments-http.ts <게시글URL> [baseUrl]
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { collectCafeCommentNicknames } from "../lib/naverCafeComments";

const baseUrl = process.argv[3] ?? process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

function ensureEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

async function makeAdminCookieHeader() {
  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const serviceRoleKey = ensureEnv("SUPABASE_SERVICE_ROLE_KEY");

  const admin = createClient(supabaseUrl, serviceRoleKey);
  const browser = createClient(supabaseUrl, anonKey);

  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: adminEmail,
  });
  if (linkError || !linkData?.properties?.email_otp) {
    throw new Error(linkError?.message ?? "Failed to generate admin magic link");
  }

  const { data: verifyData, error: verifyError } = await browser.auth.verifyOtp({
    email: adminEmail,
    token: linkData.properties.email_otp,
    type: "magiclink",
  });
  if (verifyError || !verifyData.session) {
    throw new Error(verifyError?.message ?? "Failed to verify admin OTP");
  }

  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll() {
        return [];
      },
      setAll(items) {
        captured.push(...items.map((item) => ({ name: item.name, value: item.value })));
      },
    },
  });

  const { error: setError } = await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  if (setError) throw new Error(setError.message);

  return captured.map((item) => `${item.name}=${item.value}`).join("; ");
}

const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail: string) {
  checks.push({ name, pass, detail });
}

async function main() {
  const articleUrl = process.argv[2];
  if (!articleUrl) {
    console.error("게시글 URL 인자가 필요합니다.");
    process.exit(1);
  }

  // 1) 무세션 → 401
  const noAuth = await fetch(`${baseUrl}/api/admin/cluster4/cafe-comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: articleUrl }),
  });
  check("무세션 401(auth 게이트)", noAuth.status === 401, `status=${noAuth.status}`);

  // 2) admin 세션 → 200
  const cookieHeader = await makeAdminCookieHeader();
  const res = await fetch(`${baseUrl}/api/admin/cluster4/cafe-comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieHeader },
    body: JSON.stringify({ url: articleUrl }),
  });
  const rawBody = await res.text();
  let json: {
    success?: boolean;
    data?: { totalComments: number; uniqueNicknames: number; nicknames: string[] };
  } = {};
  try {
    json = JSON.parse(rawBody);
  } catch {
    /* non-JSON body — rawBody 로 출력 */
  }
  check(
    "admin 세션 200 + success",
    res.status === 200 && json.success === true,
    res.status === 200 && json.success === true
      ? `status=${res.status} total=${json.data?.totalComments} unique=${json.data?.uniqueNicknames}`
      : `status=${res.status} body=${rawBody.slice(0, 400)}`,
  );

  // 3) direct vs HTTP 동일성
  const direct = await collectCafeCommentNicknames(articleUrl);
  if (!direct.ok) {
    check("direct 수집 성공", false, `${direct.error}: ${direct.message}`);
  } else if (json.data) {
    const sameTotal = direct.data.totalComments === json.data.totalComments;
    const sameUnique = direct.data.uniqueNicknames === json.data.uniqueNicknames;
    const directSet = new Set(direct.data.nicknames);
    const httpSet = new Set(json.data.nicknames);
    const sameNicknames =
      directSet.size === httpSet.size && [...directSet].every((n) => httpSet.has(n));
    check(
      "direct == HTTP (total/unique/nicknames)",
      sameTotal && sameUnique && sameNicknames,
      `direct={total:${direct.data.totalComments},unique:${direct.data.uniqueNicknames}} http={total:${json.data.totalComments},unique:${json.data.uniqueNicknames}} nicknamesEqual=${sameNicknames}`,
    );
  }

  let failed = 0;
  for (const c of checks) {
    if (!c.pass) failed++;
    console.log(`${c.pass ? "PASS" : "FAIL"} | ${c.name} | ${c.detail}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main();

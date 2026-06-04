/**
 * 실제 HTTP 검증 — GET /api/admin/members 의 statusLabel 이
 * membership_level SoT 기준으로 내려오는지 확인한다.
 *
 *   기대:
 *     - T최수빈 (role=part_leader, level=일반)  → statusLabel "일반"
 *     - T임시우 (role=part_leader, level=심화)  → statusLabel "심화(파트장)"
 *
 *   사전조건: dev 서버 기동 (기본 http://localhost:3010, SMOKE_BASE_URL 로 변경).
 *   npx tsx --env-file=.env.local scripts/verify-members-status-label-http.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3010";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

function ensureEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

// cluster4-line-smoke.ts 와 동일한 admin 세션 쿠키 생성 (magiclink OTP).
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

type MemberDto = {
  userId: string;
  displayName: string | null;
  role: string | null;
  membershipLevel: string | null;
  statusLabel: string;
  status: string | null;
};

async function fetchMemberByName(cookieHeader: string, name: string) {
  const res = await fetch(
    `${baseUrl}/api/admin/members?q=${encodeURIComponent(name)}&limit=10`,
    { headers: { Cookie: cookieHeader } },
  );
  const json = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    error?: string;
    data?: { members?: MemberDto[] };
  };
  if (!res.ok || !json.success) {
    throw new Error(`GET /api/admin/members q=${name} → ${res.status} ${json.error ?? ""}`);
  }
  const member = (json.data?.members ?? []).find((m) =>
    (m.displayName ?? "").includes(name),
  );
  if (!member) throw new Error(`member not found in HTTP response: ${name}`);
  return member;
}

async function main() {
  const cookieHeader = await makeAdminCookieHeader();

  const cases: Array<{ name: string; expected: string }> = [
    { name: "최수빈", expected: "일반" }, // role=part_leader 인데 level=일반 → 파트장 금지
    { name: "임시우", expected: "심화(파트장)" }, // role=part_leader + level=심화
  ];

  let failed = 0;
  for (const c of cases) {
    const m = await fetchMemberByName(cookieHeader, c.name);
    const ok = m.statusLabel === c.expected;
    if (!ok) failed += 1;
    console.log(
      `${ok ? "PASS" : "FAIL"} ${m.displayName} → statusLabel=${JSON.stringify(m.statusLabel)} (기대 ${JSON.stringify(c.expected)}) [role=${m.role}, membershipLevel=${m.membershipLevel}]`,
    );
  }

  if (failed > 0) {
    console.error(`\n${failed}건 실패`);
    process.exit(1);
  }
  console.log("\n모든 케이스 통과 — /admin/members HTTP 응답 기준 검증 완료");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

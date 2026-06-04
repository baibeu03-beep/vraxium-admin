/**
 * READ-ONLY: GET /api/admin/members (limit=500) statusLabel 분포 + role 교차 점검.
 * "파트장" 단독 라벨이 더 이상 존재하지 않는지(전부 일반/심화(파트장) 로 흡수) 확인.
 *   npx tsx --env-file=.env.local scripts/diag-members-status-label-dist.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
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
        captured.push(...items.map((i) => ({ name: i.name, value: i.value })));
      },
    },
  });
  const { error: setError } = await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  if (setError) throw new Error(setError.message);
  return captured.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function main() {
  const cookieHeader = await makeAdminCookieHeader();
  const res = await fetch(`${baseUrl}/api/admin/members?limit=500`, {
    headers: { Cookie: cookieHeader },
  });
  const json = (await res.json()) as {
    success?: boolean;
    error?: string;
    data?: {
      total?: number;
      members?: Array<{
        displayName: string | null;
        role: string | null;
        membershipLevel: string | null;
        statusLabel: string;
      }>;
    };
  };
  if (!res.ok || !json.success) throw new Error(`HTTP ${res.status} ${json.error ?? ""}`);
  const members = json.data?.members ?? [];
  console.log(`total=${json.data?.total} / page=${members.length}`);

  const dist = new Map<string, number>();
  for (const m of members) {
    const k = `statusLabel=${JSON.stringify(m.statusLabel)} (role=${m.role ?? "-"}, level=${m.membershipLevel ?? "-"})`;
    dist.set(k, (dist.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...dist.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${k}`);
  }

  // 회귀 가드: role 단독 "파트장" 라벨 잔존 여부
  const badPartLeader = members.filter(
    (m) => m.statusLabel === "파트장" || (m.statusLabel === "심화(파트장)" && m.membershipLevel !== "심화"),
  );
  if (badPartLeader.length > 0) {
    console.error(`\nFAIL: 등급 미충족 파트장 표기 ${badPartLeader.length}건`);
    for (const m of badPartLeader) console.error(`  ${m.displayName} role=${m.role} level=${m.membershipLevel} → ${m.statusLabel}`);
    process.exit(1);
  }
  console.log("\nOK: '파트장' 표기는 membership_level=심화 인 경우에만 존재");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

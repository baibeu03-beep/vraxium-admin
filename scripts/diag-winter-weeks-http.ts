/**
 * 운영 admin HTTP 검증: GET /api/admin/season-weeks → 2026-winter W1~W9 표시값.
 * direct DB(weeks 테이블 raw) 와 admin 화면 표시값(resolveOfficialRest 재판정) 비교용.
 *   npx tsx --env-file=.env.local scripts/diag-winter-weeks-http.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const baseUrl = process.env.DIAG_ADMIN_BASE ?? "https://vraxium-admin.vercel.app";
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
  const cookie = await makeAdminCookieHeader();
  const res = await fetch(`${baseUrl}/api/admin/season-weeks`, {
    headers: { Cookie: cookie },
  });
  const json = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    error?: string;
    data?: {
      rows?: Array<Record<string, unknown>>;
      conflicts?: Array<Record<string, unknown>>;
    };
  };
  console.log(`[0] GET ${baseUrl}/api/admin/season-weeks → ${res.status} success=${json.success}`);
  if (!res.ok || !json.success) {
    console.error(json.error);
    process.exit(1);
  }
  const rows = (json.data?.rows ?? []).filter((r) => r.season_key === "2026-winter");
  console.log(`[1] 2026-winter rows: ${rows.length}`);
  for (const r of rows) {
    console.log(
      JSON.stringify({
        week_number: r.week_number,
        week_start_date: r.week_start_date,
        week_end_date: r.week_end_date,
        is_official_rest: r.is_official_rest,
        official_rest_sources: r.official_rest_sources,
        is_transition: r.is_transition,
      }),
    );
  }
  const conflicts = (json.data?.conflicts ?? []).filter(
    (c) => c.season_key === "2026-winter",
  );
  console.log(`[2] 2026-winter conflicts: ${conflicts.length}`);
  for (const c of conflicts) console.log(JSON.stringify(c));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

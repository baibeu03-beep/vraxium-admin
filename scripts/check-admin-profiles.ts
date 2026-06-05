/**
 * 일회성 점검: admin_users 전체와 매칭되는 user_profiles.display_name 현황.
 *   npx tsx --env-file=.env.local scripts/check-admin-profiles.ts
 */
import { createClient } from "@supabase/supabase-js";

function ensureEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

async function main() {
  const admin = createClient(
    ensureEnv("NEXT_PUBLIC_SUPABASE_URL"),
    ensureEnv("SUPABASE_SERVICE_ROLE_KEY"),
  );

  const { data: admins, error } = await admin
    .from("admin_users")
    .select("id,email,role,is_active");
  if (error) throw new Error(error.message);

  const ids = (admins ?? []).map((a) => a.id);
  const { data: profiles, error: pErr } = await admin
    .from("user_profiles")
    .select("user_id,display_name,auth_email,role")
    .in("user_id", ids);
  if (pErr) throw new Error(pErr.message);

  const byId = new Map((profiles ?? []).map((p) => [p.user_id, p]));
  for (const a of admins ?? []) {
    const p = byId.get(a.id);
    console.log(
      [
        a.email,
        `role=${a.role}`,
        `active=${a.is_active}`,
        `profile=${p ? "yes" : "MISSING"}`,
        `display_name=${p?.display_name ?? "(null)"}`,
      ].join(" | "),
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

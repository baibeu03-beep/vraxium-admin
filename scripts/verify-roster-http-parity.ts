// 검증: HTTP(/api/admin/members/roster) == direct(listMembersRoster) (total/counts/filtered/members 동일).
//   npx tsx --env-file=.env.local scripts/verify-roster-http-parity.ts
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { listMembersRoster } from "@/lib/adminMembersData";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

async function adminCookieHeader(): Promise<string> {
  const { data: admins } = await supabaseAdmin
    .from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = (admins?.[0] as { email: string }).email;
  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const { data: verified } = await anon.auth.verifyOtp({
    email, token: link!.properties!.email_otp, type: "magiclink",
  });
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items.map(({ name, value }) => ({ name, value }))) },
  });
  await server.auth.setSession({
    access_token: verified!.session!.access_token,
    refresh_token: verified!.session!.refresh_token,
  });
  return captured.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function main() {
  const cookie = await adminCookieHeader();

  for (const qs of ["page=1&pageSize=50", "page=2&pageSize=50", "page=1&pageSize=50&filter=elite", "page=1&pageSize=50&search=김"]) {
    const res = await fetch(`${baseUrl}/api/admin/members/roster?${qs}`, { headers: { cookie } });
    const json = await res.json();
    const d = json.data ?? {};
    console.log(`HTTP [${qs}] http=${res.status} total=${d.total} counts=${JSON.stringify(d.statusCounts)} filtered=${d.filteredTotal} rows=${d.members?.length}`);
  }

  // direct vs HTTP (page1) — total/counts/filtered/첫행 userId 동일성
  const direct = await listMembersRoster({ organization: null, mode: "operating", page: 1, pageSize: 50 });
  const httpRes = await fetch(`${baseUrl}/api/admin/members/roster?page=1&pageSize=50`, { headers: { cookie } });
  const http = (await httpRes.json()).data;
  const same =
    direct.total === http.total &&
    JSON.stringify(direct.statusCounts) === JSON.stringify(http.statusCounts) &&
    direct.filteredTotal === http.filteredTotal &&
    direct.members.length === http.members.length &&
    direct.members.every((m, i) => m.userId === http.members[i].userId && m.rankGradeLabel === http.members[i].rankGradeLabel);
  console.log(`\ndirect==HTTP (page1, total/counts/filtered/순서/품계): ${same ? "동일 ✓" : "✗ 불일치"}`);
  console.log(`  direct total=${direct.total} counts=${JSON.stringify(direct.statusCounts)} filtered=${direct.filteredTotal}`);
  console.log(`  http   total=${http.total} counts=${JSON.stringify(http.statusCounts)} filtered=${http.filteredTotal}`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

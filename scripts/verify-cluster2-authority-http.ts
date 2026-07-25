import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const base = process.env.ADMIN_BASE_URL ?? "http://localhost:3012";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const email = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

async function cookie() {
  const admin = createClient(url, service);
  const browser = createClient(url, anon);
  const { data: link, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw error;
  const { data: verified, error: verifyError } = await browser.auth.verifyOtp({ email, token: link.properties.email_otp, type: "magiclink" });
  if (verifyError || !verified.session) throw verifyError ?? new Error("No session");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(url, anon, { cookies: { getAll: () => [], setAll: (items) => captured.push(...items.map(({ name, value }) => ({ name, value }))) } });
  await server.auth.setSession(verified.session);
  return captured.map(({ name, value }) => `${name}=${value}`).join("; ");
}

async function main() {
  const db = createClient(url, service);
  const [{ data: markers }, { data: clusters }] = await Promise.all([
    db.from("test_user_markers").select("user_id"),
    db.from("user_cluster2").select("user_id").limit(100),
  ]);
  const clusterIds = new Set((clusters ?? []).map((x) => x.user_id));
  const ids = (markers ?? []).map((x) => x.user_id).filter((id) => clusterIds.has(id)).slice(0, 3);
  const headers = { cookie: await cookie() };
  const rows = [];
  for (const id of ids) {
    const response = await fetch(`${base}/api/admin/crews/${id}/cluster2`, { headers });
    rows.push({ id, status: response.status, body: await response.json() });
  }
  console.log(JSON.stringify({ endpoint: "/api/admin/crews/:id/cluster2", rows }, null, 2));
}
main().catch((error) => { console.error(error); process.exit(1); });

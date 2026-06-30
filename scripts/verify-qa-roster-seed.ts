/**
 * QA roster 시드/스코프 검증 — direct + HTTP, 운영/QA 모드 total·statusCounts.
 *   시드 적용 전후로 실행해 비교한다.
 *   npx tsx --env-file=.env.local scripts/verify-qa-roster-seed.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { listMembersRoster } from "@/lib/adminMembersData";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";

const baseUrl = "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!, anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
async function makeAdminCookies() {
  const { data: admins } = await supabaseAdmin.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = (admins?.[0] as any)?.email; if (!email) throw new Error("no admin email");
  const admin = createClient(supabaseUrl, serviceKey), anon = createClient(supabaseUrl, anonKey);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const { data: verified } = await anon.auth.verifyOtp({ email, token: (link as any).properties.email_otp, type: "magiclink" });
  const captured: any[] = [];
  const server = createServerClient(supabaseUrl, anonKey, { cookies: { getAll: () => [], setAll: (items) => captured.push(...items.map(({ name, value }: any) => ({ name, value }))) } });
  await server.auth.setSession({ access_token: (verified as any).session.access_token, refresh_token: (verified as any).session.refresh_token });
  return captured;
}
async function http(path: string, cookies: any[]) {
  const r = await fetch(`${baseUrl}${path}`, { headers: { Cookie: cookies.map((c: any) => `${c.name}=${c.value}`).join("; ") }, cache: "no-store" });
  const b = await r.json(); const d = b?.data ?? b;
  return { status: r.status, total: d?.total ?? null, counts: d?.statusCounts ?? null };
}
function fmt(x: any) { return JSON.stringify(x); }

async function main() {
  const cookies = await makeAdminCookies();
  // DIRECT
  const dOp = await listMembersRoster({ mode: "operating", page: 1, pageSize: 200 });
  const dTest = await listMembersRoster({ mode: "test", page: 1, pageSize: 200 });
  // HTTP
  const hOp = await http("/api/admin/members/roster", cookies);
  const hTest = await http("/api/admin/members/roster?mode=test", cookies);
  // real-user summer participants (실유저 데이터 불변 지표)
  const testIds = [...(await fetchTestUserMarkerIds())];
  const { count: realSummer } = await supabaseAdmin.from("user_season_statuses").select("user_id", { count: "exact", head: true })
    .eq("season_key", "2026-summer").not("user_id", "in", `(${testIds.join(",")})`);

  console.log("OPERATING  direct: total", dOp.total, "counts", fmt((dOp as any).statusCounts), "| HTTP: total", hOp.total, "counts", fmt(hOp.counts));
  console.log("QA(test)   direct: total", dTest.total, "counts", fmt((dTest as any).statusCounts), "| HTTP: total", hTest.total, "counts", fmt(hTest.counts));
  console.log("direct==HTTP operating:", dOp.total === hOp.total && fmt((dOp as any).statusCounts) === fmt(hOp.counts));
  console.log("direct==HTTP QA(test) :", dTest.total === hTest.total && fmt((dTest as any).statusCounts) === fmt(hTest.counts));
  console.log("실유저 2026-summer 참가행 수(불변 지표):", realSummer);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

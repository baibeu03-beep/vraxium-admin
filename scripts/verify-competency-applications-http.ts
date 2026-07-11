/**
 * 실제 HTTP 검증: /admin/line-opening/practical-competency 최초 진입 요청.
 *   npx tsx --env-file=.env.local scripts/verify-competency-applications-http.ts
 *
 * - 실 관리자 세션 쿠키를 발급(makeAdminCookies)해 dev server(:3000)에 실제 HTTP 요청.
 * - manage 탭 첫 로드 요청: season-weeks → competency/applications(org×mode).
 * - open  탭 첫 로드 요청: competency/opening-status, weeks-options.
 * - 각 요청: URL / HTTP status / 응답시간 / DTO 키 / 주요 개수 기록.
 * - operating vs test DTO 필드 동일성 비교(같은 엔드포인트·같은 키).
 * - cold(첫 요청) vs warm(재요청) 응답시간 비교.
 * 선행: dev server 기동(:3000).
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ORGANIZATIONS } from "@/lib/organizations";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`);
  if (!ok) failed++;
}

async function makeAdminCookieHeader(): Promise<string> {
  const { data: admins, error } = await supabaseAdmin
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  if (error) throw error;
  const email = (admins?.[0] as { email: string } | undefined)?.email;
  if (!email) throw new Error("No active admin email");
  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (linkErr || !link.properties?.email_otp) throw new Error(linkErr?.message ?? "generateLink failed");
  const { data: verified, error: verifyErr } = await anon.auth.verifyOtp({
    email,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  if (verifyErr || !verified.session) throw new Error(verifyErr?.message ?? "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items.map(({ name, value }) => ({ name, value }))) },
  });
  await server.auth.setSession({
    access_token: verified.session.access_token,
    refresh_token: verified.session.refresh_token,
  });
  console.log(`   admin session for ${email} (${captured.length} cookies)`);
  return captured.map((c) => `${c.name}=${c.value}`).join("; ");
}

type Hit = { url: string; status: number; ms: number; keys: string[]; counts: Record<string, number> };

async function hit(cookie: string, path: string): Promise<Hit> {
  const url = `${BASE}${path}`;
  const s = performance.now();
  const res = await fetch(url, { headers: { cookie }, cache: "no-store" as RequestCache });
  const ms = Math.round(performance.now() - s);
  let json: any = null;
  try { json = await res.json(); } catch { /* non-json */ }
  const data = json?.data ?? {};
  const keys = data && typeof data === "object" ? Object.keys(data) : [];
  const counts: Record<string, number> = {};
  for (const k of ["applications", "results", "weeks", "rows"]) {
    if (Array.isArray(data?.[k])) counts[k] = data[k].length;
  }
  if (data?.summary && typeof data.summary === "object") {
    counts["summary.activeCrews"] = data.summary.activeCrews;
    counts["summary.appliedCrews"] = data.summary.appliedCrews;
    counts["summary.openedCrews"] = data.summary.openedCrews;
  }
  if (typeof data?.opened !== "undefined") counts["opened"] = data.opened ? 1 : 0;
  return { url: path, status: res.status, ms, keys, counts };
}

function print(tag: string, h: Hit) {
  console.log(
    `   [${tag}] ${h.status} ${h.ms}ms ${h.url}\n       keys=[${h.keys.join(",")}] counts=${JSON.stringify(h.counts)}`,
  );
}

async function main() {
  try {
    const h = await fetch(`${BASE}/api/health`);
    if (!h.ok) throw new Error("health not ok");
  } catch {
    console.log(`❌ dev server 미기동(${BASE}). npm run dev 후 재실행.`);
    process.exit(2);
  }
  const cookie = await makeAdminCookieHeader();

  // ── manage 탭 첫 로드: season-weeks(공용) → applications(org×mode) ──
  console.log("\n== manage 탭: season-weeks ==");
  const sw = await hit(cookie, "/api/admin/season-weeks");
  print("season-weeks", sw);
  check("season-weeks 200 & <10s", sw.status === 200 && sw.ms < 10_000, { ms: sw.ms });

  console.log("\n== manage 탭: competency/applications (org × mode, cold/warm) ==");
  const dtoKeysByMode: Record<string, Record<string, string[]>> = {};
  for (const org of ORGANIZATIONS) {
    for (const mode of ["operating", "test"] as const) {
      const q = `organization=${org}${mode === "test" ? "&mode=test" : ""}`;
      const cold = await hit(cookie, `/api/admin/cluster4/competency/applications?${q}`);
      const warm = await hit(cookie, `/api/admin/cluster4/competency/applications?${q}`);
      print(`${org}/${mode} cold`, cold);
      print(`${org}/${mode} warm`, warm);
      check(`${org}/${mode} applications 200`, cold.status === 200 && warm.status === 200, { cold: cold.status, warm: warm.status });
      check(`${org}/${mode} applications cold<10s (지연문구 임계)`, cold.ms < 10_000, { ms: cold.ms });
      check(`${org}/${mode} applications warm<10s`, warm.ms < 10_000, { ms: warm.ms });
      (dtoKeysByMode[org] ??= {})[mode] = cold.keys.sort();
    }
    // operating vs test DTO 필드(키) 동일성.
    check(
      `${org} operating/test DTO 키 동일`,
      JSON.stringify(dtoKeysByMode[org].operating) === JSON.stringify(dtoKeysByMode[org].test),
      { operating: dtoKeysByMode[org].operating, test: dtoKeysByMode[org].test },
    );
  }

  // ── open 탭 첫 로드: opening-status, weeks-options ──
  console.log("\n== open 탭: opening-status / weeks-options ==");
  for (const org of ORGANIZATIONS) {
    const os = await hit(cookie, `/api/admin/cluster4/competency/opening-status?organization=${org}`);
    print(`${org} opening-status`, os);
    check(`${org} opening-status 200 & <10s`, os.status === 200 && os.ms < 10_000, { status: os.status, ms: os.ms });
    const wo = await hit(cookie, `/api/admin/cluster4/weeks-options?limit=8&org=${org}&hub=competency`);
    print(`${org} weeks-options`, wo);
    check(`${org} weeks-options 200 & <10s`, wo.status === 200 && wo.ms < 10_000, { status: wo.status, ms: wo.ms });
  }

  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });

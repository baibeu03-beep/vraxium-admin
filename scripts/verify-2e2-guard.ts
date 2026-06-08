/**
 * Phase 2E-2 drift 가드 검증.
 *   npx tsx --env-file=.env.local scripts/verify-2e2-guard.ts
 * 항목: POST/DELETE 차단(409) · PATCH sync 왕복(변경→동기화 확인→원복) ·
 *       기존 개설 플로우 GET 정상 · catalog 정상 · snapshot 불변.
 * 주의: PATCH 검증은 CPBS-NN0030 line_name 을 변경 후 원복 — 종료 시 값 원상복구(updated_at 만 변경).
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

function ensureEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}
const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
const serviceKey = ensureEnv("SUPABASE_SERVICE_ROLE_KEY");
const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (ok) pass++;
  else fail++;
}

async function makeAdminCookieHeader() {
  const admin = createClient(supabaseUrl, serviceKey);
  const browser = createClient(supabaseUrl, anonKey);
  const { data: l, error: le } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: adminEmail,
  });
  if (le || !l?.properties?.email_otp) throw new Error(le?.message ?? "generateLink failed");
  const { data: v, error: ve } = await browser.auth.verifyOtp({
    email: adminEmail,
    token: l.properties.email_otp,
    type: "magiclink",
  });
  if (ve || !v.session) throw new Error(ve?.message ?? "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [],
      setAll: (items) => captured.push(...items.map((i) => ({ name: i.name, value: i.value }))),
    },
  });
  await server.auth.setSession({
    access_token: v.session.access_token,
    refresh_token: v.session.refresh_token,
  });
  return captured.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function count(table: string, filter?: (q: any) => any): Promise<number> {
  let q = sb.from(table).select("*", { count: "exact", head: true });
  if (filter) q = filter(q);
  const { count: c, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return c ?? 0;
}

async function fingerprint() {
  return {
    snapTotal: await count("cluster4_weekly_card_snapshots"),
    snapStale: await count("cluster4_weekly_card_snapshots", (q) => q.eq("is_stale", true)),
    lines: await count("cluster4_lines"),
    targets: await count("cluster4_line_targets"),
  };
}

async function api(cookie: string, path: string, init?: RequestInit) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Cookie: cookie, ...(init?.headers ?? {}) },
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

async function main() {
  const before = await fingerprint();
  console.log("fingerprint(before):", JSON.stringify(before));
  const cookie = await makeAdminCookieHeader();

  // ── A) 생성/삭제 차단 ──
  console.log("\n=== A) exp/comp 마스터 직접 생성/삭제 차단 ===");
  const expPost = await api(cookie, "/api/admin/cluster4/experience-line-masters", {
    method: "POST",
    body: JSON.stringify({ line_code: "GUARD-TEST", line_name: "가드 테스트", organization_slug: "encre" }),
  });
  check("exp POST 409 차단", expPost.status === 409, String(expPost.json.error).slice(0, 60));
  const compPost = await api(cookie, "/api/admin/cluster4/competency-line-masters", {
    method: "POST",
    body: JSON.stringify({ line_code: "GUARD-TEST", line_name: "가드 테스트", organization_slug: "encre" }),
  });
  check("comp POST 409 차단", compPost.status === 409);
  const { data: anyExp } = await sb
    .from("cluster4_experience_line_masters")
    .select("id")
    .limit(1)
    .single();
  const expDel = await api(
    cookie,
    `/api/admin/cluster4/experience-line-masters/${(anyExp as { id: string }).id}`,
    { method: "DELETE" },
  );
  check("exp DELETE 409 차단", expDel.status === 409);
  const { data: anyComp } = await sb
    .from("cluster4_competency_line_masters")
    .select("id")
    .limit(1)
    .single();
  const compDel = await api(
    cookie,
    `/api/admin/cluster4/competency-line-masters/${(anyComp as { id: string }).id}`,
    { method: "DELETE" },
  );
  check("comp DELETE 409 차단", compDel.status === 409);
  const { count: expCount } = await sb
    .from("cluster4_experience_line_masters")
    .select("*", { count: "exact", head: true });
  const { count: compCount } = await sb
    .from("cluster4_competency_line_masters")
    .select("*", { count: "exact", head: true });
  check("마스터 건수 불변 (26/30) — 차단 실효", expCount === 26 && compCount === 30, `${expCount}/${compCount}`);

  // ── B) PATCH sync 왕복 (CPBS-NN0030) ──
  console.log("\n=== B) PATCH → registrations 자동 동기화 (변경→확인→원복) ===");
  const { data: target } = await sb
    .from("cluster4_competency_line_masters")
    .select("id,line_name")
    .eq("line_code", "CPBS-NN0030")
    .eq("organization_slug", "common")
    .single();
  const masterId = (target as { id: string }).id;
  const originalName = (target as { line_name: string }).line_name;
  const tempName = `${originalName} (2E2검증)`;

  const patch1 = await api(cookie, `/api/admin/cluster4/competency-line-masters/${masterId}`, {
    method: "PATCH",
    body: JSON.stringify({ line_name: tempName }),
  });
  check("PATCH 200 + driftSync.synced=true", patch1.status === 200 && (patch1.json.driftSync as { synced?: boolean })?.synced === true, JSON.stringify(patch1.json.driftSync));
  const { data: regAfter } = await sb
    .from("line_registrations")
    .select("line_name,line_type")
    .eq("bridged_master_id", masterId)
    .maybeSingle();
  check("registrations line_name 동기화됨", regAfter?.line_name === tempName, regAfter?.line_name);
  check("registrations line_type(자원) 보존 — 마스터 무원천 필드 미동기화", regAfter?.line_type === "자원");

  // 원복
  const patch2 = await api(cookie, `/api/admin/cluster4/competency-line-masters/${masterId}`, {
    method: "PATCH",
    body: JSON.stringify({ line_name: originalName }),
  });
  const { data: regBack } = await sb
    .from("line_registrations")
    .select("line_name")
    .eq("bridged_master_id", masterId)
    .maybeSingle();
  check("원복 PATCH + 동기화 (값 원상복구)", patch2.status === 200 && regBack?.line_name === originalName);

  // ── C) diff 0 재확인은 별도 diag 스크립트로 (호출자 안내) — 여기선 핵심 필드만 spot ──
  console.log("\n=== C) 기존 개설 플로우/카탈로그 GET 정상 ===");
  const expList = await api(cookie, "/api/admin/cluster4/experience-line-masters");
  check("experience-line-masters GET 200 (개설 드롭다운)", expList.status === 200 && Array.isArray((expList.json as { data?: unknown[] }).data));
  const compList = await api(cookie, "/api/admin/cluster4/competency-line-masters");
  check("competency-line-masters GET 200", compList.status === 200);
  const careerOpts = await api(cookie, "/api/admin/cluster4/career-line-options");
  check("career-line-options GET 200 (career 무차단)", careerOpts.status === 200);
  const linesList = await api(cookie, "/api/admin/cluster4/lines?limit=5");
  check("cluster4/lines GET 200", linesList.status === 200);
  const history = await api(cookie, "/api/admin/cluster4/lines/history?limit=5");
  check("line-history GET 200", history.status === 200);
  const catalog = await api(cookie, "/api/admin/lines/catalog");
  const cd = (catalog.json as { data?: { countsBySource?: Record<string, number> } }).data;
  check(
    "/admin/lines/info 카탈로그 정상 (26/30/1/56)",
    catalog.status === 200 &&
      cd?.countsBySource?.experience_master === 26 &&
      cd?.countsBySource?.competency_master === 30 &&
      cd?.countsBySource?.registration === 56,
    JSON.stringify(cd?.countsBySource),
  );

  // ── D) snapshot ──
  console.log("\n=== D) snapshot ===");
  const after = await fingerprint();
  check("fingerprint 불변 (재계산 불필요)", JSON.stringify(before) === JSON.stringify(after), JSON.stringify(after));

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

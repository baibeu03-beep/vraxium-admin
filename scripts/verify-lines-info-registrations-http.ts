/**
 * /admin/lines/info line_registrations 전환 검증 (direct vs HTTP · 표시 정책 · snapshot 무영향).
 *   npx tsx --env-file=.env.local scripts/verify-lines-info-registrations-http.ts
 * READ-ONLY — DB 쓰기 0건.
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { listLineRegistrations } from "@/lib/adminLineRegistrationsData";
import {
  HUB_MAIN_TITLE_MODE,
  lineRegistrationDisplayMainTitle,
} from "@/lib/adminLineRegistrationsTypes";

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    expMasters: await count("cluster4_experience_line_masters"),
    compMasters: await count("cluster4_competency_line_masters"),
    careers: await count("career_projects"),
    registrations: await count("line_registrations"),
  };
}

async function main() {
  const before = await fingerprint();
  console.log("=== fingerprint (before) ===");
  console.log(" ", JSON.stringify(before));

  // ── 1) direct 함수 결과 ──
  console.log("\n=== 1) direct listLineRegistrations() ===");
  const direct = await listLineRegistrations({ limit: 200 });
  check(
    "direct total = line_registrations 실건수",
    direct.total === before.registrations,
    `${direct.total} vs ${before.registrations}`,
  );
  check("rows ≤ 200 (limit cap)", direct.rows.length <= 200, `rows=${direct.rows.length}`);

  // ── 2~3) HTTP 응답 + direct 일치 (검증 항목 6) ──
  console.log("\n=== 2) HTTP GET /api/admin/lines/registrations — direct 일치 ===");
  const cookie = await makeAdminCookieHeader();
  const res = await fetch(`${baseUrl}/api/admin/lines/registrations?limit=200`, {
    headers: { Cookie: cookie },
  });
  const json = (await res.json()) as { success: boolean; data: typeof direct };
  check("HTTP 200", res.status === 200, `status=${res.status}`);
  check(
    "HTTP rows = direct rows (JSON 완전 일치)",
    JSON.stringify(json.data.rows) === JSON.stringify(direct.rows),
    `direct=${direct.rows.length} http=${json.data.rows.length}`,
  );
  check("HTTP total = direct total", json.data.total === direct.total);

  // ── 3) 표시 정책 (검증 항목 3·4) — 허브 기준 고정/변동 ──
  console.log("\n=== 3) 메인 타이틀 표시 정책 (허브 SoT) ===");
  check(
    "정책 맵 — info/career=variable · experience/competency=fixed",
    HUB_MAIN_TITLE_MODE.info === "variable" &&
      HUB_MAIN_TITLE_MODE.career === "variable" &&
      HUB_MAIN_TITLE_MODE.experience === "fixed" &&
      HUB_MAIN_TITLE_MODE.competency === "fixed",
  );
  const displays = direct.rows.map((r) => ({
    hub: r.hub,
    ...lineRegistrationDisplayMainTitle(r.hub, r.mainTitle),
  }));
  const variableRows = displays.filter((d) => d.hub === "info" || d.hub === "career");
  const fixedRows = displays.filter((d) => d.hub === "experience" || d.hub === "competency");
  check(
    `info/career 행(${variableRows.length}건) 전부 변동 + 타이틀 '-'`,
    variableRows.every((d) => d.modeLabel === "변동" && d.title === "-"),
  );
  check(
    `experience/competency 행(${fixedRows.length}건) 전부 고정 + 타이틀 표시`,
    fixedRows.every((d) => d.modeLabel === "고정" && d.title.length > 0),
  );
  // 저장 mode 와 허브 정책의 drift 현황 (정보성)
  const drift = direct.rows.filter((r) => r.mainTitleMode !== HUB_MAIN_TITLE_MODE[r.hub]);
  console.log(`  (정보) 저장 main_title_mode vs 허브 정책 drift: ${drift.length}건`);

  // ── 4) organization_slug / unit_link 노출 (검증 항목 2·5) ──
  console.log("\n=== 4) organization_slug · unit_link DTO 노출 ===");
  check(
    "모든 행에 organizationSlug 필드 존재 (null=미지정 허용)",
    json.data.rows.every((r) => "organizationSlug" in r),
  );
  const withOrg = json.data.rows.filter((r) => r.organizationSlug !== null);
  check(
    `org 지정 행(${withOrg.length}건) slug 도메인 검증`,
    withOrg.every((r) =>
      ["encre", "oranke", "phalanx", "common"].includes(r.organizationSlug as string),
    ),
  );
  check(
    "모든 행 unitLink 비공백 (미입력 sentinel '-')",
    json.data.rows.every((r) => typeof r.unitLink === "string" && r.unitLink.trim().length > 0),
  );

  // ── 5) snapshot 무영향 / 재계산 불필요 (검증 항목 7·8) ──
  console.log("\n=== 5) snapshot fingerprint (after) ===");
  const after = await fingerprint();
  console.log(" ", JSON.stringify(after));
  check(
    "fingerprint 전후 동일 (snapshot 무영향·재계산 불필요)",
    JSON.stringify(before) === JSON.stringify(after),
  );

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

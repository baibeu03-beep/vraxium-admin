/**
 * /admin/lines/info 적용 클럽 표시 정책 검증 (2026-06-14).
 *   npx tsx --env-file=.env.local scripts/verify-lines-info-club-display-http.ts
 * READ-ONLY — DB 쓰기 0건.
 *
 * 검증:
 *   1) direct listLineRegistrations() = line_registrations 실건수 (등록 대장 조회 확인)
 *   2) HTTP GET === direct (JSON 완전 일치)
 *   3) 표시 정책: info·competency 전체 → 공통 / experience(관리·확장) → 공통 / common → 공통
 *   4) 실제 organization_slug 저장값 분포 (DB 무수정 확인 — 표시만 변환)
 *   5) snapshot fingerprint 전후 동일 (snapshot 무영향)
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { listLineRegistrations } from "@/lib/adminLineRegistrationsData";
import {
  COMMON_CLUB_LABEL,
  EXPERIENCE_COMMON_LINE_TYPES,
  lineRegistrationDisplayClub,
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
    registrations: await count("line_registrations"),
  };
}

async function main() {
  const before = await fingerprint();
  console.log("=== fingerprint (before) ===");
  console.log(" ", JSON.stringify(before));

  // ── 1) direct = 등록 대장 실건수 ──
  console.log("\n=== 1) direct listLineRegistrations() = line_registrations ===");
  const direct = await listLineRegistrations({ limit: 200 });
  check(
    "direct total = line_registrations 실건수",
    direct.total === before.registrations,
    `${direct.total} vs ${before.registrations}`,
  );

  // ── 2) HTTP === direct ──
  console.log("\n=== 2) HTTP GET === direct (JSON 완전 일치) ===");
  const cookie = await makeAdminCookieHeader();
  const res = await fetch(`${baseUrl}/api/admin/lines/registrations?limit=200`, {
    headers: { Cookie: cookie },
  });
  const json = (await res.json()) as { success: boolean; data: typeof direct };
  check("HTTP 200", res.status === 200, `status=${res.status}`);
  check(
    "HTTP rows = direct rows",
    JSON.stringify(json.data.rows) === JSON.stringify(direct.rows),
    `direct=${direct.rows.length} http=${json.data.rows.length}`,
  );

  const rows = json.data.rows;

  // ── 3) 표시 정책 (요구사항 2~5) ──
  console.log("\n=== 3) 적용 클럽 표시 정책 ===");
  const display = (r: (typeof rows)[number]) =>
    lineRegistrationDisplayClub(r.hub, r.lineType, r.organizationSlug);

  const infoRows = rows.filter((r) => r.hub === "info");
  check(
    `실무 정보 전체(${infoRows.length}건) → "공통"`,
    infoRows.every((r) => display(r) === COMMON_CLUB_LABEL),
  );

  const compRows = rows.filter((r) => r.hub === "competency");
  check(
    `실무 역량 전체(${compRows.length}건) → "공통"`,
    compRows.every((r) => display(r) === COMMON_CLUB_LABEL),
  );

  const expCommon = rows.filter(
    (r) => r.hub === "experience" && EXPERIENCE_COMMON_LINE_TYPES.includes(r.lineType),
  );
  check(
    `실무 경험 관리·확장(${expCommon.length}건) → "공통"`,
    expCommon.every((r) => display(r) === COMMON_CLUB_LABEL),
  );

  // 경험의 비-관리/확장(도출·분석·평가)은 공통 강제 대상 아님 — common 이거나 org 원문/미지정.
  const expOther = rows.filter(
    (r) => r.hub === "experience" && !EXPERIENCE_COMMON_LINE_TYPES.includes(r.lineType),
  );
  check(
    `실무 경험 도출·분석·평가(${expOther.length}건) = common→공통 · 그 외 org 원문/미지정`,
    expOther.every((r) => {
      const d = display(r);
      if (r.organizationSlug === "common") return d === COMMON_CLUB_LABEL;
      if (r.organizationSlug === null) return d === "-";
      return d === r.organizationSlug;
    }),
  );

  const commonRows = rows.filter((r) => r.organizationSlug === "common");
  check(
    `organization_slug='common'(${commonRows.length}건) → "공통"`,
    commonRows.every((r) => display(r) === COMMON_CLUB_LABEL),
  );

  // ── 4) 실제 organization_slug 분포 (DB 무수정 확인) ──
  console.log("\n=== 4) 실제 organization_slug 저장값 분포 (DB 무수정) ===");
  const dist = (label: string, subset: typeof rows) => {
    const m = new Map<string, number>();
    for (const r of subset) {
      const k = r.organizationSlug ?? "(null)";
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    console.log(`  ${label}: ${JSON.stringify(Object.fromEntries(m))}`);
  };
  dist("info", infoRows);
  dist("competency", compRows);
  dist("experience 관리·확장", expCommon);
  console.log(
    "  → 위 저장값과 무관하게 화면은 전부 '공통' 표시 (display-only 변환, DB 저장값 보존).",
  );

  // ── 5) snapshot 무영향 ──
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

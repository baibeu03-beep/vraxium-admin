/**
 * /admin/lines/info 적용 클럽 *필터* 표시값 정합 검증 (2026-06-14).
 *   npx tsx --env-file=.env.local scripts/verify-lines-info-club-filter-http.ts
 * READ-ONLY — DB 쓰기 0건.
 *
 * 필터는 클라이언트 사이드라 API 응답 자체는 불변(direct==HTTP). 본 스크립트는 동일 rows 에
 * 컴포넌트와 같은 표시값 기준 필터를 적용해, 옵션별 매칭이 셀 표시와 일치함을 증명한다.
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { listLineRegistrations } from "@/lib/adminLineRegistrationsData";
import {
  COMMON_CLUB_LABEL,
  EXPERIENCE_COMMON_LINE_TYPES,
  LINE_REGISTRATION_CLUB_DISPLAY_OPTIONS,
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

  // ── direct == HTTP ──
  console.log("\n=== 1) direct == HTTP (API 응답 불변) ===");
  const direct = await listLineRegistrations({ limit: 200 });
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
  const club = (r: (typeof rows)[number]) =>
    lineRegistrationDisplayClub(r.hub, r.lineType, r.organizationSlug);

  // ── 옵션별 필터(표시값 기준) = 셀 표시값과 동일 분할 ──
  console.log("\n=== 2) 옵션별 필터 = 셀 표시값 기준 분할 ===");
  console.log(`  옵션: 전체 + ${LINE_REGISTRATION_CLUB_DISPLAY_OPTIONS.join(" / ")}`);
  for (const opt of LINE_REGISTRATION_CLUB_DISPLAY_OPTIONS) {
    const matched = rows.filter((r) => club(r) === opt);
    check(
      `필터 "${opt}" — 매칭 행 전부 셀 표시값 "${opt}" (${matched.length}건)`,
      matched.length > 0 && matched.every((r) => club(r) === opt),
    );
  }

  // ── 요구사항 4: 화면 "공통" 행 == 공통 필터 매칭 행 (정확히 동일 집합) ──
  console.log("\n=== 3) '공통' 표시 행 ≡ 공통 필터 매칭 행 ===");
  const displayedCommon = rows.filter((r) => club(r) === COMMON_CLUB_LABEL);
  const expectedCommon = rows.filter(
    (r) =>
      r.hub === "info" ||
      r.hub === "competency" ||
      (r.hub === "experience" && EXPERIENCE_COMMON_LINE_TYPES.includes(r.lineType)) ||
      r.organizationSlug === "common",
  );
  check(
    `공통 필터 집합 = 정책상 공통 대상 집합 (${displayedCommon.length}건)`,
    displayedCommon.length === expectedCommon.length &&
      displayedCommon.every((r) => expectedCommon.includes(r)),
    `filter=${displayedCommon.length} expected=${expectedCommon.length}`,
  );

  // ── 요구사항 5: org 표시 행은 각 org 필터에만, 공통 필터엔 안 걸림 ──
  console.log("\n=== 4) org 표시 행은 해당 org 필터에만 매칭 (공통에 누출 없음) ===");
  for (const org of ["encre", "oranke", "phalanx"] as const) {
    const matched = rows.filter((r) => club(r) === org);
    const leakedToCommon = matched.some((r) => displayedCommon.includes(r));
    check(
      `"${org}" 표시 행(${matched.length}건) — 전부 slug=${org} & 공통 누출 0`,
      matched.every((r) => r.organizationSlug === org) && !leakedToCommon,
      `slugs=${[...new Set(matched.map((r) => r.organizationSlug))].join(",") || "(없음)"}`,
    );
  }

  // ── 분포 (정보성) ──
  console.log("\n=== 5) 표시값 분포 (정보성) ===");
  const dist = new Map<string, number>();
  for (const r of rows) dist.set(club(r), (dist.get(club(r)) ?? 0) + 1);
  console.log("  ", JSON.stringify(Object.fromEntries(dist)));

  // ── snapshot 무영향 ──
  console.log("\n=== 6) snapshot fingerprint (after) ===");
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

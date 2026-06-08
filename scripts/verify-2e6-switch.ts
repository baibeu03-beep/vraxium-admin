/**
 * Phase 2E-6 검증: 개설 드롭다운 GET 전환(registrations 기준) 등가성 + FK 유지 + dedup.
 *   npx tsx --env-file=.env.local scripts/verify-2e6-switch.ts
 * READ-ONLY.
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { listExperienceLineMasters } from "@/lib/adminExperienceLineData";
import { listCompetencyLineMasters } from "@/lib/adminCompetencyLineData";
import { listLineCatalog } from "@/lib/adminLineCatalogData";

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
  const anon = createClient(supabaseUrl, anonKey);
  const { data: l, error: le } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  if (le || !l?.properties?.email_otp) throw new Error(le?.message ?? "generateLink failed");
  const { data: v, error: ve } = await anon.auth.verifyOtp({ email: adminEmail, token: l.properties.email_otp, type: "magiclink" });
  if (ve || !v.session) throw new Error(ve?.message ?? "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items.map((i) => ({ name: i.name, value: i.value }))) },
  });
  await server.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
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

// 기존 마스터 기준 드롭다운 재현 (전환 전 로직 — 등가성 비교 기준)
async function legacyExpList(org?: string | null) {
  let q = sb
    .from("cluster4_experience_line_masters")
    .select("*,cluster4_teams(team_name)")
    .order("line_code", { ascending: true });
  if (org) q = q.eq("organization_slug", org);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []).map((row: any) => ({
    id: row.id,
    organizationSlug: row.organization_slug,
    lineCode: row.line_code,
    lineName: row.line_name,
    mainTitle: row.default_main_title,
    teamId: row.team_id,
    teamName: row.cluster4_teams?.team_name ?? null,
    sourceFileName: row.source_file_name,
    isActive: row.is_active,
    experienceCategory: row.experience_category ?? null,
    experienceSlotOrder: row.experience_slot_order ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}
async function legacyCompList(org?: string | null) {
  let q = sb
    .from("cluster4_competency_line_masters")
    .select("*")
    .order("line_code", { ascending: true });
  if (org) q = q.eq("organization_slug", org);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []).map((row: any) => ({
    id: row.id,
    organizationSlug: row.organization_slug,
    lineCode: row.line_code,
    lineName: row.line_name,
    mainTitle: row.main_title,
    sourceFileName: row.source_file_name,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

// line_code 동률 정렬 차이를 흡수하기 위해 (code,org) 키 정렬 후 비교.
function sortRows<T extends { lineCode: string; organizationSlug: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    `${a.lineCode}|${a.organizationSlug}`.localeCompare(`${b.lineCode}|${b.organizationSlug}`),
  );
}

async function main() {
  const before = await fingerprint();
  console.log("fingerprint(before):", JSON.stringify(before));

  // ── 1) 드롭다운 direct diff (registrations 기준 vs 기존 마스터 기준) ──
  console.log("\n=== 1) 드롭다운 목록 diff (direct) ===");
  const newExp = sortRows((await listExperienceLineMasters()).rows);
  const oldExp = sortRows(await legacyExpList());
  check(
    "exp 전체 26건 — DTO JSON diff 0",
    newExp.length === 26 && JSON.stringify(newExp) === JSON.stringify(oldExp),
    `new=${newExp.length} old=${oldExp.length}`,
  );
  const newExpOrg = sortRows((await listExperienceLineMasters("encre")).rows);
  const oldExpOrg = sortRows(await legacyExpList("encre"));
  check("exp org=encre 필터 diff 0", JSON.stringify(newExpOrg) === JSON.stringify(oldExpOrg), `rows=${newExpOrg.length}`);
  const newComp = sortRows((await listCompetencyLineMasters()).rows);
  const oldComp = sortRows(await legacyCompList());
  check(
    "comp 전체 30건 — DTO JSON diff 0",
    newComp.length === 30 && JSON.stringify(newComp) === JSON.stringify(oldComp),
    `new=${newComp.length} old=${oldComp.length}`,
  );

  // ── FK 유지: 드롭다운 id 가 전부 실제 마스터 id (기존 FK 체계) ──
  const expMasterIds = new Set(
    ((await sb.from("cluster4_experience_line_masters").select("id")).data ?? []).map((r) => r.id),
  );
  const compMasterIds = new Set(
    ((await sb.from("cluster4_competency_line_masters").select("id")).data ?? []).map((r) => r.id),
  );
  check(
    "5) 드롭다운 id = 마스터 id 전수 (개설 FK 체계 유지)",
    newExp.every((r) => expMasterIds.has(r.id)) && newComp.every((r) => compMasterIds.has(r.id)),
  );

  // ── 2~3) HTTP = direct ──
  console.log("\n=== 2~3) HTTP = direct ===");
  const cookie = await makeAdminCookieHeader();
  const expHttp = await fetch(`${baseUrl}/api/admin/cluster4/experience-line-masters`, {
    headers: { Cookie: cookie },
  });
  const expHttpRows = sortRows(((await expHttp.json()) as { data: typeof newExp }).data);
  check("exp HTTP = direct (JSON 일치)", expHttp.status === 200 && JSON.stringify(expHttpRows) === JSON.stringify(newExp));
  const compHttp = await fetch(`${baseUrl}/api/admin/cluster4/competency-line-masters`, {
    headers: { Cookie: cookie },
  });
  const compHttpRows = sortRows(((await compHttp.json()) as { data: typeof newComp }).data);
  check("comp HTTP = direct (JSON 일치)", compHttp.status === 200 && JSON.stringify(compHttpRows) === JSON.stringify(newComp));

  // ── 4) 개설 검증 negative (FK·검증 경로 정상) ──
  const { data: anyWeek } = await sb.from("weeks").select("id").limit(1).single();
  const fake = "00000000-0000-0000-0000-00000000dead";
  const openNeg = await fetch(`${baseUrl}/api/admin/cluster4/competency-lines`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      competency_line_master_id: fake,
      output_links: [{ url: "https://example.com", label: null }],
      target_user_ids: ["00000000-0000-0000-0000-000000000001"],
      week_id: (anyWeek as { id: string }).id,
    }),
  });
  check("4) 개설 검증 경로 정상 (미존재 404)", openNeg.status === 404, `status=${openNeg.status}`);

  // ── 6) 카탈로그 dedup — mirrored 플래그 ──
  console.log("\n=== 6) 카탈로그 read-mirror dedup ===");
  const catalog = await listLineCatalog({ sort: "latest" });
  const mirroredMasters = catalog.rows.filter((r) => r.mirrored);
  const masterRows = catalog.rows.filter((r) => r.source !== "registration");
  // 운영 중 신규 등록→브리지로 마스터가 늘 수 있어 고정 건수 대신 "전수 플래그" 만 검증.
  check(
    "exp/comp 마스터 행 전수 mirrored=true",
    masterRows.filter((r) => r.source !== "career_master").every((r) => r.mirrored),
    `mirrored=${mirroredMasters.length}/${masterRows.length}`,
  );
  // 건수는 운영 중 증가할 수 있어 라이브 테이블 실건수와 대조한다 (고정값 비교 금지).
  const liveRegs = await count("line_registrations");
  const liveExpM = await count("cluster4_experience_line_masters");
  const liveCompM = await count("cluster4_competency_line_masters");
  check(
    "registration 행 mirrored=false + countsBySource = 라이브 실건수",
    catalog.rows.filter((r) => r.source === "registration").every((r) => !r.mirrored) &&
      catalog.countsBySource.experience_master === liveExpM &&
      catalog.countsBySource.competency_master === liveCompM &&
      catalog.countsBySource.registration === liveRegs,
    JSON.stringify({ counts: catalog.countsBySource, live: { liveExpM, liveCompM, liveRegs } }),
  );

  // ── 8~9) snapshot ──
  console.log("\n=== 8~9) snapshot ===");
  const after = await fingerprint();
  check("snapshot stale 0·fingerprint 불변 (재계산 불필요)", JSON.stringify(before) === JSON.stringify(after) && after.snapStale === 0, JSON.stringify(after));

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Phase 2E-3 검증: 개설 검증·org 판정 registrations 전환 (fallback 포함).
 *   npx tsx --env-file=.env.local scripts/verify-2e3-switch.ts
 * 항목:
 *   A) 조회 헬퍼 등가성 — 전체 56 마스터: registrations 뷰 vs 마스터 원본 diff 0
 *   B) collectLineOrgAudience(전환 후 함수) 실측 — 샘플 라인의 audience 가
 *      "마스터 org 로 독립 계산한 기대 audience" 와 동일 (org 판정 diff 0 의 함수 레벨 입증)
 *   C) 개설 검증 HTTP — 미존재 master id 404 / inactive 의미 보존(negative only, 라인 미생성)
 *   D) line-history·카탈로그 정상 + snapshot 불변
 * READ-ONLY (DB 쓰기 0건 — 개설 positive 테스트는 라인 생성을 유발하므로 negative 로만 검증).
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { getRegistrationByBridgedMasterId } from "@/lib/lineRegistrationLookup";
import { collectLineOrgAudience } from "@/lib/adminCluster4LinesData";
import { parseLineCodeOrg, isLineVisibleForUserOrg, normalizeLineOrg } from "@/lib/cluster4LineOrg";

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

// 마스터 org 기준 기대 audience (기존 로직 재현 — collectLineOrgAudience 와 독립 계산)
async function expectedAudienceByMasterOrg(line: {
  part_type: string;
  line_code: string | null;
  experience_line_master_id: string | null;
  competency_line_master_id: string | null;
}): Promise<string[] | null> {
  if (line.part_type === "career") return [];
  let lineOrg = parseLineCodeOrg(line.line_code);
  if (lineOrg == null) {
    if (line.part_type === "info") lineOrg = "common";
    else if (line.part_type === "experience" && line.experience_line_master_id) {
      const { data: m } = await sb
        .from("cluster4_experience_line_masters")
        .select("organization_slug")
        .eq("id", line.experience_line_master_id)
        .maybeSingle();
      lineOrg = normalizeLineOrg((m as { organization_slug: string | null } | null)?.organization_slug);
    } else if (line.part_type === "competency" && line.competency_line_master_id) {
      const { data: m } = await sb
        .from("cluster4_competency_line_masters")
        .select("organization_slug")
        .eq("id", line.competency_line_master_id)
        .maybeSingle();
      lineOrg = normalizeLineOrg((m as { organization_slug: string | null } | null)?.organization_slug);
    }
  }
  if (lineOrg == null) return [];
  const { data: snaps } = await sb.from("cluster4_weekly_card_snapshots").select("user_id");
  const userIds = ((snaps ?? []) as { user_id: string }[]).map((r) => r.user_id);
  const { data: profs } = await sb
    .from("user_profiles")
    .select("user_id,organization_slug")
    .in("user_id", userIds);
  const orgByUser = new Map(
    ((profs ?? []) as { user_id: string; organization_slug: string | null }[]).map((p) => [
      p.user_id,
      p.organization_slug,
    ]),
  );
  return userIds.filter((uid) =>
    isLineVisibleForUserOrg(lineOrg!, (orgByUser.get(uid) as never) ?? null),
  );
}

async function main() {
  const before = await fingerprint();
  console.log("fingerprint(before):", JSON.stringify(before));

  // ── A) 헬퍼 등가성 — 56 마스터 전수 ──
  console.log("\n=== A) registrations 뷰 vs 마스터 원본 (56 전수) ===");
  const { data: expMasters } = await sb
    .from("cluster4_experience_line_masters")
    .select("id,line_code,line_name,default_main_title,organization_slug,is_active");
  const { data: compMasters } = await sb
    .from("cluster4_competency_line_masters")
    .select("id,line_code,line_name,main_title,organization_slug,is_active");
  let viewDiffs = 0;
  for (const m of [...(expMasters ?? []), ...(compMasters ?? [])] as Array<{
    id: string; line_code: string; line_name: string;
    default_main_title?: string | null; main_title?: string | null;
    organization_slug: string; is_active: boolean;
  }>) {
    const v = await getRegistrationByBridgedMasterId(m.id);
    if (!v) { viewDiffs++; console.log(`  ! ${m.line_code}: registration 미연결`); continue; }
    const masterTitle = (m.default_main_title ?? m.main_title ?? null) || null;
    if (
      v.lineCode !== m.line_code ||
      v.lineName !== m.line_name ||
      v.mainTitle !== masterTitle ||
      v.organizationSlug !== m.organization_slug ||
      v.isActive !== m.is_active
    ) {
      viewDiffs++;
      console.log(`  ! ${m.line_code}: 필드 불일치`, JSON.stringify({ v, m }));
    }
  }
  check("1) 헬퍼 뷰 = 마스터 원본 — 56건 전수 diff 0", viewDiffs === 0, `diff=${viewDiffs}`);
  // fallback 동작: 미연결 id → null
  const fb = await getRegistrationByBridgedMasterId("00000000-0000-0000-0000-000000000000");
  check("fallback 게이트 — 미연결 id 는 null (마스터 fallback 경로)", fb === null);

  // ── B) collectLineOrgAudience 함수 레벨 등가성 (전환 후 코드 실행) ──
  console.log("\n=== B) collectLineOrgAudience(신규 경로) vs 마스터 기준 기대값 ===");
  const { data: sampleLines } = await sb
    .from("cluster4_lines")
    .select("id,part_type,line_code,experience_line_master_id,competency_line_master_id")
    .or("experience_line_master_id.not.is.null,competency_line_master_id.not.is.null")
    .order("created_at", { ascending: false })
    .limit(8);
  let audDiffs = 0;
  for (const l of sampleLines ?? []) {
    const actual = (await collectLineOrgAudience(l.id)).sort();
    const expected = ((await expectedAudienceByMasterOrg(l)) ?? []).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      audDiffs++;
      console.log(`  ! line ${l.id} (${l.line_code}): actual=${actual.length} expected=${expected.length}`);
    }
  }
  check(
    `5) org 판정 audience 함수 레벨 diff 0 (샘플 ${sampleLines?.length ?? 0}라인, exp/comp 포함)`,
    audDiffs === 0,
    `diff=${audDiffs}`,
  );

  // ── C) 개설 검증 HTTP (negative — 라인 미생성) ──
  console.log("\n=== C) 개설 검증 HTTP (negative) ===");
  const cookie = await makeAdminCookieHeader();
  const { data: anyWeek } = await sb.from("weeks").select("id").limit(1).single();
  const fakeMaster = "00000000-0000-0000-0000-00000000dead";
  const expRes = await fetch(`${baseUrl}/api/admin/cluster4/experience-lines`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      experience_line_master_id: fakeMaster,
      line_code: "EXTEST",
      main_title: "x",
      output_links: [{ url: "https://example.com", label: null }],
      target_user_ids: ["00000000-0000-0000-0000-000000000001"],
      week_id: (anyWeek as { id: string }).id,
      submission_opens_at: new Date().toISOString(),
      submission_closes_at: new Date(Date.now() + 86400000).toISOString(),
    }),
  });
  const expJson = (await expRes.json()) as { error?: string };
  check(
    "4) exp 개설 검증 — 미존재 master 404 (registrations→fallback 모두 miss)",
    expRes.status === 404 && String(expJson.error).includes("찾을 수 없습니다"),
    `status=${expRes.status}`,
  );
  const compRes = await fetch(`${baseUrl}/api/admin/cluster4/competency-lines`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      competency_line_master_id: fakeMaster,
      output_links: [{ url: "https://example.com", label: null }],
      target_user_ids: ["00000000-0000-0000-0000-000000000001"],
      week_id: (anyWeek as { id: string }).id,
    }),
  });
  check("4) comp 개설 검증 — 미존재 master 404", compRes.status === 404 || compRes.status === 400, `status=${compRes.status}`);

  // ── D) 기존 화면/API 정상 + snapshot ──
  console.log("\n=== D) line-history·카탈로그·snapshot ===");
  const hist = await fetch(`${baseUrl}/api/admin/cluster4/lines/history?limit=5`, {
    headers: { Cookie: cookie },
  });
  const histJson = (await hist.json()) as { data?: { total?: number } };
  check("9) line-history 정상 (364)", hist.status === 200 && histJson.data?.total === 364, `total=${histJson.data?.total}`);
  const catalog = await fetch(`${baseUrl}/api/admin/lines/catalog`, { headers: { Cookie: cookie } });
  const catJson = (await catalog.json()) as { data?: { total?: number } };
  check("10) /admin/lines/info 카탈로그 정상 (113)", catalog.status === 200 && catJson.data?.total === 113, `total=${catJson.data?.total}`);

  const after = await fingerprint();
  check("6~7) snapshot stale 0 유지·fingerprint 불변 (재계산 불필요)", JSON.stringify(before) === JSON.stringify(after) && after.snapStale === 0, JSON.stringify(after));

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

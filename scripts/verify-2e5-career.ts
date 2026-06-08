/**
 * Phase 2E-5 검증: 테스트 정리 사후 + career 역방향 sync 왕복.
 *   npx tsx --env-file=.env.local scripts/verify-2e5-career.ts
 * 왕복: 통합 등록(career) 생성 → 브리지(career_projects mirror 생성) →
 *       sponsor-meta PATCH → registration 동기화 확인 → 정리(전부 삭제, 원상복구).
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { createLineRegistration } from "@/lib/adminLineRegistrationsData";
import { bridgeLineRegistration } from "@/lib/adminLineBridgeData";

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
  const { data: l, error: le } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: adminEmail,
  });
  if (le || !l?.properties?.email_otp) throw new Error(le?.message ?? "generateLink failed");
  const { data: v, error: ve } = await anon.auth.verifyOtp({
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

async function actorAdminId(): Promise<string> {
  const { data } = await sb.from("admin_users").select("id").eq("email", adminEmail).maybeSingle();
  if (!data) throw new Error("admin_users row not found");
  return (data as { id: string }).id;
}

async function main() {
  const stamp = Date.now();
  const before = await fingerprint();
  console.log("fingerprint(before):", JSON.stringify(before));

  // ── 1~3) 정리 사후 상태 ──
  console.log("\n=== 1~3) 테스트 career 정리 사후 ===");
  const careerProjects = await count("career_projects");
  check("2) career_projects 테스트 행 0건 (테이블 0건)", careerProjects === 0, `count=${careerProjects}`);
  const careerLines = await count("cluster4_lines", (q) => q.eq("part_type", "career"));
  check("3) career cluster4_lines 0건", careerLines === 0);
  check(
    "3) career_records/weeks/evaluations 영향 0건",
    (await count("career_records")) === 0 &&
      (await count("career_project_weeks")) === 0 &&
      (await count("cluster4_career_line_evaluations")) === 0,
  );
  check("lines 총량 364→363 (테스트 라인 1건 의도 삭제)", before.lines === 363, `lines=${before.lines}`);

  // ── 역방향 sync 왕복 ──
  console.log("\n=== career 역방향 sync 왕복 ===");
  const actor = await actorAdminId();
  const reg = await createLineRegistration(
    {
      lineName: `2E5검증 경력 ${stamp}`,
      hub: "career",
      lineType: "일반",
      lineCode: `WC25-${stamp}`,
      mainTitleMode: "fixed",
      mainTitle: "2E5 타이틀",
      unitLink: "-",
      organizationSlug: "oranke",
      partnerCompany: "원래제휴사",
      companyLogoUrl: null,
      managerName: "원래담당",
      managerPosition: "대리",
      managerJob: "기획",
      managerProfileKey: "토르",
    },
    actor,
  );
  const bridge = await bridgeLineRegistration(reg.id);
  check("브리지 → career_projects mirror 생성", bridge.action === "created" && bridge.masterTable === "career_projects", JSON.stringify(bridge));
  const projectId = bridge.masterId;
  // 프로필 NULL 정책 확인 (결정 2 — 이번 Phase 보류)
  const { data: mirror } = await sb
    .from("career_projects")
    .select("supervisor_profile_img,company_name,supervisor_name")
    .eq("id", projectId)
    .maybeSingle();
  check("프로필 NULL 정책 유지 (supervisor_profile_img=null)", mirror?.supervisor_profile_img === null);

  // sponsor-meta PATCH → registration 동기화
  const cookie = await makeAdminCookieHeader();
  const metaRes = await fetch(`${baseUrl}/api/admin/career-projects/${projectId}/sponsor-meta`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      company_name: "수정제휴사",
      supervisor_name: "수정담당",
      supervisor_position: "팀장",
      supervisor_department: "마케팅",
    }),
  });
  const metaJson = (await metaRes.json()) as {
    success: boolean;
    driftSync?: { synced: boolean; warning: string | null };
  };
  check(
    "sponsor-meta PATCH 200 + driftSync.synced=true",
    metaRes.status === 200 && metaJson.driftSync?.synced === true,
    JSON.stringify(metaJson.driftSync),
  );
  const { data: regAfter } = await sb
    .from("line_registrations")
    .select("partner_company,manager_name,manager_position,manager_job,manager_profile_key")
    .eq("id", reg.id)
    .maybeSingle();
  check(
    "registration 역방향 동기화 (제휴사/담당자/직급/직무)",
    regAfter?.partner_company === "수정제휴사" &&
      regAfter?.manager_name === "수정담당" &&
      regAfter?.manager_position === "팀장" &&
      regAfter?.manager_job === "마케팅",
    JSON.stringify(regAfter),
  );
  check("manager_profile_key 보존 (URL→토큰 역매핑 제외 정책)", regAfter?.manager_profile_key === "토르");

  // 미연결 행 동작 불변: 직접 career_projects 행 생성 후 PATCH → synced=false·warning null
  const { data: orphan } = await sb
    .from("career_projects")
    .insert({
      line_code: `WCOR-${stamp}`,
      line_name: "미연결 검증",
      organization_slug: "oranke",
      output_links: [], output_images: [], company_homepage_links: [],
      default_output_images: [], default_target_user_ids: [],
    })
    .select("id")
    .single();
  const orphanId = (orphan as { id: string }).id;
  const orphanRes = await fetch(`${baseUrl}/api/admin/career-projects/${orphanId}/sponsor-meta`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ company_name: "미연결수정" }),
  });
  const orphanJson = (await orphanRes.json()) as {
    success: boolean;
    driftSync?: { synced: boolean; warning: string | null };
  };
  check(
    "미연결 career_projects — 기존 동작 유지 (synced=false, warning 없음)",
    orphanRes.status === 200 && orphanJson.driftSync?.synced === false && orphanJson.driftSync?.warning === null,
    JSON.stringify(orphanJson.driftSync),
  );

  // ── 정리 (원상복구: career_projects 2건 + registration 1건 삭제) ──
  console.log("\n=== 정리 ===");
  for (const id of [projectId, orphanId]) {
    const del = await fetch(`${baseUrl}/api/admin/career-projects/${id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    console.log(`  career_projects DELETE ${id}: ${del.status}`);
  }
  await sb.from("line_registrations").delete().eq("id", reg.id);
  console.log("  검증 registration 삭제 ✓");
  const remainProjects = await count("career_projects");
  const remainRegs = await count("line_registrations");
  check("정리 후 career_projects 0건·registrations 56건 복귀", remainProjects === 0 && remainRegs === 56, `projects=${remainProjects} regs=${remainRegs}`);

  // ── 7~8) snapshot ──
  console.log("\n=== 7~8) snapshot ===");
  const after = await fingerprint();
  check(
    "snapshot stale 0·fingerprint 불변 (재계산 불필요)",
    JSON.stringify(before) === JSON.stringify(after) && after.snapStale === 0,
    JSON.stringify(after),
  );

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

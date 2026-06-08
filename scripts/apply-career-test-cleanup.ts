/**
 * 2E-5 — 테스트 career_projects 1건 정리 (2026-06-07 사용자 삭제 승인).
 *   npx tsx --env-file=.env.local scripts/apply-career-test-cleanup.ts            # dry-run
 *   npx tsx --env-file=.env.local scripts/apply-career-test-cleanup.ts --apply    # 실삭제
 * 절차: 참조 0건 재확인(targets/submissions/weeks/records/evaluations) →
 *       full-row 백업 → 연결 cluster4_lines 를 기존 삭제 플로우(DELETE API)로 정리 →
 *       career_projects 를 기존 삭제 플로우(DELETE API)로 정리 → 사후 검증.
 * 참조가 1건이라도 있으면 중단 (안전 게이트).
 */
import { writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const APPLY = process.argv.includes("--apply");
const TEST_PROJECT_ID = "3f8c0cef-a3c6-4013-99e9-9a95ec2d60ca"; // "테스트 라인명 프로젝트"

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

async function makeAdminCookieHeader() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const admin = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY!);
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

async function count(table: string, filter: (q: any) => any): Promise<number> {
  const { count: c, error } = await filter(
    sb.from(table).select("*", { count: "exact", head: true }),
  );
  if (error) throw new Error(`${table}: ${error.message}`);
  return c ?? 0;
}

async function main() {
  console.log(`=== career 테스트 정리 ${APPLY ? "APPLY" : "DRY-RUN"} ===`);

  // 0. 대상 확인
  const { data: project } = await sb
    .from("career_projects")
    .select("*")
    .eq("id", TEST_PROJECT_ID)
    .maybeSingle();
  if (!project) {
    console.log("대상 career_projects 행이 이미 없습니다 — 종료");
    return;
  }
  console.log(`대상: ${project.line_name} (${project.line_code}) / ${project.company_name}`);

  const { data: lines } = await sb
    .from("cluster4_lines")
    .select("*")
    .eq("career_project_id", TEST_PROJECT_ID);
  const lineIds = (lines ?? []).map((l) => l.id as string);
  console.log(`연결 cluster4_lines: ${lineIds.length}건 (${lineIds.join(", ") || "-"})`);

  // 1. 참조 0건 안전 게이트 (재확인)
  const targets = lineIds.length
    ? await count("cluster4_line_targets", (q) => q.in("line_id", lineIds))
    : 0;
  const { data: targetRows } = lineIds.length
    ? await sb.from("cluster4_line_targets").select("id").in("line_id", lineIds)
    : { data: [] };
  const tids = (targetRows ?? []).map((t) => t.id as string);
  const submissions = tids.length
    ? await count("cluster4_line_submissions", (q) => q.in("line_target_id", tids))
    : 0;
  const weeks = await count("career_project_weeks", (q) => q.eq("project_id", TEST_PROJECT_ID));
  const records = await count("career_records", (q) => q.eq("project_id", TEST_PROJECT_ID));
  const evals = tids.length
    ? await count("cluster4_career_line_evaluations", (q) => q.in("line_target_id", tids))
    : 0;
  console.log(
    `참조 재확인: targets=${targets} submissions=${submissions} weeks=${weeks} records=${records} evaluations=${evals}`,
  );
  if (targets + submissions + weeks + records + evals > 0) {
    console.error("! 참조가 존재합니다 — 중단 (삭제하지 않음)");
    process.exit(1);
  }

  // registrations 사본 여부 (없어야 정상 — 2D 에서 제외)
  const regCopies = await count("line_registrations", (q) =>
    q.eq("bridged_master_id", TEST_PROJECT_ID),
  );
  console.log(`bridged registration 사본: ${regCopies}건 (0 기대)`);

  if (!APPLY) {
    console.log("\n[dry-run] 삭제하지 않았습니다. 실삭제: --apply");
    return;
  }

  // 2. 백업
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `claudedocs/career-test-cleanup-backup-${ts}.json`;
  writeFileSync(backupPath, JSON.stringify({ project, lines }, null, 2), "utf8");
  console.log(`백업 저장: ${backupPath}`);

  // 3. 기존 삭제 플로우 — 라인 먼저(FK), 그다음 프로젝트
  const cookie = await makeAdminCookieHeader();
  for (const lineId of lineIds) {
    const res = await fetch(`${baseUrl}/api/admin/cluster4/lines/${lineId}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
    console.log(`  라인 DELETE ${lineId}: ${res.status} ${json.success ? "✓" : json.error}`);
    if (!json.success) process.exit(1);
  }
  const res = await fetch(`${baseUrl}/api/admin/career-projects/${TEST_PROJECT_ID}`, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
  console.log(`  career_projects DELETE: ${res.status} ${json.success ? "✓" : json.error}`);
  if (!json.success) process.exit(1);

  // 4. 사후 검증
  const remainProject = await count("career_projects", (q) => q.eq("id", TEST_PROJECT_ID));
  const remainLines = await count("cluster4_lines", (q) =>
    q.eq("career_project_id", TEST_PROJECT_ID),
  );
  console.log(`사후: career_projects=${remainProject} (0 기대), 연결 lines=${remainLines} (0 기대)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

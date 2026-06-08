/**
 * Phase 2D 백필 검증 (사용자 지정 10항목 중 1~9 — 10번 브라우저는 별도 스크립트).
 *   npx tsx --env-file=.env.local scripts/verify-2d-backfill.ts
 * READ-ONLY.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
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

async function main() {
  // ── 1~4) registrations 건수·분포 ──
  console.log("=== 1~4) line_registrations 건수/분포 ===");
  const { data: regs, error } = await sb
    .from("line_registrations")
    .select("hub,line_type,line_code,organization_slug,bridged_master_id,bridged_at,main_title,main_title_mode,unit_link");
  if (error) throw new Error(error.message);
  const rows = regs ?? [];
  check("1) 총 56건 insert", rows.length === 56, `실제=${rows.length}`);
  const expCount = rows.filter((r) => r.hub === "experience").length;
  const compCount = rows.filter((r) => r.hub === "competency").length;
  check("2) 경험 26 / 역량 30 분포", expCount === 26 && compCount === 30, `exp=${expCount} comp=${compCount}`);
  const dist: Record<string, number> = {};
  for (const r of rows.filter((x) => x.hub === "competency")) {
    dist[r.line_type] = (dist[r.line_type] ?? 0) + 1;
  }
  check(
    "3) 역량 분류 원리10/기술10/관점5/자원5",
    dist["원리"] === 10 && dist["기술"] === 10 && dist["관점"] === 5 && dist["자원"] === 5,
    JSON.stringify(dist),
  );
  check("4) career 이관 0건", rows.filter((r) => r.hub === "career").length === 0);
  // 보강: 전건 bridged 연결 + org 보유 + unit_link '-'
  check("전건 bridged_master_id/bridged_at 기록", rows.every((r) => r.bridged_master_id && r.bridged_at));
  check("전건 organization_slug 보유", rows.every((r) => Boolean(r.organization_slug)));
  check("전건 unit_link='-'", rows.every((r) => r.unit_link === "-"));
  // bridged id 가 실제 마스터를 가리키는지 전수 확인
  const expIds = new Set(
    ((await sb.from("cluster4_experience_line_masters").select("id")).data ?? []).map((r) => r.id),
  );
  const compIds = new Set(
    ((await sb.from("cluster4_competency_line_masters").select("id")).data ?? []).map((r) => r.id),
  );
  check(
    "전건 bridged_master_id → 실제 마스터 존재",
    rows.every((r) =>
      r.hub === "experience" ? expIds.has(r.bridged_master_id) : compIds.has(r.bridged_master_id),
    ),
  );

  // ── 5) 기존 마스터 무변경 (apply 전 스냅과 full JSON 비교) ──
  console.log("\n=== 5) 기존 마스터 무변경 ===");
  const before = JSON.parse(
    readFileSync("claudedocs/2d-masters-snapshot-before.json", "utf8"),
  ) as { exp: unknown[]; comp: unknown[]; career: unknown[] };
  const expNow = (await sb.from("cluster4_experience_line_masters").select("*").order("id")).data;
  const compNow = (await sb.from("cluster4_competency_line_masters").select("*").order("id")).data;
  const careerNow = (await sb.from("career_projects").select("*").order("id")).data;
  check("경험 마스터 26건 전 필드 동일", JSON.stringify(before.exp) === JSON.stringify(expNow));
  check("역량 마스터 30건 전 필드 동일", JSON.stringify(before.comp) === JSON.stringify(compNow));
  check("career_projects 전 필드 동일 (이관 제외 확인)", JSON.stringify(before.career) === JSON.stringify(careerNow));

  // ── 6~7) 통합 조회 direct vs HTTP ──
  console.log("\n=== 6~7) /admin/lines/info 통합 조회 (direct vs HTTP) ===");
  const direct = await listLineCatalog({ sort: "latest" });
  check(
    "6) countsBySource = 경험26·역량30·경력1·등록56",
    direct.countsBySource.experience_master === 26 &&
      direct.countsBySource.competency_master === 30 &&
      direct.countsBySource.career_master === 1 &&
      direct.countsBySource.registration === 56,
    JSON.stringify(direct.countsBySource),
  );
  check("통합 total=113", direct.total === 113, String(direct.total));
  const cookie = await makeAdminCookieHeader();
  const res = await fetch(`${baseUrl}/api/admin/lines/catalog?sort=latest`, {
    headers: { Cookie: cookie },
  });
  const json = (await res.json()) as { data: typeof direct };
  check(
    "7) direct rows = HTTP rows (JSON 완전 일치)",
    res.status === 200 && JSON.stringify(json.data.rows) === JSON.stringify(direct.rows),
    `direct=${direct.rows.length} http=${json.data.rows.length}`,
  );
  // 이관 행이 '연결됨'(bridgedMasterId) 상태로 노출되는지
  const regRows = json.data.rows.filter((r) => r.source === "registration");
  check("이관 행 전건 bridgedMasterId 노출 (연결됨 상태)", regRows.length === 56 && regRows.every((r) => Boolean(r.bridgedMasterId)));

  // ── 8~9) snapshot ──
  console.log("\n=== 8~9) snapshot ===");
  const { count: snapTotal } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("*", { count: "exact", head: true });
  const { count: snapStale } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("*", { count: "exact", head: true })
    .eq("is_stale", true);
  const { count: lines } = await sb
    .from("cluster4_lines")
    .select("*", { count: "exact", head: true });
  const { count: targets } = await sb
    .from("cluster4_line_targets")
    .select("*", { count: "exact", head: true });
  check(
    "8) snapshot/lines/targets 불변 (122/0/364/1233)",
    snapTotal === 122 && snapStale === 0 && lines === 364 && targets === 1233,
    JSON.stringify({ snapTotal, snapStale, lines, targets }),
  );
  check("9) is_stale=0 유지 — 재계산 불필요", snapStale === 0);

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

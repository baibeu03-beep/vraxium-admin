/**
 * /admin/lines/register HTTP + DB 검증 (unit_link 정정판, 2026-06-07).
 *   npx tsx --env-file=.env.local scripts/verify-line-register-http.ts
 * 검증 항목:
 *   1) POST career 라인 (전용 필드 + 유닛 링크 일반 텍스트) → 201 + DB 실저장
 *   2) POST 유닛 링크 미입력 → DB unit_link='-'
 *   3) POST 변동 메인타이틀 → DB main_title='-'
 *   4) POST 비career 허브 + career 필드 전송 → DB null 강제
 *   5) 허브×라인종류 불일치 → 400
 *   6) GET 목록 unitLink 노출 + deprecated output_links/output_images 미사용(신규 행 [])
 *   7) snapshot/demoUserId/일반 사용자 경로 무영향: 관련 테이블 fingerprint 불변
 *   8) 기존 등록분(deprecated jsonb 값) 보존
 * 사전 조건: 마이그레이션 #38·#39 적용 + dev 서버(3000) 기동.
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
      setAll: (items) =>
        captured.push(...items.map((i) => ({ name: i.name, value: i.value }))),
    },
  });
  const { error: se } = await server.auth.setSession({
    access_token: v.session.access_token,
    refresh_token: v.session.refresh_token,
  });
  if (se) throw new Error(se.message);
  return captured.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function api(cookie: string, path: string, init?: RequestInit) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      ...(init?.headers ?? {}),
    },
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

async function fingerprint() {
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
  return { snapTotal, snapStale, lines, targets };
}

async function main() {
  const stamp = Date.now();
  const cookie = await makeAdminCookieHeader();
  console.log("admin 세션 쿠키 확보 ✓\n");

  const before = await fingerprint();
  console.log("=== snapshot/기존 SoT fingerprint (before) ===");
  console.log(" ", JSON.stringify(before));

  // 기존 등록분 deprecated jsonb 값 스냅 (보존 검증용)
  const { data: legacyBefore } = await sb
    .from("line_registrations")
    .select("id,output_links,output_images")
    .order("created_at", { ascending: true })
    .limit(1);
  const legacyRow = legacyBefore?.[0] ?? null;

  // ── 1) career 라인 등록 (유닛 링크 = 일반 텍스트) ──
  console.log("\n=== 1) POST career 라인 (유닛 링크 일반 텍스트) ===");
  const unitLinkText = "구글 드라이브 폴더 > 마케팅 자료 (URL 아님, 일반 텍스트)";
  const r1 = await api(cookie, "/api/admin/lines/registrations", {
    method: "POST",
    body: JSON.stringify({
      line_name: `UL검증 경력 라인 ${stamp}`,
      hub: "career",
      line_type: "일반",
      line_code: `WCUL-${stamp}`,
      main_title_mode: "fixed",
      main_title: "검증용 고정 메인 타이틀",
      unit_link: unitLinkText,
      partner_company: "검증제휴사",
      company_logo_url: "https://example.com/logo.png",
      manager_name: "김검증",
      manager_position: "팀장",
      manager_job: "마케팅",
      manager_profile_key: "잔다르크",
    }),
  });
  check("HTTP 201", r1.status === 201, `status=${r1.status} ${JSON.stringify(r1.json).slice(0, 220)}`);
  const careerId = (r1.json as { data?: { id?: string; unitLink?: string } }).data?.id ?? null;
  check(
    "응답 DTO unitLink = 입력 텍스트",
    (r1.json as { data?: { unitLink?: string } }).data?.unitLink === unitLinkText,
  );
  const { data: dbCareer } = await sb
    .from("line_registrations")
    .select("*")
    .eq("id", careerId ?? "00000000-0000-0000-0000-000000000000")
    .maybeSingle();
  check("DB 행 존재", Boolean(dbCareer));
  if (dbCareer) {
    check("DB unit_link = 입력 텍스트 그대로", dbCareer.unit_link === unitLinkText, dbCareer.unit_link);
    check(
      "deprecated output_links 미사용(빈 배열)",
      Array.isArray(dbCareer.output_links) && dbCareer.output_links.length === 0,
      JSON.stringify(dbCareer.output_links),
    );
    check(
      "deprecated output_images 미사용(빈 배열)",
      Array.isArray(dbCareer.output_images) && dbCareer.output_images.length === 0,
    );
    check("partner_company 저장", dbCareer.partner_company === "검증제휴사");
    check("manager_profile_key 저장", dbCareer.manager_profile_key === "잔다르크");
  }

  // ── 2) 유닛 링크 미입력 → '-' ──
  console.log("\n=== 2) POST 유닛 링크 미입력 → '-' ===");
  const r2 = await api(cookie, "/api/admin/lines/registrations", {
    method: "POST",
    body: JSON.stringify({
      line_name: `UL검증 정보 라인 ${stamp}`,
      hub: "info",
      line_type: "일반",
      line_code: `IFUL-${stamp}`,
      main_title_mode: "variable",
      // unit_link 미전송
    }),
  });
  check("HTTP 201", r2.status === 201, `status=${r2.status}`);
  const infoId = (r2.json as { data?: { id?: string } }).data?.id ?? null;
  const { data: dbInfo } = await sb
    .from("line_registrations")
    .select("unit_link,main_title,main_title_mode")
    .eq("id", infoId ?? "00000000-0000-0000-0000-000000000000")
    .maybeSingle();
  check("DB unit_link='-'", dbInfo?.unit_link === "-", JSON.stringify(dbInfo));
  check("변동 → DB main_title='-'", dbInfo?.main_title === "-");

  // 공백 문자열도 '-' 처리
  const r2b = await api(cookie, "/api/admin/lines/registrations", {
    method: "POST",
    body: JSON.stringify({
      line_name: `UL검증 공백 라인 ${stamp}`,
      hub: "experience",
      line_type: "분석",
      line_code: `EXUL-${stamp}`,
      main_title_mode: "fixed",
      main_title: "경험 타이틀",
      unit_link: "   ",
      partner_company: "무시되어야 함",
    }),
  });
  const expId = (r2b.json as { data?: { id?: string } }).data?.id ?? null;
  const { data: dbExp } = await sb
    .from("line_registrations")
    .select("unit_link,partner_company,manager_name")
    .eq("id", expId ?? "00000000-0000-0000-0000-000000000000")
    .maybeSingle();
  check("공백 입력 → DB unit_link='-'", dbExp?.unit_link === "-", JSON.stringify(dbExp));
  check("비career career 필드 null 강제", dbExp?.partner_company === null && dbExp?.manager_name === null);

  // ── 3) 허브×종류 불일치 → 400 ──
  console.log("\n=== 3) 허브×라인종류 불일치 검증 ===");
  const r3 = await api(cookie, "/api/admin/lines/registrations", {
    method: "POST",
    body: JSON.stringify({
      line_name: "잘못된 조합",
      hub: "competency",
      line_type: "도출",
      line_code: "CPUL-BAD",
      main_title_mode: "fixed",
      main_title: "x",
    }),
  });
  check("HTTP 400", r3.status === 400, `status=${r3.status} ${String(r3.json.error)}`);

  // ── 4) GET 목록 — unitLink 노출 ──
  console.log("\n=== 4) GET 목록 unitLink 노출 ===");
  const r4 = await api(cookie, "/api/admin/lines/registrations?limit=50");
  check("HTTP 200", r4.status === 200, `status=${r4.status}`);
  const listRows = ((r4.json as {
    data?: { rows?: Array<{ id: string; unitLink?: string }> };
  }).data?.rows ?? []);
  const careerRow = listRows.find((row) => row.id === careerId);
  const infoRow = listRows.find((row) => row.id === infoId);
  check("career 행 unitLink = 입력 텍스트", careerRow?.unitLink === unitLinkText);
  check("미입력 행 unitLink = '-'", infoRow?.unitLink === "-");
  check(
    "DTO 에 outputLinks/outputImages 부재 (deprecated)",
    careerRow !== undefined &&
      !("outputLinks" in (careerRow as object)) &&
      !("outputImages" in (careerRow as object)),
  );

  // ── 5) 기존 등록분 deprecated jsonb 보존 ──
  console.log("\n=== 5) 기존 등록분 보존 ===");
  if (legacyRow) {
    const { data: legacyAfter } = await sb
      .from("line_registrations")
      .select("id,output_links,output_images,unit_link")
      .eq("id", legacyRow.id)
      .maybeSingle();
    check(
      "기존 행 output_links 값 보존",
      JSON.stringify(legacyAfter?.output_links) === JSON.stringify(legacyRow.output_links),
    );
    check("기존 행 unit_link='-' 백필", legacyAfter?.unit_link === "-", String(legacyAfter?.unit_link));
  } else {
    console.log("  (기존 등록분 없음 — 보존 검증 생략)");
  }

  // ── 6) snapshot/기존 SoT 무영향 ──
  console.log("\n=== 6) snapshot/기존 SoT 무영향 (after) ===");
  const after = await fingerprint();
  console.log(" ", JSON.stringify(after));
  check("cluster4_weekly_card_snapshots 행 수 불변", after.snapTotal === before.snapTotal);
  check("is_stale 수 불변", after.snapStale === before.snapStale);
  check("cluster4_lines 행 수 불변", after.lines === before.lines);
  check("cluster4_line_targets 행 수 불변", after.targets === before.targets);

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

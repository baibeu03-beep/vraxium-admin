/**
 * Phase 2C 검증: 개설 브리지 (direct · HTTP · 일치 · snapshot · 무덮어쓰기 · rollback).
 *   npx tsx --env-file=.env.local scripts/verify-line-bridge-http.ts
 * 흐름: 테스트 등록 생성 → 브리지(direct 1건·HTTP 1건·found 1건·멱등 1건·차단 2건) →
 *       마스터 실생성/연결 확인 → 기존 마스터 무수정 확인 → 기존 개설 드롭다운 노출 확인 →
 *       snapshot fingerprint → 생성물 전부 정리(rollback 시연).
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { bridgeLineRegistration } from "@/lib/adminLineBridgeData";
import { createLineRegistration } from "@/lib/adminLineRegistrationsData";

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

// 검증용 등록 생성 (admin id 는 운영자 계정 — admin_users 조회).
async function actorAdminId(): Promise<string> {
  const { data } = await sb
    .from("admin_users")
    .select("id")
    .eq("email", adminEmail)
    .maybeSingle();
  if (!data) throw new Error("admin_users row not found for " + adminEmail);
  return (data as { id: string }).id;
}

async function main() {
  const stamp = Date.now();
  const before = await fingerprint();
  console.log("=== snapshot fingerprint (before) ===");
  console.log(" ", JSON.stringify(before));
  const actor = await actorAdminId();
  const cookie = await makeAdminCookieHeader();

  const createdRegIds: string[] = [];
  const createdMasterCleanup: Array<{ table: string; id: string }> = [];

  try {
    // ── 준비: 검증용 등록 5건 ──
    const regComp = await createLineRegistration(
      {
        lineName: `2C검증 역량 라인 ${stamp}`,
        hub: "competency",
        lineType: "원리",
        lineCode: `CPBR-${stamp}`,
        mainTitleMode: "fixed",
        mainTitle: "2C 역량 고정 타이틀",
        unitLink: "-",
        organizationSlug: "encre",
        partnerCompany: null, companyLogoUrl: null, managerName: null,
        managerPosition: null, managerJob: null, managerProfileKey: null,
      },
      actor,
    );
    createdRegIds.push(regComp.id);
    const regExp = await createLineRegistration(
      {
        lineName: `2C검증 경험 라인 ${stamp}`,
        hub: "experience",
        lineType: "분석",
        lineCode: `EXBR-${stamp}`,
        mainTitleMode: "variable",
        mainTitle: "-",
        unitLink: "참고 메모",
        organizationSlug: "oranke",
        partnerCompany: null, companyLogoUrl: null, managerName: null,
        managerPosition: null, managerJob: null, managerProfileKey: null,
      },
      actor,
    );
    createdRegIds.push(regExp.id);
    // 기존 마스터 found 케이스 — 운영 역량 마스터 CPBS-NN0001(org=common) 과 동일 키.
    const regFound = await createLineRegistration(
      {
        lineName: `2C검증 기존연결 ${stamp}`, // 마스터의 line_name 과 다름 — 무덮어쓰기 검증용
        hub: "competency",
        lineType: "기술",
        lineCode: "CPBS-NN0001",
        mainTitleMode: "fixed",
        mainTitle: "이 값이 마스터를 덮어쓰면 안 됨",
        unitLink: "-",
        organizationSlug: "common",
        partnerCompany: null, companyLogoUrl: null, managerName: null,
        managerPosition: null, managerJob: null, managerProfileKey: null,
      },
      actor,
    );
    createdRegIds.push(regFound.id);
    const regInfo = await createLineRegistration(
      {
        lineName: `2C검증 정보 라인 ${stamp}`,
        hub: "info",
        lineType: "일반",
        lineCode: `IFBR-${stamp}`,
        mainTitleMode: "fixed",
        mainTitle: "정보 타이틀",
        unitLink: "-",
        organizationSlug: "common",
        partnerCompany: null, companyLogoUrl: null, managerName: null,
        managerPosition: null, managerJob: null, managerProfileKey: null,
      },
      actor,
    );
    createdRegIds.push(regInfo.id);
    const regNoOrg = await createLineRegistration(
      {
        lineName: `2C검증 무조직 라인 ${stamp}`,
        hub: "experience",
        lineType: "도출",
        lineCode: `EXNO-${stamp}`,
        mainTitleMode: "fixed",
        mainTitle: "x",
        unitLink: "-",
        organizationSlug: null,
        partnerCompany: null, companyLogoUrl: null, managerName: null,
        managerPosition: null, managerJob: null, managerProfileKey: null,
      },
      actor,
    );
    createdRegIds.push(regNoOrg.id);
    console.log(`\n검증용 등록 ${createdRegIds.length}건 생성 ✓`);

    // ── 4) direct: 역량 브리지 (created 기대) ──
    console.log("\n=== 4) direct bridgeLineRegistration (competency → created) ===");
    const directRes = await bridgeLineRegistration(regComp.id);
    check("direct action=created", directRes.action === "created", JSON.stringify(directRes));
    check("masterTable=competency", directRes.masterTable === "cluster4_competency_line_masters");
    createdMasterCleanup.push({ table: directRes.masterTable, id: directRes.masterId });
    const { data: compMaster } = await sb
      .from("cluster4_competency_line_masters")
      .select("*")
      .eq("id", directRes.masterId)
      .maybeSingle();
    check("마스터 실생성 (DB)", Boolean(compMaster));
    check(
      "마스터 필드 매핑 (name/code/org/title)",
      compMaster?.line_name === `2C검증 역량 라인 ${stamp}` &&
        compMaster?.line_code === `CPBR-${stamp}` &&
        compMaster?.organization_slug === "encre" &&
        compMaster?.main_title === "2C 역량 고정 타이틀",
      JSON.stringify({ n: compMaster?.line_name, o: compMaster?.organization_slug }),
    );
    const { data: regCompAfter } = await sb
      .from("line_registrations")
      .select("bridged_master_id,bridged_at")
      .eq("id", regComp.id)
      .maybeSingle();
    check("bridged_master_id 기록", regCompAfter?.bridged_master_id === directRes.masterId);
    check("bridged_at 기록", Boolean(regCompAfter?.bridged_at));

    // ── 5) HTTP: 경험 브리지 (created 기대 — 변동 타이틀 → default_main_title null) ──
    console.log("\n=== 5) HTTP POST bridge (experience → created) ===");
    const httpRes = await fetch(
      `${baseUrl}/api/admin/lines/registrations/${regExp.id}/bridge`,
      { method: "POST", headers: { Cookie: cookie } },
    );
    const httpJson = (await httpRes.json()) as {
      success: boolean;
      data: { action: string; masterTable: string; masterId: string };
    };
    check("HTTP 200 + action=created", httpRes.status === 200 && httpJson.data.action === "created", JSON.stringify(httpJson.data));
    createdMasterCleanup.push({ table: httpJson.data.masterTable, id: httpJson.data.masterId });
    const { data: expMaster } = await sb
      .from("cluster4_experience_line_masters")
      .select("*")
      .eq("id", httpJson.data.masterId)
      .maybeSingle();
    check(
      "경험 마스터 category/slot 자동 파생 (분석→analysis/2)",
      expMaster?.experience_category === "analysis" && expMaster?.experience_slot_order === 2,
      JSON.stringify({ c: expMaster?.experience_category, s: expMaster?.experience_slot_order }),
    );
    check("변동 타이틀 → default_main_title=null", expMaster?.default_main_title === null);

    // ── 6) direct vs HTTP 일치 (결과 shape + DB 부수효과 동등) ──
    console.log("\n=== 6) direct vs HTTP 일치 ===");
    const directKeys = Object.keys(directRes).sort();
    const httpKeys = Object.keys(httpJson.data).sort();
    check(
      "결과 필드 구조 동일",
      JSON.stringify(directKeys) === JSON.stringify(httpKeys),
      `direct=[${directKeys}] http=[${httpKeys}]`,
    );
    const { data: regExpAfter } = await sb
      .from("line_registrations")
      .select("bridged_master_id")
      .eq("id", regExp.id)
      .maybeSingle();
    check(
      "양쪽 모두 bridged_master_id 기록 (부수효과 동등)",
      Boolean(regCompAfter?.bridged_master_id) && regExpAfter?.bridged_master_id === httpJson.data.masterId,
    );

    // ── found: 기존 마스터 연결 + 무덮어쓰기 ──
    console.log("\n=== found 케이스: 기존 마스터 무덮어쓰기 ===");
    const { data: masterBefore } = await sb
      .from("cluster4_competency_line_masters")
      .select("*")
      .eq("organization_slug", "common")
      .eq("line_code", "CPBS-NN0001")
      .maybeSingle();
    const foundRes = await bridgeLineRegistration(regFound.id);
    check("action=found (기존 마스터 연결)", foundRes.action === "found", JSON.stringify(foundRes));
    check("기존 마스터 id 로 연결", foundRes.masterId === masterBefore?.id);
    const { data: masterAfter } = await sb
      .from("cluster4_competency_line_masters")
      .select("*")
      .eq("id", masterBefore?.id ?? "")
      .maybeSingle();
    check(
      "기존 마스터 전 필드 무수정",
      JSON.stringify(masterBefore) === JSON.stringify(masterAfter),
    );

    // ── 멱등: 再브리지 → already_bridged ──
    const again = await bridgeLineRegistration(regComp.id);
    check("재브리지 멱등 (already_bridged, 동일 마스터)", again.action === "already_bridged" && again.masterId === directRes.masterId);

    // ── 차단: info / org 미지정 ──
    console.log("\n=== 차단 케이스 ===");
    const infoRes = await fetch(
      `${baseUrl}/api/admin/lines/registrations/${regInfo.id}/bridge`,
      { method: "POST", headers: { Cookie: cookie } },
    );
    check("info 브리지 400", infoRes.status === 400, String(((await infoRes.json()) as { error?: string }).error));
    const noOrgRes = await fetch(
      `${baseUrl}/api/admin/lines/registrations/${regNoOrg.id}/bridge`,
      { method: "POST", headers: { Cookie: cookie } },
    );
    check("org 미지정 브리지 400", noOrgRes.status === 400, String(((await noOrgRes.json()) as { error?: string }).error));

    // ── 기존 개설 플로우 노출: 마스터 목록 API 에 신규 마스터 등장 ──
    console.log("\n=== 기존 개설 드롭다운 노출 (마스터 목록 API) ===");
    const compListRes = await fetch(
      `${baseUrl}/api/admin/cluster4/competency-line-masters`,
      { headers: { Cookie: cookie } },
    );
    const compList = (await compListRes.json()) as { data: Array<{ id: string }> };
    check(
      "competency-line-masters 목록에 브리지 마스터 포함",
      compList.data.some((m) => m.id === directRes.masterId),
    );
    const expListRes = await fetch(
      `${baseUrl}/api/admin/cluster4/experience-line-masters`,
      { headers: { Cookie: cookie } },
    );
    const expList = (await expListRes.json()) as { data: Array<{ id: string }> };
    check(
      "experience-line-masters 목록에 브리지 마스터 포함",
      expList.data.some((m) => m.id === httpJson.data.masterId),
    );

    // ── 7~8) snapshot 영향 / 재계산 필요 여부 ──
    console.log("\n=== 7~8) snapshot fingerprint (after) ===");
    const after = await fingerprint();
    console.log(" ", JSON.stringify(after));
    check(
      "snapshot/lines/targets fingerprint 불변 (재계산 불필요)",
      JSON.stringify(before) === JSON.stringify(after),
    );
  } finally {
    // ── rollback 시연 + 정리: 브리지 생성 마스터(개설 0건) 삭제 → 등록 삭제 ──
    console.log("\n=== 정리 (rollback 절차 시연) ===");
    for (const m of createdMasterCleanup) {
      const { count: usedCount } = await sb
        .from("cluster4_lines")
        .select("*", { count: "exact", head: true })
        .or(`experience_line_master_id.eq.${m.id},competency_line_master_id.eq.${m.id}`);
      if ((usedCount ?? 0) > 0) {
        console.log(`  ! ${m.table} ${m.id} 는 개설 라인이 있어 삭제 생략 (is_active=false 권장)`);
        continue;
      }
      const { error } = await sb.from(m.table).delete().eq("id", m.id);
      console.log(`  - ${m.table} ${m.id} 삭제 ${error ? "실패: " + error.message : "✓ (개설 0건 확인 후)"}`);
    }
    if (createdRegIds.length > 0) {
      const { error } = await sb.from("line_registrations").delete().in("id", createdRegIds);
      console.log(`  - 검증 등록 ${createdRegIds.length}건 삭제 ${error ? "실패: " + error.message : "✓"}`);
    }
    const { count: remainRegs } = await sb
      .from("line_registrations")
      .select("*", { count: "exact", head: true });
    console.log(`  잔여 line_registrations: ${remainRegs}건`);
  }

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

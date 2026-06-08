/**
 * 등록 관리 기능 검증 (2E-6 선행) — direct/HTTP/게이트/sync/비활성.
 *   npx tsx --env-file=.env.local scripts/verify-registration-manage.ts
 * 왕복: 테스트 등록 생성→브리지→수정(sync)→게이트(기존 개설 행 409)→비활성(개설 차단)→정리.
 * 기존 데이터는 게이트 409 음성 테스트(쓰기 거부)에만 사용 — 무변경.
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { createLineRegistration, getLineRegistrationDetail, updateLineRegistration } from "@/lib/adminLineRegistrationsData";
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
async function actorAdminId(): Promise<string> {
  const { data } = await sb.from("admin_users").select("id").eq("email", adminEmail).maybeSingle();
  if (!data) throw new Error("admin_users row not found");
  return (data as { id: string }).id;
}

async function main() {
  const stamp = Date.now();
  const before = await fingerprint();
  console.log("fingerprint(before):", JSON.stringify(before));
  const cookie = await makeAdminCookieHeader();
  const actor = await actorAdminId();
  const cleanup: { masterId?: string; regId?: string } = {};

  try {
    // ── 준비: 테스트 등록(역량/encre) + 브리지 ──
    const reg = await createLineRegistration(
      {
        lineName: `MNG검증 ${stamp}`, hub: "competency", lineType: "기술",
        lineCode: `CPMG-${stamp}`, mainTitleMode: "fixed", mainTitle: "원래 타이틀",
        unitLink: "-", organizationSlug: "encre",
        partnerCompany: null, companyLogoUrl: null, managerName: null,
        managerPosition: null, managerJob: null, managerProfileKey: null,
      },
      actor,
    );
    cleanup.regId = reg.id;
    const bridge = await bridgeLineRegistration(reg.id);
    cleanup.masterId = bridge.masterId;

    // ── 1) 수정 가능 + 2) mirror sync (direct) ──
    console.log("\n=== 1~2) direct 수정 + mirror sync ===");
    const upd = await updateLineRegistration(reg.id, {
      lineName: `MNG검증 수정 ${stamp}`,
      mainTitleMode: "variable",
      mainTitle: "-",
      unitLink: "수정된 유닛 링크",
    });
    check("1) registration 수정 (direct)", upd.registration.lineName === `MNG검증 수정 ${stamp}` && upd.registration.mainTitle === "-" && upd.registration.unitLink === "수정된 유닛 링크");
    check("2) driftSync.synced=true", upd.driftSync.synced === true, JSON.stringify(upd.driftSync));
    const { data: master1 } = await sb
      .from("cluster4_competency_line_masters")
      .select("line_name,main_title,organization_slug,is_active")
      .eq("id", bridge.masterId)
      .maybeSingle();
    check("2) mirror 마스터 동기화 (line_name·variable→main_title null)", master1?.line_name === `MNG검증 수정 ${stamp}` && master1?.main_title === null, JSON.stringify(master1));

    // line_code 수정 (개설 0건 — 허용) + mirror
    const upd2 = await updateLineRegistration(reg.id, { lineCode: `CPMG2-${stamp}` });
    const { data: master2 } = await sb
      .from("cluster4_competency_line_masters")
      .select("line_code")
      .eq("id", bridge.masterId)
      .maybeSingle();
    check("개설 0건 — line_code 수정 허용 + mirror 반영", upd2.registration.lineCode === `CPMG2-${stamp}` && master2?.line_code === `CPMG2-${stamp}`);

    // ── 3) 게이트: 개설 라인 보유 행(기존 [통합] 등록)은 409 — 쓰기 거부라 무변경 ──
    console.log("\n=== 3) 개설 라인 게이트 (기존 데이터 음성 테스트) ===");
    const { data: unifiedReg } = await sb
      .from("line_registrations")
      .select("id,line_code,organization_slug,line_type")
      .eq("line_name", "[통합] 주차 활동 내역")
      .eq("hub", "experience")
      .maybeSingle();
    if (!unifiedReg) throw new Error("[통합] 등록을 찾을 수 없음");
    const unifiedId = (unifiedReg as { id: string }).id;
    const detailUnified = await getLineRegistrationDetail(unifiedId);
    check("게이트 대상 확인 — openedLineCount > 0", detailUnified.openedLineCount > 0, `opened=${detailUnified.openedLineCount}`);
    for (const [label, patch] of [
      ["line_code 변경", { lineCode: "EXBS-UN9999" }],
      ["org 변경", { organizationSlug: "encre" as const }],
      ["exp line_type 변경", { lineType: "분석" }],
    ] as const) {
      let blocked = false;
      try {
        await updateLineRegistration(unifiedId, patch as never);
      } catch (e) {
        blocked = (e as { status?: number }).status === 409;
      }
      check(`3) 개설 보유 행 ${label} → 409 차단`, blocked);
    }
    // 값 무변경 재확인
    const { data: unifiedAfter } = await sb
      .from("line_registrations")
      .select("line_code,organization_slug,line_type")
      .eq("id", unifiedId)
      .maybeSingle();
    check("게이트 차단 후 기존 행 무변경", JSON.stringify(unifiedAfter) === JSON.stringify({ line_code: unifiedReg.line_code, organization_slug: unifiedReg.organization_slug, line_type: unifiedReg.line_type }));

    // ── 4) is_active=false → 신규 개설 차단 ──
    console.log("\n=== 4) 비활성 → 신규 개설 차단 ===");
    const updOff = await updateLineRegistration(reg.id, { isActive: false });
    check("비활성 저장 + mirror is_active sync", updOff.registration.isActive === false && updOff.driftSync.synced === true);
    const { data: masterOff } = await sb
      .from("cluster4_competency_line_masters")
      .select("is_active")
      .eq("id", bridge.masterId)
      .maybeSingle();
    check("mirror 마스터 is_active=false", masterOff?.is_active === false);
    const { data: anyWeek } = await sb.from("weeks").select("id").limit(1).single();
    const openRes = await fetch(`${baseUrl}/api/admin/cluster4/competency-lines`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        competency_line_master_id: bridge.masterId,
        output_links: [{ url: "https://example.com", label: null }],
        target_user_ids: ["00000000-0000-0000-0000-000000000001"],
        week_id: (anyWeek as { id: string }).id,
      }),
    });
    check("4) 비활성 등록 → 개설 404 차단", openRes.status === 404, `status=${openRes.status}`);

    // ── 6~8) direct vs HTTP ──
    console.log("\n=== 6~8) direct vs HTTP ===");
    const directDetail = await getLineRegistrationDetail(reg.id);
    const httpDetailRes = await fetch(
      `${baseUrl}/api/admin/lines/registrations/${reg.id}`,
      { headers: { Cookie: cookie } },
    );
    const httpDetail = (await httpDetailRes.json()) as { data: typeof directDetail };
    check("GET 상세 direct = HTTP (JSON 일치)", httpDetailRes.status === 200 && JSON.stringify(httpDetail.data) === JSON.stringify(directDetail));
    const httpPatchRes = await fetch(
      `${baseUrl}/api/admin/lines/registrations/${reg.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ line_name: `MNG검증 HTTP ${stamp}`, is_active: true }),
      },
    );
    const httpPatch = (await httpPatchRes.json()) as {
      success: boolean;
      data: { lineName: string; isActive: boolean };
      driftSync: { synced: boolean };
    };
    check(
      "PATCH HTTP 200 + sync (direct 와 동일 동작)",
      httpPatchRes.status === 200 && httpPatch.data.lineName === `MNG검증 HTTP ${stamp}` && httpPatch.data.isActive === true && httpPatch.driftSync.synced === true,
    );
    const { data: master3 } = await sb
      .from("cluster4_competency_line_masters")
      .select("line_name,is_active")
      .eq("id", bridge.masterId)
      .maybeSingle();
    check("HTTP PATCH 도 mirror 동기화", master3?.line_name === `MNG검증 HTTP ${stamp}` && master3?.is_active === true);
    // career 전용 필드 비career 거부
    const careerOnNonCareer = await fetch(
      `${baseUrl}/api/admin/lines/registrations/${reg.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ partner_company: "x" }),
      },
    );
    check("비career 행 career 필드 400", careerOnNonCareer.status === 400);
    // hub 수정 거부
    const hubPatch = await fetch(
      `${baseUrl}/api/admin/lines/registrations/${reg.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ hub: "career" }),
      },
    );
    check("hub 수정 400 거부", hubPatch.status === 400);
    // DELETE 미제공
    const delRes = await fetch(`${baseUrl}/api/admin/lines/registrations/${reg.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    check("DELETE 미제공 (405)", delRes.status === 405, `status=${delRes.status}`);
  } finally {
    // ── 정리 ──
    console.log("\n=== 정리 ===");
    if (cleanup.masterId) {
      const { count: used } = await sb
        .from("cluster4_lines")
        .select("*", { count: "exact", head: true })
        .eq("competency_line_master_id", cleanup.masterId);
      if ((used ?? 0) === 0) {
        await sb.from("cluster4_competency_line_masters").delete().eq("id", cleanup.masterId);
        console.log("  검증 mirror 마스터 삭제 ✓ (개설 0건 확인)");
      }
    }
    if (cleanup.regId) {
      await sb.from("line_registrations").delete().eq("id", cleanup.regId);
      console.log("  검증 등록 삭제 ✓");
    }
    const remainRegs = await count("line_registrations");
    const remainComp = await count("cluster4_competency_line_masters");
    console.log(`  잔여: registrations=${remainRegs} (56 기대), comp masters=${remainComp} (30 기대)`);
  }

  // ── 5, 10~11) 기존 개설 라인/스냅샷 무영향 ──
  console.log("\n=== 5, 10~11) snapshot/기존 라인 ===");
  const after = await fingerprint();
  check("5) 기존 개설 라인 영향 없음 + 10~11) stale 0·fingerprint 불변", JSON.stringify(before) === JSON.stringify(after) && after.snapStale === 0, JSON.stringify(after));

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

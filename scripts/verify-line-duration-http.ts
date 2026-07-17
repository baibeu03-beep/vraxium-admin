/**
 * 라인 소요 시간(estimated_duration_minutes) HTTP + DB 검증.
 *   npx tsx --env-file=.env.local scripts/verify-line-duration-http.ts
 * 사전 조건: dev 서버(3000) 기동.
 *
 * 마이그레이션 적용 여부를 먼저 감지해 두 모드로 동작한다:
 *   [PRE ]  컬럼 없음  — 조회 graceful degradation + 파서 검증 + "조용히 버리지 않음"을 검증.
 *   [POST]  컬럼 있음  — 전체 스위트(등록/수정/목록/org/경로/스냅샷 무영향).
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
      setAll: (items) => captured.push(...items.map((i) => ({ name: i.name, value: i.value }))),
    },
  });
  const { error: se } = await server.auth.setSession({
    access_token: v.session.access_token,
    refresh_token: v.session.refresh_token,
  });
  if (se) throw new Error(se.message);
  return captured.map((i) => `${i.name}=${i.value}`).join("; ");
}

type ApiResult = { status: number; json: Record<string, unknown> };
async function api(cookie: string, path: string, init?: RequestInit): Promise<ApiResult> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Cookie: cookie, ...(init?.headers ?? {}) },
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

async function columnExists(): Promise<boolean> {
  const { error } = await sb
    .from("line_registrations")
    .select("id,estimated_duration_minutes")
    .limit(1);
  if (!error) return true;
  if (error.code === "42703" || (error.message ?? "").includes("estimated_duration_minutes")) {
    return false;
  }
  throw new Error(`예상치 못한 오류: ${error.code} ${error.message}`);
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
  // snapshot DTO 버전 분포 — 컬럼 추가가 bump 를 유발하지 않았는지(재계산 트리거 없음) 확인.
  const { data: versions } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("dto_version")
    .limit(1000);
  const byVersion: Record<string, number> = {};
  for (const v of (versions ?? []) as Array<{ dto_version: number | null }>) {
    const k = String(v.dto_version);
    byVersion[k] = (byVersion[k] ?? 0) + 1;
  }
  return { snapTotal, snapStale, lines, targets, dtoVersions: JSON.stringify(byVersion) };
}

const stamp = Date.now();
const createdIds: string[] = [];

function body(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    line_name: `소요시간검증 ${stamp}`,
    hub: "info",
    line_type: "일반",
    line_code: `IFDU-${stamp}`,
    main_title_mode: "variable",
    organization_slug: "encre",
    estimated_duration_minutes: 60,
    ...over,
  });
}

type Dto = { id?: string; estimatedDurationMinutes?: unknown };
function dto(r: ApiResult): Dto {
  return ((r.json as { data?: Dto }).data ?? {}) as Dto;
}

async function main() {
  const cookie = await makeAdminCookieHeader();
  console.log("admin 세션 쿠키 확보 ✓");
  const applied = await columnExists();
  console.log(`마이그레이션 상태: ${applied ? "[POST] 적용됨" : "[PRE] 미적용"}\n`);

  const before = await fingerprint();
  console.log(`snapshot fingerprint(before): ${JSON.stringify(before)}\n`);

  // ── 0) DB 스키마 실물 확인 — 컬럼 + CHECK 제약이 실제로 존재하는가 ──
  if (applied) {
    console.log("=== 0) DB 스키마 (컬럼 + CHECK 제약) ===");
    check("estimated_duration_minutes 컬럼 존재", true, "columnExists() 통과");
    // CHECK 제약 실물 검증 — 허용 값은 통과하고 비허용 값만 23514 로 막히는지 경계까지 확인한다.
    //   (파서를 우회한 service_role 직접 write 라 DB 계층 단독 검증이 된다.)
    const probeCode = `IFDU-CK-${stamp}`;
    const { data: probe, error: probeErr } = await sb
      .from("line_registrations")
      .insert({
        line_name: `CHECK 제약 검증 ${stamp}`,
        hub: "info",
        line_type: "일반",
        line_code: probeCode,
        main_title_mode: "variable",
        main_title: "-",
        unit_link: "-",
        organization_slug: "encre",
        estimated_duration_minutes: 30,
      })
      .select("id")
      .single();
    check("허용 값(30) 직접 insert 통과", !probeErr && Boolean(probe), probeErr?.message);
    const probeId = (probe as { id?: string } | null)?.id ?? null;
    if (probeId) {
      createdIds.push(probeId);
      for (const bad of [45, 0, 180, -60, 121]) {
        const { error } = await sb
          .from("line_registrations")
          .update({ estimated_duration_minutes: bad })
          .eq("id", probeId);
        check(`CHECK: ${bad} 직접 update 거부(23514)`, error?.code === "23514", `code=${error?.code ?? "none"}`);
      }
      // NULL 은 허용되어야 한다(레거시 행 보존 정책).
      const { error: nullErr } = await sb
        .from("line_registrations")
        .update({ estimated_duration_minutes: null })
        .eq("id", probeId);
      check("CHECK: NULL 허용(레거시 보존 정책)", !nullErr, nullErr?.message);
    }
  }

  // ── A) 파서 검증 — 마이그레이션과 무관하게 항상 동일(DB 도달 전 차단) ──
  console.log("=== A) 서버 검증: 허용 값 외 거부 (클라 검증과 독립) ===");
  const missing = await api(cookie, "/api/admin/lines/registrations", {
    method: "POST",
    body: body({ estimated_duration_minutes: undefined, line_code: `IFDU-M${stamp}` }),
  });
  check("미선택(미전송) → 400", missing.status === 400, String(missing.json.error).slice(0, 80));

  for (const bad of [45, 0, 180, 1.5, -60, "60", null]) {
    const r = await api(cookie, "/api/admin/lines/registrations", {
      method: "POST",
      body: body({ estimated_duration_minutes: bad, line_code: `IFDU-B${stamp}` }),
    });
    check(`비허용 값 ${JSON.stringify(bad)} → 400`, r.status === 400, `status=${r.status}`);
  }

  // ── B) 조회 경로 — DTO 키는 마이그레이션 여부와 무관하게 항상 존재해야 한다 ──
  console.log("\n=== B) GET 목록 — DTO 키 존재 + 타입 ===");
  const list = await api(cookie, "/api/admin/lines/registrations?hub=info&limit=5");
  check("HTTP 200", list.status === 200, `status=${list.status}`);
  const rows = ((list.json as { data?: { rows?: Dto[] } }).data?.rows ?? []) as Dto[];
  check("행 존재", rows.length > 0, `rows=${rows.length}`);
  if (rows.length > 0) {
    check(
      "모든 행에 estimatedDurationMinutes 키 존재",
      rows.every((r) => "estimatedDurationMinutes" in r),
    );
    check(
      "값이 30|60|90|120|null 만",
      rows.every(
        (r) =>
          r.estimatedDurationMinutes === null ||
          [30, 60, 90, 120].includes(r.estimatedDurationMinutes as number),
      ),
      JSON.stringify(rows.map((r) => r.estimatedDurationMinutes)),
    );
    if (!applied) {
      check(
        "[PRE] 컬럼 부재 → 조회 degrade (전부 null, 500 아님)",
        rows.every((r) => r.estimatedDurationMinutes === null),
      );
    }
  }

  // ── C) 경로 동일성 — admin API 는 mode/actAs/demo 무분기여야 한다 ──
  console.log("\n=== C) 일반 / mode=test / actAsTestUserId / demoUserId 경로 동일성 ===");
  const variants = [
    ["일반", "/api/admin/lines/registrations?hub=info&limit=5"],
    ["mode=test", "/api/admin/lines/registrations?hub=info&limit=5&mode=test"],
    ["actAsTestUserId", "/api/admin/lines/registrations?hub=info&limit=5&actAsTestUserId=00000000-0000-0000-0000-000000000001"],
    ["demoUserId", "/api/admin/lines/registrations?hub=info&limit=5&demoUserId=00000000-0000-0000-0000-000000000002"],
  ] as const;
  const results: { label: string; status: number; sig: string }[] = [];
  for (const [label, path] of variants) {
    const r = await api(cookie, path);
    const rs = ((r.json as { data?: { rows?: Dto[] } }).data?.rows ?? []) as Dto[];
    results.push({
      label,
      status: r.status,
      // id → duration 시그니처. 키 이름·값·타입까지 동일해야 통과.
      sig: JSON.stringify(
        rs.map((x) => [x.id, x.estimatedDurationMinutes, typeof x.estimatedDurationMinutes]),
      ),
    });
  }
  const base = results[0];
  for (const r of results.slice(1)) {
    check(`${r.label}: HTTP status 동일 (${base.status})`, r.status === base.status, `got ${r.status}`);
    check(`${r.label}: DTO key/값/타입 동일`, r.sig === base.sig);
  }

  // ── D) 저장 경로 ──
  if (!applied) {
    console.log("\n=== D) [PRE] 컬럼 부재 시 필수값을 조용히 버리지 않는가 ===");
    const r = await api(cookie, "/api/admin/lines/registrations", {
      method: "POST",
      body: body({ line_code: `IFDU-P${stamp}` }),
    });
    check(
      "유효한 소요 시간 + 컬럼 부재 → 201 아님(무단 저장 금지)",
      r.status !== 201,
      `status=${r.status}`,
    );
    check(
      "마이그레이션 안내 메시지 노출",
      String(r.json.error ?? "").includes("estimated_duration_minutes"),
      String(r.json.error).slice(0, 120),
    );
    const { count } = await sb
      .from("line_registrations")
      .select("*", { count: "exact", head: true })
      .eq("line_code", `IFDU-P${stamp}`);
    check("DB 에 반쪽 행이 생기지 않음", count === 0, `count=${count}`);
  } else {
    console.log("\n=== D) [POST] 30/60/90/120 등록 + DB 실저장 ===");
    for (const m of [30, 60, 90, 120]) {
      const code = `IFDU-${m}-${stamp}`;
      const r = await api(cookie, "/api/admin/lines/registrations", {
        method: "POST",
        body: body({ estimated_duration_minutes: m, line_code: code }),
      });
      check(`${m}분 등록 → 201`, r.status === 201, `status=${r.status} ${String(r.json.error ?? "").slice(0, 80)}`);
      const id = dto(r).id;
      if (id) createdIds.push(id);
      check(`${m}분 응답 DTO = ${m}`, dto(r).estimatedDurationMinutes === m);
      const { data: row } = await sb
        .from("line_registrations")
        .select("estimated_duration_minutes")
        .eq("id", id ?? "00000000-0000-0000-0000-000000000000")
        .maybeSingle();
      check(`${m}분 DB 실저장 = ${m}`, row?.estimated_duration_minutes === m, JSON.stringify(row));

      // 등록 응답 DTO ↔ 재조회 DTO 동일성 (상세 + 목록 두 경로 모두).
      const g = await api(cookie, `/api/admin/lines/registrations/${id}`);
      check(`${m}분 재조회(상세) DTO = 등록 응답`, dto(g).estimatedDurationMinutes === m, `got=${dto(g).estimatedDurationMinutes}`);
      const gl = await api(cookie, "/api/admin/lines/registrations?hub=info&limit=200");
      const listed = (((gl.json as { data?: { rows?: Dto[] } }).data?.rows ?? []) as Dto[]).find(
        (x) => x.id === id,
      );
      check(
        `${m}분 재조회(목록) DTO = 등록 응답`,
        listed?.estimatedDurationMinutes === m,
        `got=${listed?.estimatedDurationMinutes}`,
      );
    }

    // DB CHECK 제약 자체 — 파서를 우회한 직접 write 도 막히는가
    console.log("\n=== E) [POST] DB CHECK 제약 (파서 우회 direct write) ===");
    const { error: ckErr } = await sb
      .from("line_registrations")
      .update({ estimated_duration_minutes: 45 })
      .eq("id", createdIds[0] ?? "00000000-0000-0000-0000-000000000000");
    check("service_role 직접 45 저장 → CHECK 위반 거부", ckErr?.code === "23514", `code=${ckErr?.code}`);

    // 기존 NULL 행 보존 + 수정으로 설정 가능
    console.log("\n=== F) [POST] 레거시 NULL 행 보존 + 수정 경로 ===");
    const { data: legacy } = await sb
      .from("line_registrations")
      .select("id,line_code,estimated_duration_minutes")
      .is("estimated_duration_minutes", null)
      .not("id", "in", `(${createdIds.join(",") || "00000000-0000-0000-0000-000000000000"})`)
      .limit(1);
    const legacyRow = legacy?.[0] ?? null;
    if (!legacyRow) {
      console.log("  (미설정 레거시 행 없음 — 보존/수정 검증 생략)");
    } else {
      const g = await api(cookie, `/api/admin/lines/registrations/${legacyRow.id}`);
      check("레거시 행 조회 200", g.status === 200);
      check("레거시 행 DTO = null (미설정 보존)", dto(g).estimatedDurationMinutes === null);

      const badPatch = await api(cookie, `/api/admin/lines/registrations/${legacyRow.id}`, {
        method: "PATCH",
        body: JSON.stringify({ estimated_duration_minutes: 45 }),
      });
      check("수정: 비허용 45 → 400", badPatch.status === 400, `status=${badPatch.status}`);

      const okPatch = await api(cookie, `/api/admin/lines/registrations/${legacyRow.id}`, {
        method: "PATCH",
        body: JSON.stringify({ estimated_duration_minutes: 90 }),
      });
      check("수정: 90 → 200", okPatch.status === 200, `status=${okPatch.status} ${String(okPatch.json.error ?? "").slice(0, 80)}`);
      const { data: after } = await sb
        .from("line_registrations")
        .select("estimated_duration_minutes")
        .eq("id", legacyRow.id)
        .maybeSingle();
      check("수정 후 DB = 90", after?.estimated_duration_minutes === 90);
      // 원상 복구 — 검증이 운영 데이터를 바꿔놓지 않게 한다.
      await sb
        .from("line_registrations")
        .update({ estimated_duration_minutes: null })
        .eq("id", legacyRow.id);
      console.log(`  · 레거시 행 ${legacyRow.line_code} 원상 복구(null) 완료`);
    }

    // org 동일성 — 등록 · 조회 · 수정을 2개 org 에서 동일하게 수행한다.
    console.log("\n=== G) [POST] 조직 동일성 (2개 org: 등록·조회·수정) ===");
    for (const org of ["encre", "oranke"]) {
      const code = `IFDU-${org}-${stamp}`;
      const r = await api(cookie, "/api/admin/lines/registrations", {
        method: "POST",
        body: body({ organization_slug: org, estimated_duration_minutes: 120, line_code: code }),
      });
      check(`org=${org} 등록 201`, r.status === 201, `status=${r.status} ${String(r.json.error ?? "").slice(0, 60)}`);
      check(`org=${org} 등록 DTO = 120`, dto(r).estimatedDurationMinutes === 120);
      const id = dto(r).id;
      if (id) createdIds.push(id);
      if (!id) continue;

      // 조회
      const g = await api(cookie, `/api/admin/lines/registrations/${id}`);
      check(`org=${org} 조회 DTO = 120`, dto(g).estimatedDurationMinutes === 120);

      // 수정 (120 → 30)
      const p = await api(cookie, `/api/admin/lines/registrations/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ estimated_duration_minutes: 30 }),
      });
      check(`org=${org} 수정 200`, p.status === 200, `status=${p.status} ${String(p.json.error ?? "").slice(0, 60)}`);
      const { data: after } = await sb
        .from("line_registrations")
        .select("estimated_duration_minutes")
        .eq("id", id)
        .maybeSingle();
      check(`org=${org} 수정 후 DB = 30`, after?.estimated_duration_minutes === 30, JSON.stringify(after));

      // 조직 스코프 목록에도 값이 실려야 한다.
      const gl = await api(cookie, `/api/admin/lines/registrations?hub=info&limit=200&organization=${org}`);
      const listed = (((gl.json as { data?: { rows?: Dto[] } }).data?.rows ?? []) as Dto[]).find(
        (x) => x.id === id,
      );
      check(`org=${org} 스코프 목록 DTO = 30`, listed?.estimatedDurationMinutes === 30, `got=${listed?.estimatedDurationMinutes}`);
    }
  }

  // ── I) 라인 마스터 목록 2곳 — registrations-first 경로 유지 + DTO 필드 ──
  //   핵심: 마이그 전(컬럼 부재)에도 레거시 마스터 fallback 으로 떨어지지 않아야 한다.
  //   fallback 이 발동하면 서버 로그에 "registrations 조회 실패 — 마스터 fallback" 이 찍힌다.
  console.log("\n=== I) 라인 마스터 목록 (practical-experience / practical-competency) ===");
  const masterEndpoints = [
    ["실무 경험 마스터", "/api/admin/cluster4/experience-line-masters", "experience", "cluster4_experience_line_masters"],
    ["실무 역량 마스터", "/api/admin/cluster4/competency-line-masters", "competency", "cluster4_competency_line_masters"],
  ] as const;
  // 주의: 이 두 엔드포인트는 { success, data: rows[] } 로 배열을 직접 내린다
  //   (라인 등록 목록의 { data: { rows, total } } 와 shape 이 다르다).
  const masterRows = (r: ApiResult): Dto[] => ((r.json as { data?: Dto[] }).data ?? []) as Dto[];
  for (const [label, path, hub, legacyTable] of masterEndpoints) {
    // 어느 경로가 실행됐는지 판정할 기준값 — bridged registrations 수 vs 레거시 마스터 총수.
    //   두 값이 다르므로 응답 행 수가 곧 "어느 SoT 를 읽었는가"의 증거가 된다.
    const { data: bridged } = await sb
      .from("line_registrations")
      .select("organization_slug")
      .eq("hub", hub)
      .not("bridged_master_id", "is", null);
    const bridgedCount = bridged?.length ?? 0;
    const { count: legacyCount } = await sb
      .from(legacyTable)
      .select("*", { count: "exact", head: true });

    const r = await api(cookie, path);
    check(`${label}: HTTP 200`, r.status === 200, `status=${r.status} ${String(r.json.error ?? "").slice(0, 80)}`);
    const rs = masterRows(r);
    check(`${label}: 행 존재`, rs.length > 0, `rows=${rs.length}`);
    // 핵심 회귀 가드: 소요 시간 컬럼 부재가 레거시 마스터 fallback 을 유발하면 안 된다.
    check(
      `${label}: registrations-first 경로 유지 (레거시 fallback 아님)`,
      rs.length === bridgedCount && bridgedCount !== legacyCount,
      `응답=${rs.length} · bridged registrations=${bridgedCount} · 레거시 마스터=${legacyCount}`,
    );
    if (rs.length > 0) {
      check(
        `${label}: 모든 행에 estimatedDurationMinutes 키 존재`,
        rs.every((x) => "estimatedDurationMinutes" in x),
      );
      check(
        `${label}: 값이 30|60|90|120|null 만`,
        rs.every(
          (x) =>
            x.estimatedDurationMinutes === null ||
            [30, 60, 90, 120].includes(x.estimatedDurationMinutes as number),
        ),
      );
    }
    // org 스코프 — 실제 데이터에 존재하는 org 로 검증한다.
    //   (역량은 전 행이 organization_slug='common' 이라 encre 하드코딩 시 0행 = 잘못된 실패.)
    const orgWithRows = (bridged ?? []).map((b) => String(b.organization_slug))[0] ?? null;
    if (!orgWithRows) {
      console.log(`  (${label}: org 스코프 검증 생략 — bridged 행 없음)`);
    } else {
      const rOrg = await api(cookie, `${path}?organization=${orgWithRows}`);
      check(`${label}: org=${orgWithRows} 스코프 200`, rOrg.status === 200, `status=${rOrg.status}`);
      const rsOrg = masterRows(rOrg);
      check(
        `${label}: org=${orgWithRows} 스코프도 동일 DTO 키`,
        rsOrg.length > 0 && rsOrg.every((x) => "estimatedDurationMinutes" in x),
        `rows=${rsOrg.length}`,
      );
    }
  }

  // ── H) snapshot 무영향 ──
  console.log("\n=== H) snapshot / 기존 4허브 SoT 무영향 ===");
  const after = await fingerprint();
  check("weekly_card_snapshots 행 수 불변", after.snapTotal === before.snapTotal, `${before.snapTotal} → ${after.snapTotal}`);
  check("is_stale 수 불변", after.snapStale === before.snapStale, `${before.snapStale} → ${after.snapStale}`);
  check("cluster4_lines 행 수 불변", after.lines === before.lines);
  check("cluster4_line_targets 행 수 불변", after.targets === before.targets);
  // DTO 버전 분포 불변 = 컬럼 추가가 bump/재계산을 유발하지 않았다는 증거.
  check(
    "snapshot dto_version 분포 불변 (bump 없음)",
    after.dtoVersions === before.dtoVersions,
    `${before.dtoVersions} → ${after.dtoVersions}`,
  );

  // ── 정리 ──
  if (createdIds.length > 0) {
    await sb.from("line_registrations").delete().in("id", createdIds);
    console.log(`\n· 검증용 등록 ${createdIds.length}건 정리 완료`);
  }

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

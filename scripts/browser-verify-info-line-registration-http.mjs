// 실무 정보 = 고정 9종 제품 계약 — 실제 HTTP 검증(dev :3000, owner 세션).
//
//   [A] 9종 모두 등록된 조직 범위(common)에 신규 등록 → 409 (신규 activity type 없음)
//   [B] 미등록 슬롯이 있는 범위(encre)에 정상 등록 → 201, 탭 수는 그대로 9개
//   [C] 이미 등록된 활동유형 재등록(서버 직접 호출) → 409
//   [D] 활동유형 미선택 → 422 INFO_ACTIVITY_TYPE_REQUIRED, registration 행 생성 없음
//   [E] 경험/역량 자동 bridge 비회귀(등록 즉시 master 연결 · 목록/저장 FK 일치)
//   [F] 일반/mode=test/actAsTestUserId/demoUserId 동일 DTO · practical-info == weeks ID 집합
//   [G] 신규 activity_types 생성 0 · 기존 9종/개설/snapshot 비회귀
//
//   Usage: node scripts/browser-verify-info-line-registration-http.mjs
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();

const BASE = "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE);
const brow = createClient(URL_, ANON);
const OWNER_EMAIL = "vanuatu.golden@gmail.com";
const ORGS = ["encre", "oranke", "phalanx"];
const NINE = [
  "wisdom", "essay", "infodesk", "calendar", "forum",
  "session", "practical_lecture", "community", "etc_a",
];

let fail = 0;
const ck = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

async function cookieHeader(email) {
  const { data: link, error } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw new Error(`generateLink: ${error.message}`);
  const { data: v, error: e2 } = await brow.auth.verifyOtp({
    email,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  if (e2) throw new Error(`verifyOtp: ${e2.message}`);
  const cap = [];
  const srv = createServerClient(URL_, ANON, {
    cookies: { getAll: () => [], setAll: (i) => cap.push(...i) },
  });
  await srv.auth.setSession({
    access_token: v.session.access_token,
    refresh_token: v.session.refresh_token,
  });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

let COOKIE = "";
const api = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { cookie: COOKIE, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-json */
  }
  return { status: res.status, json };
};

const STAMP = String(Date.now()).slice(-6);

const infoTabIds = async (org) => {
  const { json } = await api(
    `/api/admin/cluster4/activity-types?cluster=practical_info${org ? `&organization=${org}` : ""}`,
  );
  return (json?.data ?? []).map((t) => t.id);
};

const activityTypeCount = async () => {
  const { count } = await sb
    .from("activity_types")
    .select("*", { count: "exact", head: true })
    .eq("cluster_id", "practical_info");
  return count ?? 0;
};

const infoRegCount = async () => {
  const { count } = await sb
    .from("line_registrations")
    .select("*", { count: "exact", head: true })
    .eq("hub", "info");
  return count ?? 0;
};

const infoPayload = (over = {}) => ({
  line_name: `HTTP검증 정보라인 ${STAMP}`,
  hub: "info",
  line_type: "일반",
  line_code: `IFHT-XX${STAMP}`,
  main_title_mode: "variable",
  main_title: null,
  unit_link: null,
  estimated_duration_minutes: 30,
  organization_slug: "common",
  point_a: 3,
  point_b: 2,
  ...over,
});

async function main() {
  COOKIE = await cookieHeader(OWNER_EMAIL);
  const createdRegistrations = [];

  try {
    // ── [0] 기준선 ─────────────────────────────────────────────────────────
    console.log("\n[0] 기준선");
    const atBefore = await activityTypeCount();
    const regBefore = await infoRegCount();
    ck("activity_types(practical_info) 9행", atBefore === 9, `${atBefore}`);
    for (const org of ORGS) {
      const ids = await infoTabIds(org);
      ck(`${org} 탭 9개`, ids.length === 9, ids.join(","));
      ck(`${org} 순서 정본`, JSON.stringify(ids) === JSON.stringify(NINE));
    }

    // ── [D] 활동유형 미선택 → 422 ──────────────────────────────────────────
    console.log("\n[D] 활동유형 미선택 → 422 · 행 생성 없음");
    const noType = await api("/api/admin/lines/registrations", {
      method: "POST",
      body: JSON.stringify(infoPayload({ line_code: `IFHT-D${STAMP}` })),
    });
    ck("422", noType.status === 422, `status=${noType.status}`);
    ck("code=INFO_ACTIVITY_TYPE_REQUIRED", noType.json?.code === "INFO_ACTIVITY_TYPE_REQUIRED", String(noType.json?.code));
    ck(
      "문구",
      noType.json?.error === "실무 정보 라인은 기존 9개 활동유형 중 하나를 선택해야 합니다.",
      String(noType.json?.error),
    );
    ck("registration 행 생성 없음", (await infoRegCount()) === regBefore, `${await infoRegCount()} vs ${regBefore}`);

    const badType = await api("/api/admin/lines/registrations", {
      method: "POST",
      body: JSON.stringify(
        infoPayload({ line_code: `IFHT-D2${STAMP}`, point_activity_type_id: "info_made_up" }),
      ),
    });
    ck("9종 외 값도 422", badType.status === 422 && badType.json?.code === "INFO_ACTIVITY_TYPE_REQUIRED", `status=${badType.status}`);
    ck("행 생성 없음", (await infoRegCount()) === regBefore);

    // ── [A] 9종 모두 등록된 범위(common) → 409 ─────────────────────────────
    console.log("\n[A] 9종 모두 등록된 범위(common) 신규 등록 차단");
    const allTaken = await api("/api/admin/lines/registrations", {
      method: "POST",
      body: JSON.stringify(
        infoPayload({ line_code: `IFHT-A${STAMP}`, point_activity_type_id: "wisdom" }),
      ),
    });
    ck("409", allTaken.status === 409, `status=${allTaken.status}`);
    ck(
      "code=INFO_ACTIVITY_TYPE_ALREADY_REGISTERED",
      allTaken.json?.code === "INFO_ACTIVITY_TYPE_ALREADY_REGISTERED",
      String(allTaken.json?.code),
    );
    ck(
      "문구",
      allTaken.json?.error === "선택한 활동유형에는 이미 정식 라인이 등록되어 있습니다. 기존 라인을 수정해주세요.",
      String(allTaken.json?.error),
    );
    ck("행 생성 없음", (await infoRegCount()) === regBefore);

    // ── [B] 미등록 슬롯 있는 범위(encre) 정상 등록 → 201, 탭은 9개 ─────────
    console.log("\n[B] 미등록 슬롯 정상 등록");
    const ok = await api("/api/admin/lines/registrations", {
      method: "POST",
      body: JSON.stringify(
        infoPayload({
          line_name: `HTTP검증 앙크르 위즈덤 ${STAMP}`,
          line_code: `IFHT-B${STAMP}`,
          organization_slug: "encre",
          point_activity_type_id: "wisdom",
        }),
      ),
    });
    ck("201", ok.status === 201, `status=${ok.status} ${JSON.stringify(ok.json?.error ?? "")}`);
    if (ok.json?.data?.id) createdRegistrations.push(ok.json.data.id);
    ck("pointActivityTypeId = wisdom(정본)", ok.json?.data?.pointActivityTypeId === "wisdom", String(ok.json?.data?.pointActivityTypeId));
    ck("bridge.linked=false · reason 없음(해당 없음)", ok.json?.bridge?.linked === false && !ok.json?.bridge?.reason, JSON.stringify(ok.json?.bridge));
    ck("pointConfig.saved=true · key=wisdom", ok.json?.pointConfig?.saved === true && ok.json?.pointConfig?.configKey === "wisdom", JSON.stringify(ok.json?.pointConfig));

    ck("activity_types 여전히 9행", (await activityTypeCount()) === 9);
    for (const org of ORGS) {
      const ids = await infoTabIds(org);
      ck(`${org} 탭 여전히 9개`, ids.length === 9, `${ids.length}`);
    }
    const { json: encreTabs } = await api(
      "/api/admin/cluster4/activity-types?cluster=practical_info&organization=encre",
    );
    const wisdomTab = (encreTabs?.data ?? []).find((t) => t.id === "wisdom");
    ck("encre wisdom 탭 표시명 = 정본 '위즈덤'", wisdomTab?.name === "위즈덤", wisdomTab?.name);
    ck("encre wisdom registeredLineName = 신규 등록명", wisdomTab?.registeredLineName === `HTTP검증 앙크르 위즈덤 ${STAMP}`, wisdomTab?.registeredLineName);
    ck("encre wisdom registeredLineCode = 신규 코드", wisdomTab?.registeredLineCode === `IFHT-B${STAMP}`, wisdomTab?.registeredLineCode);
    const { json: orankeTabs } = await api(
      "/api/admin/cluster4/activity-types?cluster=practical_info&organization=oranke",
    );
    const wisdomOranke = (orankeTabs?.data ?? []).find((t) => t.id === "wisdom");
    ck("oranke 는 common 등록 유지(누수 없음)", wisdomOranke?.registeredLineCode === "IFBS-NN0001", wisdomOranke?.registeredLineCode);

    // ── [C] 같은 범위 같은 활동유형 재등록 → 409 (서버 직접 호출) ──────────
    console.log("\n[C] 같은 조직 범위 중복 등록 차단");
    const dup = await api("/api/admin/lines/registrations", {
      method: "POST",
      body: JSON.stringify(
        infoPayload({
          line_code: `IFHT-C${STAMP}`,
          organization_slug: "encre",
          point_activity_type_id: "wisdom",
        }),
      ),
    });
    ck("409", dup.status === 409, `status=${dup.status}`);
    ck("code", dup.json?.code === "INFO_ACTIVITY_TYPE_ALREADY_REGISTERED", String(dup.json?.code));

    // PATCH 경로도 같은 규칙 — 다른 등록을 encre/wisdom 으로 옮기려 하면 409.
    const patchDup = await api(
      `/api/admin/lines/registrations/${createdRegistrations[0]}`,
      { method: "PATCH", body: JSON.stringify({ point_activity_type_id: "" }) },
    );
    ck("PATCH 활동유형 해제 시도 → 4xx", patchDup.status >= 400 && patchDup.status < 500, `status=${patchDup.status} ${JSON.stringify(patchDup.json?.error ?? "")}`);

    // ── [B-2] 주차/개설 화면도 9개 유지 ────────────────────────────────────
    console.log("\n[B-2] weeks · 개설 관리 목록 9개 유지");
    const weeks = await api("/api/admin/team-parts/info/weeks?club=encre&page=1&pageSize=1");
    const weekId = weeks.json?.data?.items?.[0]?.weekId;
    const detail = await api(`/api/admin/team-parts/info/weeks/${weekId}?club=encre`);
    const weekLines = detail.json?.data?.openingConfig?.lineOpening?.practicalInfo ?? [];
    ck("주차 상세 정보 라인 9개", weekLines.length === 9, `${weekLines.length}`);
    ck("주차 상세 ID 집합 = 정본 9종", JSON.stringify(weekLines.map((l) => l.lineId)) === JSON.stringify(NINE));
    const mgmt = await api(
      `/api/admin/team-parts/info/weeks/${weekId}/line-opening-management?club=encre`,
    );
    const mgmtLines = mgmt.json?.data?.practicalInfo?.lines ?? [];
    ck("라인 개설 관리 9개", mgmtLines.length === 9, `${mgmtLines.length}`);
    const openStatus = await api(
      `/api/admin/cluster4/info-line-open-status?week_id=${weekId}&organization=encre`,
    );
    ck("오픈 상태 맵 키 9개", Object.keys(openStatus.json?.data?.openByActivityType ?? {}).length === 9);

    // ── [E] 경험/역량 자동 bridge 비회귀 ───────────────────────────────────
    console.log("\n[E] 경험·역량 자동 bridge 비회귀");
    for (const [hub, lineType, code] of [
      ["experience", "도출", `EXHT-B${STAMP}`],
      ["competency", "원리", `CPHT-B${STAMP}`],
    ]) {
      const res = await api("/api/admin/lines/registrations", {
        method: "POST",
        body: JSON.stringify({
          line_name: `HTTP검증 ${hub} ${STAMP}`,
          hub,
          line_type: lineType,
          line_code: code,
          main_title_mode: "fixed",
          main_title: `검증 ${STAMP}`,
          unit_link: null,
          estimated_duration_minutes: 30,
          organization_slug: "encre",
        }),
      });
      ck(`${hub} 201`, res.status === 201, `status=${res.status} ${JSON.stringify(res.json?.error ?? "")}`);
      if (res.json?.data?.id) createdRegistrations.push(res.json.data.id);
      ck(`${hub} bridge.linked=true`, res.json?.bridge?.linked === true, JSON.stringify(res.json?.bridge));
      const masterId = res.json?.data?.bridgedMasterId;
      ck(`${hub} bridged_master_id 기록`, Boolean(masterId), String(masterId));
      ck(`${hub} bridged_at 기록`, Boolean(res.json?.data?.bridgedAt));
      const table =
        hub === "experience"
          ? "cluster4_experience_line_masters"
          : "cluster4_competency_line_masters";
      const { data: master } = await sb.from(table).select("id,line_code,organization_slug").eq("id", masterId).maybeSingle();
      ck(`${hub} master 실재 · 코드/조직 일치`, master?.line_code === code && master?.organization_slug === "encre", JSON.stringify(master));
      // 개설 목록(드롭다운)에 master UUID 그대로 노출 = 저장 FK 일치.
      const listPath =
        hub === "experience"
          ? "/api/admin/cluster4/experience-line-masters?organization=encre"
          : "/api/admin/cluster4/competency-line-masters?organization=encre";
      const list = await api(listPath);
      const rows = list.json?.data?.rows ?? list.json?.data ?? [];
      ck(
        `${hub} 개설 목록에 동일 master UUID 노출`,
        Array.isArray(rows) && rows.some((r) => r.id === masterId),
        `rows=${Array.isArray(rows) ? rows.length : "n/a"}`,
      );
      const { count: dupMasters } = await sb
        .from(table)
        .select("*", { count: "exact", head: true })
        .eq("organization_slug", "encre")
        .eq("line_code", code);
      ck(`${hub} master 중복 없음`, dupMasters === 1, `${dupMasters}`);
    }

    // ── [F] 모드 동등성 ────────────────────────────────────────────────────
    console.log("\n[F] 일반 / test / actAs / demo 동등성");
    const base = await infoTabIds("encre");
    for (const q of ["mode=test", "actAsTestUserId=1", "demoUserId=1"]) {
      const { json } = await api(
        `/api/admin/cluster4/activity-types?cluster=practical_info&organization=encre&${q}`,
      );
      const ids = (json?.data ?? []).map((t) => t.id);
      ck(`practical-info 동일 (${q})`, JSON.stringify(ids) === JSON.stringify(base));
      const d = await api(`/api/admin/team-parts/info/weeks/${weekId}?club=encre&${q}`);
      const wIds = (d.json?.data?.openingConfig?.lineOpening?.practicalInfo ?? []).map((l) => l.lineId);
      ck(`weeks 동일 (${q})`, JSON.stringify(wIds) === JSON.stringify(base));
    }
    ck("practical-info == weeks ID 집합", JSON.stringify(base) === JSON.stringify(weekLines.map((l) => l.lineId)));
    // 등록 검증 규칙도 모드 무관 — 테스트 모드 전용 예외 없음.
    for (const q of ["mode=test", "actAsTestUserId=1", "demoUserId=1"]) {
      const r = await api(`/api/admin/lines/registrations?${q}`, {
        method: "POST",
        body: JSON.stringify(infoPayload({ line_code: `IFHT-F${STAMP}` })),
      });
      ck(`활동유형 미선택 → 422 (${q})`, r.status === 422 && r.json?.code === "INFO_ACTIVITY_TYPE_REQUIRED", `status=${r.status}`);
    }

    // ── [G] 비회귀 ────────────────────────────────────────────────────────
    console.log("\n[G] 비회귀");
    ck("activity_types 생성 0(9행 유지)", (await activityTypeCount()) === atBefore, `${await activityTypeCount()} vs ${atBefore}`);
    const { data: infoLineTypes } = await sb
      .from("cluster4_lines")
      .select("activity_type_id")
      .eq("part_type", "info");
    const foreign = (infoLineTypes ?? [])
      .map((l) => l.activity_type_id)
      .filter((id) => id && !NINE.includes(id));
    ck("9종 외 activity_type 개설 라인 0건", foreign.length === 0, foreign.join(","));
    const { count: legacyLines } = await sb
      .from("cluster4_lines")
      .select("*", { count: "exact", head: true })
      .eq("part_type", "info")
      .in("activity_type_id", NINE);
    ck("기존 info 개설 라인 보존", (legacyLines ?? 0) > 0, `${legacyLines}건`);
  } catch (e) {
    console.error(e);
    fail++;
  } finally {
    console.log("\n[정리] 검증 데이터 삭제");
    for (const id of createdRegistrations) {
      const { data: reg } = await sb
        .from("line_registrations")
        .select("hub,line_code,bridged_master_id,organization_slug,point_activity_type_id")
        .eq("id", id)
        .maybeSingle();
      await sb.from("line_registrations").delete().eq("id", id);
      if (reg?.bridged_master_id) {
        const table =
          reg.hub === "experience"
            ? "cluster4_experience_line_masters"
            : "cluster4_competency_line_masters";
        await sb.from(table).delete().eq("id", reg.bridged_master_id);
      }
      // 포인트 config_key 는 허브마다 다르다 — info=활동유형 id, competency=line_code,
      //   experience=카테고리 enum(공용이라 지우지 않는다).
      if (reg?.hub === "info" && reg.point_activity_type_id && reg.organization_slug) {
        await sb
          .from("cluster4_line_point_configs")
          .delete()
          .eq("hub", "info")
          .eq("organization_slug", reg.organization_slug)
          .eq("config_key", reg.point_activity_type_id);
      } else if (reg?.hub === "competency" && reg.line_code) {
        await sb
          .from("cluster4_line_point_configs")
          .delete()
          .eq("hub", "competency")
          .eq("config_key", reg.line_code);
      }
    }
    ck("정리 후 activity_types 9행", (await activityTypeCount()) === 9);
    for (const org of ORGS) {
      const ids = await infoTabIds(org);
      ck(`${org} 정리 후 탭 9개`, ids.length === 9);
    }
  }

  console.log(fail === 0 ? "\n✅ ALL PASS" : `\n❌ ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

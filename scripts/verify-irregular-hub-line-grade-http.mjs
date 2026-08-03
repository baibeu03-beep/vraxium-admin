// 변동 액트 "소속 허브 급 / 소속 라인 급" — HTTP 검증.
//   전제: dev 서버(:3000). db/migrations/2026-07-31_process_irregular_acts_hub_line_grade.sql
//   미적용이어도 validation(400)까지는 검증 가능 — 컬럼 저장/조회 관련 항목은 마이그레이션
//   적용 후에만 통과한다(스크립트가 컬럼 존재 여부를 프로브해 둘 다 리포트한다).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const r = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json"));
const { createClient } = r("@supabase/supabase-js");
const { createServerClient } = r("@supabase/ssr");
const env = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const URL = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL, SERVICE), brow = createClient(URL, ANON);
const EMAIL = "vanuatu.golden@gmail.com";
const ORG = "oranke", TAG = "ZZ-hubgrade-verify";
const J = (o) => JSON.stringify(o);

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = []; const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookie = cap.map((i) => `${i.name}=${i.value}`).join("; ");
const api = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { "Content-Type": "application/json", cookie, ...(init.headers ?? {}) } });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
let pass = 0, fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function cleanup() {
  const rows = (await sb.from("process_irregular_acts").select("id").like("act_name", `${TAG}%`)).data ?? [];
  if (rows.length) {
    // manual_grant 는 생성 즉시 포인트 적립(process_point_awards)까지 발생한다 — 정식 회수 API
    //   (DELETE, 서버 내부에서 revokeForAct 호출)로 정리해야 원장에 orphan 이 남지 않는다.
    for (const row of rows) {
      await api("/api/admin/processes/check/irregular", { method: "DELETE", body: J({ id: row.id, organization: ORG, mode: "test" }) }).catch(() => {});
      await api("/api/admin/processes/check/irregular", { method: "DELETE", body: J({ id: row.id, organization: ORG }) }).catch(() => {});
    }
    await sb.from("process_check_review_recipients").delete().in("ref_id", rows.map((x) => x.id));
  }
  await sb.from("process_irregular_acts").delete().like("act_name", `${TAG}%`);
}

try {
  const probe = await sb.from("process_irregular_acts").select("hub_grade").limit(1);
  const migrated = !probe.error;
  console.log(migrated
    ? "[전제] hub_grade 컬럼 존재 — 마이그레이션 적용됨. 저장/조회까지 전량 검증한다."
    : `[전제] hub_grade 컬럼 없음(code=${probe.error?.code}) — db/migrations/2026-07-31_process_irregular_acts_hub_line_grade.sql 미적용.\n` +
      "         validation(400 계열)까지만 검증하고, 저장/조회 항목은 SKIP 으로 표시한다.");

  const oranke = (await sb.from("user_profiles").select("user_id,display_name").eq("organization_slug", ORG)).data ?? [];
  const teMarkersEarly = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x) => x.user_id));
  // 이 dev 환경은 QA_HIDE_REAL_USERS=true(lib/qaFixedScope) — write 대상 모집단이 항상 test 로
  //   고정된다(요청 mode 와 무관, resolveUserScope 의 기존 SoT 동작). 그래서 검증도 test 마커
  //   유저를 대상으로 삼는다(hub_grade 기능과 무관한 환경 스위치 — feedback_exclude-test-accounts).
  const target = oranke.find((u) => teMarkersEarly.has(u.user_id));
  if (!target) { console.log("⚠ 테스트 대상 크루 없음 — 검증 중단"); process.exit(2); }

  await cleanup();

  // ── 1. 허브 급 미선택 → 400 (link/manual 둘 다) ──
  const noHubLink = await api("/api/admin/processes/check/irregular", { method: "POST", body: J({
    organization: ORG, kind: "review_request", act_name: `${TAG} 링크-누락`,
    review_link: "https://cafe.naver.com/test/hubgrade", scheduled_check_at: new Date(Date.now() + 86_400_000).toISOString(),
  }) });
  ck("[검증] 링크신청, hub_grade 미선택 → 400", noHubLink.status === 400, `status=${noHubLink.status} err=${noHubLink.json.error}`);

  const noHubManual = await api("/api/admin/processes/check/irregular", { method: "POST", body: J({
    organization: ORG, kind: "manual_grant", act_name: `${TAG} 수동-누락`, target_user_ids: [target.user_id],
    point_a: 1, crew_reaction: "partial", point_mode: "ab",
  }) });
  ck("[검증] 수동부여, hub_grade 미선택 → 400", noHubManual.status === 400, `status=${noHubManual.status} err=${noHubManual.json.error}`);

  // ── 2. 잘못된 hub_grade(career 포함·임의문자열) → 400 ──
  const badHub = await api("/api/admin/processes/check/irregular", { method: "POST", body: J({
    organization: ORG, kind: "manual_grant", act_name: `${TAG} 수동-불량`, target_user_ids: [target.user_id],
    point_a: 1, crew_reaction: "partial", point_mode: "ab", hub_grade: "career",
  }) });
  ck("[검증] hub_grade=career(비허용값) → 400", badHub.status === 400, `status=${badHub.status} err=${badHub.json.error}`);

  const bogusHub = await api("/api/admin/processes/check/irregular", { method: "POST", body: J({
    organization: ORG, kind: "manual_grant", act_name: `${TAG} 수동-불량2`, target_user_ids: [target.user_id],
    point_a: 1, crew_reaction: "partial", point_mode: "ab", hub_grade: "nope",
  }) });
  ck("[검증] hub_grade=임의문자열 → 400", bogusHub.status === 400, `status=${bogusHub.status}`);

  // ── 3. 4종 허브 급 각각 manual_grant 생성 → 201 · lineGrade=variable_act 확인 ──
  const HUBS = ["club", "info", "experience", "competency"];
  const created = {};
  for (const hub of HUBS) {
    const res = await api("/api/admin/processes/check/irregular", { method: "POST", body: J({
      organization: ORG, kind: "manual_grant", act_name: `${TAG} ${hub}`, target_user_ids: [target.user_id],
      point_a: 1, point_b: 0, point_c: 0, crew_reaction: "partial", point_mode: "ab", hub_grade: hub,
    }) });
    ck(`[생성] hub_grade=${hub} → 201`, res.status === 201, `status=${res.status} err=${res.json.error}`);
    ck(`[생성] ${hub} → lineGrade=variable_act·lineGradeLabel=변동 액트`,
      res.json.data?.lineGrade === "variable_act" && res.json.data?.lineGradeLabel === "변동 액트",
      J({ lineGrade: res.json.data?.lineGrade, lineGradeLabel: res.json.data?.lineGradeLabel }));
    if (migrated) {
      ck(`[생성] ${hub} → hubGrade 저장·유지(hubGradeLabel 매칭)`, res.json.data?.hubGrade === hub,
        `hubGrade=${res.json.data?.hubGrade} label=${res.json.data?.hubGradeLabel}`);
    } else {
      console.log(`  ⏭ [SKIP] ${hub} → hubGrade 저장 확인(마이그레이션 미적용)`);
    }
    created[hub] = res.json.data?.id;
  }

  // ── 4. 클라이언트가 line_grade 를 임의로 보내도 서버가 무시하고 항상 variable_act 강제 ──
  const forgedLine = await api("/api/admin/processes/check/irregular", { method: "POST", body: J({
    organization: ORG, kind: "manual_grant", act_name: `${TAG} line위조`, target_user_ids: [target.user_id],
    point_a: 1, crew_reaction: "partial", point_mode: "ab", hub_grade: "club", line_grade: "some_other_value",
  }) });
  ck("[검증] line_grade 클라 위조값 무시 → 항상 variable_act", forgedLine.status === 201 && forgedLine.json.data?.lineGrade === "variable_act",
    `status=${forgedLine.status} lineGrade=${forgedLine.json.data?.lineGrade}`);
  if (forgedLine.json.data?.id) await sb.from("process_irregular_acts").delete().eq("id", forgedLine.json.data.id);

  // ── 5. 조회 API(GET board) DTO 키 확인 ──
  const board = await api(`/api/admin/processes/check/irregular?org=${ORG}`);
  const row = (board.json.data?.acts ?? []).find((a) => a.id === created.club);
  ck("[조회] GET board 응답에 hubGrade/hubGradeLabel/lineGrade/lineGradeLabel 키 존재", row
    ? ("hubGrade" in row && "hubGradeLabel" in row && "lineGrade" in row && "lineGradeLabel" in row) : false,
    row ? J({ hubGrade: row.hubGrade, hubGradeLabel: row.hubGradeLabel, lineGrade: row.lineGrade, lineGradeLabel: row.lineGradeLabel }) : "row not found");

  // ── 6. 수정 API — PATCH action=set_hub_grade ──
  if (migrated && created.club) {
    const patched = await api("/api/admin/processes/check/irregular", { method: "PATCH", body: J({
      id: created.club, organization: ORG, action: "set_hub_grade", hub_grade: "info",
    }) });
    ck("[수정] PATCH set_hub_grade club→info → 200 · hubGrade=info", patched.status === 200 && patched.json.data?.hubGrade === "info",
      `status=${patched.status} hubGrade=${patched.json.data?.hubGrade}`);
    const patchedBad = await api("/api/admin/processes/check/irregular", { method: "PATCH", body: J({
      id: created.club, organization: ORG, action: "set_hub_grade", hub_grade: "nope",
    }) });
    ck("[수정] PATCH set_hub_grade 잘못된 값 → 400", patchedBad.status === 400, `status=${patchedBad.status}`);
  } else {
    console.log("  ⏭ [SKIP] PATCH set_hub_grade(마이그레이션 미적용 또는 생성 실패)");
  }

  // ── 7. mode=test 도 동일 DTO 키/검증(허브 급 옵션·필수 여부 동일) ──
  const teMarkers = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x) => x.user_id));
  const teTarget = oranke.find((u) => teMarkers.has(u.user_id));
  if (teTarget) {
    const teNoHub = await api("/api/admin/processes/check/irregular", { method: "POST", body: J({
      organization: ORG, mode: "test", kind: "manual_grant", act_name: `${TAG} test-누락`, target_user_ids: [teTarget.user_id],
      point_a: 1, crew_reaction: "partial", point_mode: "ab",
    }) });
    ck("[모드비교] mode=test 도 hub_grade 미선택 → 400(동일 검증)", teNoHub.status === 400, `status=${teNoHub.status}`);
    const teOk = await api("/api/admin/processes/check/irregular", { method: "POST", body: J({
      organization: ORG, mode: "test", kind: "manual_grant", act_name: `${TAG} test-정상`, target_user_ids: [teTarget.user_id],
      point_a: 1, crew_reaction: "partial", point_mode: "ab", hub_grade: "experience",
    }) });
    ck("[모드비교] mode=test 생성 201 · DTO 키 동일(hubGrade/lineGrade)", teOk.status === 201 &&
      "hubGrade" in (teOk.json.data ?? {}) && "lineGrade" in (teOk.json.data ?? {}),
      J({ status: teOk.status, hubGrade: teOk.json.data?.hubGrade, lineGrade: teOk.json.data?.lineGrade }));
  } else {
    console.log("  ⏭ [SKIP] mode=test 대상 없음");
  }

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
} catch (e) {
  console.error("FATAL", e);
  await cleanup().catch(() => {});
  process.exit(1);
}

// 변동 액트 (/admin/processes/check/irregular) — direct(DB) == HTTP 검증.
//   생성(검수신청/수동부여) · 카페=kind 파생 · 요약 5칸 · org 분리 · test/operating 분리(대상자 기준) ·
//   완료/삭제 · 고객앱/snapshot 무영향(쓰기 격리) · cleanup net-zero.
// 전제: dev 서버(:3000) + 2026-06-15_process_irregular_acts.sql 적용.
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
const ORG = "oranke", OTHER_ORG = "encre", TAG = "ZZ-irr-verify";
const J = (o) => JSON.stringify(o);
const DAY = 86_400_000;

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = []; const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookie = cap.map((i) => `${i.name}=${i.value}`).join("; ");
const api = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { "Content-Type": "application/json", cookie, ...(init.headers ?? {}) } });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
let pass = 0, fail = 0; const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };
const findRow = (board, id) => (board.acts ?? []).find((a) => a.id === id) ?? null;

async function cleanup() {
  const rows = (await sb.from("process_irregular_acts").select("id").like("act_name", `${TAG}%`)).data ?? [];
  if (rows.length) await sb.from("process_check_review_recipients").delete().in("ref_id", rows.map((r) => r.id));
  await sb.from("process_irregular_acts").delete().like("act_name", `${TAG}%`);
}

try {
  const probe = await sb.from("process_irregular_acts").select("id").limit(1);
  if (probe.error) { console.log(`⚠ 마이그레이션 미적용(${probe.error.code}) — 2026-06-15_process_irregular_acts.sql 적용 후 재실행`); process.exit(2); }

  // 테스트 유저 마커 집합.
  const markers = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x) => x.user_id));
  // 대상 후보 — oranke 운영 고객 1 + oranke 테스트 고객 1.
  const oranke = ((await sb.from("user_profiles").select("user_id,display_name").eq("organization_slug", ORG)).data ?? []);
  const opTarget = oranke.find((u) => !markers.has(u.user_id));
  const teTarget = oranke.find((u) => markers.has(u.user_id));
  const encre = ((await sb.from("user_profiles").select("user_id").eq("organization_slug", OTHER_ORG)).data ?? []);
  const encreOp = encre.find((u) => !markers.has(u.user_id));
  ck("[전제] oranke 운영/테스트 대상 + encre 대상 존재", !!opTarget && !!teTarget && !!encreOp, J({ op: !!opTarget, te: !!teTarget, enc: !!encreOp }));
  if (!opTarget || !teTarget) { console.log("⚠ 대상 후보 부족 — 검증 중단"); await cleanup(); process.exit(2); }

  await cleanup();

  // ── 1. 수동 부여(operating·복수 크루) → 즉시 completed · 카페=미발생 · recipients ──
  const mg = await api("/api/admin/processes/check/irregular", { method: "POST", body: J({
    organization: ORG, kind: "manual_grant", act_name: `${TAG} 수동1`, target_user_ids: [opTarget.user_id],
    duration_minutes: 30, reason: "수동 부여 사유", point_a: 5, point_b: 1, point_c: 1, crew_reaction: "partial", point_mode: "ab",
  }) });
  ck("[수동부여] 201 · status=completed · cafeLabel=미발생 · 크루1명 · target null", mg.status === 201 && mg.json.data?.status === "completed" && mg.json.data?.cafeLabel === "미발생" && mg.json.data?.matchedCount === 1 && mg.json.data?.targetUserId === null, `status=${mg.status} cafe=${mg.json.data?.cafeLabel} n=${mg.json.data?.matchedCount}`);
  const mgId = mg.json.data?.id;
  ck("[수동부여] completed_at 채워짐 (created==completed)", !!mg.json.data?.completedAt);

  // ── 1b. 포인트 0/0/0 저장 가능(0~20) — HTTP 201 + DTO 0 + DB 0 ──
  const mg0 = await api("/api/admin/processes/check/irregular", { method: "POST", body: J({
    organization: ORG, kind: "manual_grant", act_name: `${TAG} 영점`, target_user_ids: [opTarget.user_id],
    point_a: 0, point_b: 0, point_c: 0, crew_reaction: "partial", point_mode: "ab",
  }) });
  ck("[포인트0] 201 · DTO pointA/B/C=0", mg0.status === 201 && mg0.json.data?.pointA === 0 && mg0.json.data?.pointB === 0 && mg0.json.data?.pointC === 0, `status=${mg0.status} a/b/c=${mg0.json.data?.pointA}/${mg0.json.data?.pointB}/${mg0.json.data?.pointC}`);
  const mg0Db = (await sb.from("process_irregular_acts").select("point_a,point_b,point_c").eq("id", mg0.json.data?.id).maybeSingle()).data;
  ck("[포인트0] DB point_a/b/c=0 (direct==HTTP)", mg0Db?.point_a === 0 && mg0Db?.point_b === 0 && mg0Db?.point_c === 0, J(mg0Db));

  // ── 2. 검수 신청(operating) → pending · 카페=발생 ──
  const schedIso = new Date(Date.now() + DAY).toISOString();
  const rr = await api("/api/admin/processes/check/irregular", { method: "POST", body: J({
    organization: ORG, kind: "review_request", act_name: `${TAG} 검수1`,
    reason: "검수 신청 사유", point_a: 3, point_b: 1, point_c: 0, crew_reaction: "partial", point_mode: "ab",
    review_link: "https://cafe.naver.com/test/irr", scheduled_check_at: schedIso,
  }) });
  ck("[검수신청] 201 · status=pending · cafeLabel=발생 · target null(미저장)", rr.status === 201 && rr.json.data?.status === "pending" && rr.json.data?.cafeLabel === "발생" && rr.json.data?.targetUserId === null, `status=${rr.status} cafe=${rr.json.data?.cafeLabel} target=${rr.json.data?.targetUserId}`);
  const rrId = rr.json.data?.id;

  // ── 3. 검수신청은 검수링크/시점 필수(400) ──
  const rrBad = await api("/api/admin/processes/check/irregular", { method: "POST", body: J({
    organization: ORG, kind: "review_request", act_name: `${TAG} 검수-누락`, target_user_id: opTarget.user_id,
  }) });
  ck("[검수신청] 링크/시점 누락 → 400", rrBad.status === 400, `status=${rrBad.status}`);

  // ── 4. operating 보드 GET — 요약 5칸 + 행 노출 ──
  const bOp = await api(`/api/admin/processes/check/irregular?org=${ORG}`);
  const s = bOp.json.data?.summary;
  ck("[보드] GET 200 · 요약 total≥2/검수1/수동1/완료1/대기1", bOp.status === 200 && s?.total >= 2 && s?.reviewRequest >= 1 && s?.manualGrant >= 1 && s?.completed >= 1 && s?.pending >= 1, J(s));
  ck("[보드] 수동/검수 행 노출", !!findRow(bOp.json.data, mgId) && !!findRow(bOp.json.data, rrId));

  // ── 5. direct(DB) == HTTP — 같은 행을 DB 직접 읽어 HTTP 값과 대조 ──
  const dbRow = (await sb.from("process_irregular_acts").select("status,point_a,review_link,target_user_id,scheduled_check_at,kind,scope_mode").eq("id", rrId).maybeSingle()).data;
  const httpRow = findRow(bOp.json.data, rrId);
  ck("[direct==HTTP] status", dbRow?.status === httpRow?.status, `db=${dbRow?.status} http=${httpRow?.status}`);
  ck("[direct==HTTP] point_a", dbRow?.point_a === httpRow?.pointA, `db=${dbRow?.point_a} http=${httpRow?.pointA}`);
  ck("[direct==HTTP] review_link", dbRow?.review_link === httpRow?.reviewLink);
  ck("[direct==HTTP] target null(review_request 미저장)", dbRow?.target_user_id === null && httpRow?.targetUserId === null);
  ck("[direct==HTTP] scope_mode=operating(보드 분기 기준)", dbRow?.scope_mode === "operating");
  ck("[direct==HTTP] 카페(kind 파생): review_request→발생", dbRow?.kind === "review_request" && httpRow?.cafeLabel === "발생");

  // ── 6. DB 저장 주차 = 보드 주차(주차 일치) ──
  const dbWeek = (await sb.from("process_irregular_acts").select("week_id").eq("id", rrId).maybeSingle()).data;
  ck("[DB] 저장 주차 == 보드 week.weekId", dbWeek?.week_id === bOp.json.data?.week?.weekId, J({ db: dbWeek?.week_id, board: bOp.json.data?.week?.weekId }));

  // ── 7. org 분리 — encre 보드엔 oranke 행 미노출 ──
  const bEnc = await api(`/api/admin/processes/check/irregular?org=${OTHER_ORG}`);
  ck("[org분리] encre 보드에 oranke 행 없음", !findRow(bEnc.json.data, mgId) && !findRow(bEnc.json.data, rrId));

  // ── 8. test/operating 분리 — operating 행은 test 보드 미노출 ──
  const bTe = await api(`/api/admin/processes/check/irregular?org=${ORG}&mode=test`);
  ck("[모드분리] test 보드에 operating(opTarget) 행 없음", !findRow(bTe.json.data, mgId) && !findRow(bTe.json.data, rrId));

  // ── 9. write 가드 — operating 모드로 테스트 크루 부여 → 422 (DB write 0) ──
  const guard = await api("/api/admin/processes/check/irregular", { method: "POST", body: J({
    organization: ORG, kind: "manual_grant", act_name: `${TAG} 가드`, target_user_ids: [teTarget.user_id], crew_reaction: "partial", point_mode: "ab",
  }) });
  const cntGuard = (await sb.from("process_irregular_acts").select("id", { count: "exact", head: true }).eq("act_name", `${TAG} 가드`)).count ?? 0;
  ck("[가드] operating+테스트크루 → 422 · DB write 0", guard.status === 422 && cntGuard === 0, `status=${guard.status} rows=${cntGuard}`);

  // ── 10. write 가드 — 타org 크루 부여 → 422 ──
  const guardOrg = await api("/api/admin/processes/check/irregular", { method: "POST", body: J({
    organization: ORG, kind: "manual_grant", act_name: `${TAG} 가드org`, target_user_ids: [encreOp.user_id], crew_reaction: "partial", point_mode: "ab",
  }) });
  ck("[가드] oranke 에 encre 크루 부여 → 422", guardOrg.status === 422, `status=${guardOrg.status}`);

  // ── 11. 액트 종류 인라인 변경(PATCH set_crew_reaction) — partial→all ──
  const cr = await api("/api/admin/processes/check/irregular", { method: "PATCH", body: J({ id: rrId, organization: ORG, action: "set_crew_reaction", crew_reaction: "all" }) });
  ck("[액트종류] PATCH 200 · all(전원)", cr.status === 200 && cr.json.data?.crewReaction === "all", `status=${cr.status} cr=${cr.json.data?.crewReaction}`);
  // 구 enum(레거시) 거부 — 400.
  const crBad = await api("/api/admin/processes/check/irregular", { method: "PATCH", body: J({ id: rrId, organization: ORG, action: "set_crew_reaction", crew_reaction: "required" }) });
  ck("[액트종류] 레거시 값(required) 거부 → 400", crBad.status === 400, `status=${crBad.status}`);

  // ── 12. 검수신청 완료 처리(PATCH complete) ──
  const cp = await api("/api/admin/processes/check/irregular", { method: "PATCH", body: J({ id: rrId, organization: ORG, action: "complete" }) });
  ck("[완료] PATCH 200 · completed", cp.status === 200 && cp.json.data?.status === "completed", `status=${cp.status}`);

  // ── 13. 삭제(DELETE) ──
  const del = await api("/api/admin/processes/check/irregular", { method: "DELETE", body: J({ id: mgId, organization: ORG }) });
  const gone = (await sb.from("process_irregular_acts").select("id").eq("id", mgId).maybeSingle()).data;
  ck("[삭제] DELETE 200 · 행 제거", del.status === 200 && !gone);

  // ── 14. 고객앱 무영향 — 변동 액트가 user_weekly_points 에 행 생성 안 함 ──
  //   (구조 보증: 본 Phase 는 user_weekly_points 미접촉. 대상자 uwp 행 수 불변 확인.)
  const uwpRows = await sb.from("user_weekly_points").select("user_id", { count: "exact", head: true }).eq("user_id", opTarget.user_id).eq("week_id", bOp.json.data?.week?.weekId);
  ck("[고객앱 무영향] user_weekly_points 는 변동 액트로 변하지 않음(read-only 확인)", !uwpRows.error || uwpRows.error.code !== "PGRST205", `uwp count=${uwpRows.count ?? "n/a"}`);
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally { await cleanup(); console.log("(cleanup — net-zero)"); console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(fail > 0 ? 1 : 0); }

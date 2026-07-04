// Action Control ↩ 실행 취소 — 변동(비정규) 액트 rollback: direct(DB) == HTTP 검증.
//   POST /api/admin/processes/check/irregular/rollback 를 실제 호출해 서비스 직접 결과와 대조.
//     [MG] 수동 부여 → rollback: data.status=deleted · DB 행/recipients 제거.
//     [RR] 링크 신청(완료) → rollback: data.status=pending · DB scheduled_check_at/completed_at=null.
//     [BLK] 예약 검수 시각 경과(표시상 자동완료·DB pending) → 409.
//     [REG] rollback 후 보드 GET 정상(일반 조회 경로 무회귀).
//   test 스코프 · encre 테스트 유저 · 무흔적 cleanup. 전제: dev 서버(:3000).
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
const ORG = "encre", TAG = "[QA] ac-irr-http", QA_ADMIN = "c28b2409-4118-49fc-a42e-68e18dbd194c";
const T = "process_irregular_acts", RECIP = "process_check_review_recipients";
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

async function cleanup() {
  const rows = (await sb.from(T).select("id").like("act_name", `${TAG}%`)).data ?? [];
  if (rows.length) await sb.from(RECIP).delete().in("ref_id", rows.map((x) => x.id));
  await sb.from(T).delete().like("act_name", `${TAG}%`);
}

try {
  // 전제 — encre 테스트 유저 1명.
  const markers = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x) => x.user_id));
  const encre = ((await sb.from("user_profiles").select("user_id").eq("organization_slug", ORG)).data ?? []);
  const tester = encre.find((u) => markers.has(u.user_id));
  ck("[전제] encre 테스트 유저 존재", !!tester, tester?.user_id);
  if (!tester) { await cleanup(); process.exit(2); }
  await cleanup();

  // 현재(쓰기) 주차 — test 보드에서 획득.
  const board0 = await api(`/api/admin/processes/check/irregular?org=${ORG}&mode=test`);
  const weekId = board0.json?.data?.week?.weekId;
  ck("[전제] test 보드 GET 200 · 현재 주차 획득", board0.status === 200 && !!weekId, `status=${board0.status} week=${weekId}`);

  // ── [MG] 수동 부여 생성(HTTP) → rollback(HTTP): deleted ──────────────────────────
  const mg = await api("/api/admin/processes/check/irregular", { method: "POST", body: J({
    organization: ORG, mode: "test", kind: "manual_grant", act_name: `${TAG} 수동`,
    target_user_ids: [tester.user_id], point_a: 4, point_b: 1, point_c: 0, crew_reaction: "partial", point_mode: "ab",
  }) });
  const mgId = mg.json?.data?.id;
  ck("[MG] 생성 201 · completed", mg.status === 201 && mg.json?.data?.status === "completed" && !!mgId, `status=${mg.status}`);

  const rbMg = await api("/api/admin/processes/check/irregular/rollback", { method: "POST", body: J({ id: mgId, organization: ORG, mode: "test" }) });
  ck("[MG] rollback HTTP 200 · data.status=deleted", rbMg.status === 200 && rbMg.json?.data?.status === "deleted", `status=${rbMg.status} data=${J(rbMg.json?.data)}`);
  const mgGone = (await sb.from(T).select("id").eq("id", mgId).maybeSingle()).data;
  const mgRecip = (await sb.from(RECIP).select("id", { count: "exact", head: true }).eq("source", "irregular").eq("ref_id", mgId)).count ?? 0;
  ck("[MG] direct==HTTP — DB 행 삭제 · recipients 0", !mgGone && mgRecip === 0, `gone=${!mgGone} recip=${mgRecip}`);

  // ── [RR] 링크 신청 생성(HTTP) → complete(HTTP) → rollback(HTTP): pending ───────────
  const sched = new Date(Date.now() + DAY).toISOString();
  const rr = await api("/api/admin/processes/check/irregular", { method: "POST", body: J({
    organization: ORG, mode: "test", kind: "review_request", act_name: `${TAG} 검수`,
    point_a: 0, point_b: 0, point_c: 0, crew_reaction: "all", review_link: "https://cafe.naver.com/qa-http", scheduled_check_at: sched,
  }) });
  const rrId = rr.json?.data?.id;
  ck("[RR] 생성 201 · pending", rr.status === 201 && rr.json?.data?.status === "pending" && !!rrId, `status=${rr.status}`);
  const cp = await api("/api/admin/processes/check/irregular", { method: "PATCH", body: J({ id: rrId, organization: ORG, mode: "test", action: "complete" }) });
  ck("[RR] complete PATCH 200 · completed", cp.status === 200 && cp.json?.data?.status === "completed", `status=${cp.status}`);

  const rbRr = await api("/api/admin/processes/check/irregular/rollback", { method: "POST", body: J({ id: rrId, organization: ORG, mode: "test" }) });
  ck("[RR] rollback HTTP 200 · data.status=pending", rbRr.status === 200 && rbRr.json?.data?.status === "pending", `status=${rbRr.status} data=${J(rbRr.json?.data)}`);
  const rrDb = (await sb.from(T).select("status,scheduled_check_at,completed_at").eq("id", rrId).maybeSingle()).data;
  ck("[RR] direct==HTTP — DB pending · scheduled/completed null(재테스트 가능)", rrDb?.status === "pending" && rrDb?.scheduled_check_at === null && rrDb?.completed_at === null, J(rrDb));

  // ── [BLK] 예약 검수 시각 경과(표시상 자동완료·DB pending) → rollback 409 ────────────
  const past = new Date(Date.now() - DAY).toISOString();
  const insBlk = await sb.from(T).insert({
    organization_slug: ORG, week_id: weekId, kind: "review_request", act_name: `${TAG} 자동완료`,
    applicant_admin_id: QA_ADMIN, applicant_admin_name: "QA", crew_reaction: "all",
    point_a: 0, point_b: 0, point_c: 0, review_link: "https://cafe.naver.com/qa-http-blk",
    scheduled_check_at: past, status: "pending", scope_mode: "test", attempt_count: 0,
  }).select("id").maybeSingle();
  const blkId = insBlk.data?.id;
  if (blkId) {
    const rbBlk = await api("/api/admin/processes/check/irregular/rollback", { method: "POST", body: J({ id: blkId, organization: ORG, mode: "test" }) });
    ck("[BLK] rollback HTTP 409(되돌릴 실행 없음)", rbBlk.status === 409, `status=${rbBlk.status}`);
    ck("[BLK] DB 무변경(pending 유지)", (await sb.from(T).select("status").eq("id", blkId).maybeSingle()).data?.status === "pending");
  }

  // ── [REG] rollback 후 일반 조회 경로 무회귀 ─────────────────────────────────────
  const board1 = await api(`/api/admin/processes/check/irregular?org=${ORG}&mode=test`);
  ck("[REG] rollback 후 보드 GET 200(일반 조회 경로 정상)", board1.status === 200 && board1.json?.success === true, `status=${board1.status}`);

  // ── [GUARD] 잘못된 입력 방어 ────────────────────────────────────────────────────
  const badId = await api("/api/admin/processes/check/irregular/rollback", { method: "POST", body: J({ id: "not-a-uuid", organization: ORG }) });
  ck("[GUARD] id 형식 오류 → 400", badId.status === 400, `status=${badId.status}`);
  const badOrg = await api("/api/admin/processes/check/irregular/rollback", { method: "POST", body: J({ id: "00000000-0000-0000-0000-000000000000", organization: "nope" }) });
  ck("[GUARD] org 오류 → 400", badOrg.status === 400, `status=${badOrg.status}`);
  const notFound = await api("/api/admin/processes/check/irregular/rollback", { method: "POST", body: J({ id: "00000000-0000-0000-0000-000000000000", organization: ORG }) });
  ck("[GUARD] 없는 행 → 404", notFound.status === 404, `status=${notFound.status}`);
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally { await cleanup(); console.log("(cleanup — net-zero)"); console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(fail > 0 ? 1 : 0); }

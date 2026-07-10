/**
 * /admin/processes/register 서버 검증 — 12시간 규칙 + 개요 필수 (실제 HTTP).
 *   npx tsx --env-file=.env.local scripts/verify-processes-register-12h-overview.mjs
 * 안전: 임시 라인급 생성 → 성공 생성분은 전부 삭제 → 임시 라인급 삭제(정리). 운영 데이터 무접촉.
 * 시점 모델: 절대분 = 주차(N=0/N1=1)*10080 + 요일(0~6)*1440 + (시*60+분). gap>=720 이면 허용.
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const base = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const email = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const E = (n) => { const v = process.env[n]; if (!v) throw new Error("miss " + n); return v; };

async function cookieHeader() {
  const su = E("NEXT_PUBLIC_SUPABASE_URL"), ak = E("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const admin = createClient(su, E("SUPABASE_SERVICE_ROLE_KEY")), anon = createClient(su, ak);
  const { data: l } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await anon.auth.verifyOtp({ email, token: l.properties.email_otp, type: "magiclink" });
  const cap = [];
  const s = createServerClient(su, ak, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await s.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}

let cookie;
const created = [];
let fails = 0;
const rows = [];
const check = (name, cond, detail) => { rows.push({ name, ok: cond, detail }); if (!cond) fails++; };

async function postAct(body, query = "") {
  const res = await fetch(`${base}/api/admin/processes/acts${query}`, {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 201 && json?.data?.id) created.push(json.data.id);
  return { status: res.status, json };
}

function actBody(groupId, { occur, check: chk, overview = "QA 개요 정상 텍스트" }) {
  return {
    line_group_id: groupId, hub: "club", act_name: "QA-12H-ACT",
    duration_minutes: 30,
    occur_week: occur.w, occur_dow: occur.d, occur_time: occur.t,
    check_week: chk.w, check_dow: chk.d, check_time: chk.t,
    point_check: 0, point_advantage: 0, point_penalty: 0,
    cafe: "occur", check_target: "check", act_type: "required",
    overview, remarks: null,
  };
}

async function main() {
  cookie = await cookieHeader();

  // 임시 라인급 생성
  const gRes = await fetch(`${base}/api/admin/processes/line-groups`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ hub: "club", name: `QA12H-${Date.now()}` }),
  });
  const gJson = await gRes.json();
  const groupId = gJson?.data?.id;
  if (!groupId) throw new Error("temp line-group create failed: " + JSON.stringify(gJson));

  const MON = 1, TUE = 2, SUN = 0, SAT = 6;
  // 1) 정상(gap 12h, 개요 있음) → 201
  check("정상 등록(gap=12h, 개요O)", (await postAct(actBody(groupId, { occur: { w: "N", d: MON, t: "09:00" }, check: { w: "N", d: MON, t: "21:00" } }))).status === 201);
  // 2) 검수<신청 (before) → 400
  check("검수가 신청보다 이름 → 400", (await postAct(actBody(groupId, { occur: { w: "N", d: MON, t: "09:00" }, check: { w: "N", d: MON, t: "06:00" } }))).status === 400);
  // 3) 동일 시점 → 400
  check("동일 시점 → 400", (await postAct(actBody(groupId, { occur: { w: "N", d: MON, t: "09:00" }, check: { w: "N", d: MON, t: "09:00" } }))).status === 400);
  // 4) gap 11h30(690) → 400
  const r4 = await postAct(actBody(groupId, { occur: { w: "N", d: MON, t: "09:00" }, check: { w: "N", d: MON, t: "20:30" } }));
  check("gap 11h30(<12h) → 400", r4.status === 400, r4.json?.error);
  // 5) 정확히 12h(720) → 201
  check("gap 정확히 12h → 201", (await postAct(actBody(groupId, { occur: { w: "N", d: TUE, t: "08:00" }, check: { w: "N", d: TUE, t: "20:00" } }))).status === 201);
  // 6) gap 12.5h → 201
  check("gap 12.5h → 201", (await postAct(actBody(groupId, { occur: { w: "N", d: TUE, t: "08:00" }, check: { w: "N", d: TUE, t: "20:30" } }))).status === 201);
  // 7) 자정 통과 정확히 12h(23:30→익일 11:30) → 201
  check("자정 통과 12h → 201", (await postAct(actBody(groupId, { occur: { w: "N", d: MON, t: "23:30" }, check: { w: "N", d: TUE, t: "11:30" } }))).status === 201);
  // 8) 자정 통과 11h30 → 400
  check("자정 통과 11h30 → 400", (await postAct(actBody(groupId, { occur: { w: "N", d: MON, t: "23:30" }, check: { w: "N", d: TUE, t: "11:00" } }))).status === 400);
  // 9) 주차 경계 N→N+1 정확히 12h(토20:00→일08:00) → 201
  check("주차경계 N→N+1 12h → 201", (await postAct(actBody(groupId, { occur: { w: "N", d: SAT, t: "20:00" }, check: { w: "N1", d: SUN, t: "08:00" } }))).status === 201);
  // 10) 개요 누락 → 400
  const b10 = actBody(groupId, { occur: { w: "N", d: MON, t: "09:00" }, check: { w: "N", d: MON, t: "21:00" } }); delete b10.overview;
  const r10 = await postAct(b10); check("개요 누락 → 400", r10.status === 400, r10.json?.error);
  // 11) 개요 "" → 400
  const r11 = await postAct(actBody(groupId, { occur: { w: "N", d: MON, t: "09:00" }, check: { w: "N", d: MON, t: "21:00" }, overview: "" }));
  check("개요 빈문자열 → 400", r11.status === 400, r11.json?.error);
  // 12) 개요 공백만 → 400
  const r12 = await postAct(actBody(groupId, { occur: { w: "N", d: MON, t: "09:00" }, check: { w: "N", d: MON, t: "21:00" }, overview: "   \n  " }));
  check("개요 공백만 → 400", r12.status === 400, r12.json?.error);
  // 13) mode=test 동일 검증(같은 파서/라우트) — gap 부족이 동일하게 400 + 동일 error
  const rNorm = await postAct(actBody(groupId, { occur: { w: "N", d: MON, t: "09:00" }, check: { w: "N", d: MON, t: "20:30" } }));
  const rTest = await postAct(actBody(groupId, { occur: { w: "N", d: MON, t: "09:00" }, check: { w: "N", d: MON, t: "20:30" } }), "?mode=test");
  check("mode=test 오류 구조 동일", rNorm.status === rTest.status && rNorm.json?.error === rTest.json?.error, `norm=${rNorm.json?.error} / test=${rTest.json?.error}`);

  // ── 정리: 생성된 액트 전부 삭제 후 임시 라인급 삭제 ──
  for (const id of created) {
    await fetch(`${base}/api/admin/processes/acts/${id}`, { method: "DELETE", headers: { cookie } });
  }
  await fetch(`${base}/api/admin/processes/line-groups/${groupId}`, { method: "DELETE", headers: { cookie } });

  console.log(JSON.stringify(rows, null, 2));
  console.log(`\ncleanup: ${created.length} acts + 1 line-group deleted`);
  console.log(`${fails === 0 ? "PASS" : "FAIL"}: ${rows.length} checks, ${fails} failures`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });

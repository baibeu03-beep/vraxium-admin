// 프로세스 정보(/admin/processes/info) direct==HTTP 검증.
//   - GET /api/admin/processes/info 요약(산하 액트/라인급/총 소요·필수/우수/최대 포인트 A·B·C)
//   - direct(service-role DB + 동일 누적계층 계산) == HTTP 요약
//   - 액트 삭제(HTTP) 후 목록/요약 즉시 갱신
//   - [회귀] 산하 액트 있는 라인급 삭제 차단(409) 유지
// 전제: dev 서버 + 마이그레이션 적용. net-zero(TAG 정리).
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
const HUB = "club", TAG = "ZZ-pinfo";
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
let pass = 0, fail = 0; const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

// 누적 계층 요약(서버 computeProcessActSummary 미러) — direct 검증용.
function summarize(rows, lineGroupCount) {
  const z = () => ({ check: 0, advantage: 0, penalty: 0 });
  const required = z(), excellent = z(), max = z();
  let dur = 0;
  const add = (t, a) => { t.check += a.point_check; t.advantage += a.point_advantage; t.penalty += a.point_penalty; };
  for (const a of rows) {
    dur += a.duration_minutes;
    if (a.act_type === "required") { add(required, a); add(excellent, a); add(max, a); }
    else if (a.act_type === "optional") { add(excellent, a); add(max, a); }
    else if (a.act_type === "selection") { add(max, a); }
  }
  return { actCount: rows.length, lineGroupCount, totalDurationMinutes: dur, required, excellent, max };
}
const eqTrip = (a, b) => a && b && a.check === b.check && a.advantage === b.advantage && a.penalty === b.penalty;
const eqSummary = (a, b) =>
  a && b && a.actCount === b.actCount && a.lineGroupCount === b.lineGroupCount &&
  a.totalDurationMinutes === b.totalDurationMinutes &&
  eqTrip(a.required, b.required) && eqTrip(a.excellent, b.excellent) && eqTrip(a.max, b.max);
// 기존 데이터와 무관하게 검증하기 위한 델타 헬퍼 (baseline + 시드 기대치).
const addT = (a, b) => ({ check: a.check + b.check, advantage: a.advantage + b.advantage, penalty: a.penalty + b.penalty });
// 허브 전체(서버와 동일 모집단) direct 요약 — TAG 무관 전체 club 액트/라인급.
async function directHubSummary() {
  const rows = (await sb.from("process_acts").select("act_type,duration_minutes,point_check,point_advantage,point_penalty").eq("hub", HUB)).data ?? [];
  const gc = ((await sb.from("process_line_groups").select("id").eq("hub", HUB)).data ?? []).length;
  return summarize(rows, gc);
}

async function cleanup() {
  const g = (await sb.from("process_line_groups").select("id").eq("hub", HUB).like("name", `${TAG}%`)).data ?? [];
  const ids = g.map((x) => x.id);
  if (ids.length) { await sb.from("process_acts").delete().in("line_group_id", ids); await sb.from("process_line_groups").delete().in("id", ids); }
}

try {
  await cleanup();

  // baseline — 기존 club 허브 데이터(사용자 실제 등록분 보존). 이후 모든 기대값은 baseline + 시드 델타.
  const base = (await api(`/api/admin/processes/info?hub=${HUB}`)).json.data?.summary;
  ck("[baseline] 기존 club 허브 요약 수신", !!base, J(base));

  // 시드: 라인급 + 액트 4종(required/optional/selection/basic)
  const cg = await api("/api/admin/processes/line-groups", { method: "POST", body: J({ hub: HUB, name: `${TAG} 라인급` }) });
  const groupId = cg.json.data?.id;
  const mk = (name, type, A, B, C, dur) => ({
    line_group_id: groupId, hub: HUB, act_name: `${TAG} ${name}`, duration_minutes: dur,
    occur_week: "N", occur_dow: 1, occur_time: "06:30", check_week: "N1", check_dow: 5, check_time: "21:00",
    point_check: A, point_advantage: B, point_penalty: C, cafe: "occur", check_target: "check", act_type: type,
    overview: null, remarks: null,
  });
  const seed = [
    mk("필수", "required", 5, 2, 1, 10),
    mk("자율", "optional", 3, 1, 0, 15),
    mk("선발", "selection", 4, 0, 2, 20),
    mk("기본", "basic", 9, 9, 9, 5),
  ];
  const created = [];
  for (const s of seed) { const c = await api("/api/admin/processes/acts", { method: "POST", body: J(s) }); created.push(c.json.data); }
  ck("시드 — 라인급1 + 액트4(required/optional/selection/basic) 생성", !!groupId && created.every((x) => x?.id));

  // HTTP info
  const info = await api(`/api/admin/processes/info?hub=${HUB}`);
  const httpSum = info.json.data?.summary;
  ck("[HTTP] GET /info 200 + summary + acts", info.status === 200 && info.json.success && !!httpSum && Array.isArray(info.json.data?.acts), `status=${info.status}`);

  // 기대값 = baseline + 시드 델타(누적계층·basic 제외):
  //   시드: dur=10+15+20+5=50, required=A5/B2/C1, excellent=+optional=A8/B3/C1, max=+selection=A12/B3/C3
  const expected = {
    actCount: base.actCount + 4, lineGroupCount: base.lineGroupCount + 1,
    totalDurationMinutes: base.totalDurationMinutes + 50,
    required: addT(base.required, { check: 5, advantage: 2, penalty: 1 }),
    excellent: addT(base.excellent, { check: 8, advantage: 3, penalty: 1 }),
    max: addT(base.max, { check: 12, advantage: 3, penalty: 3 }),
  };
  ck("[요약] HTTP summary == baseline+시드 델타(누적계층·basic 제외)", eqSummary(httpSum, expected), J(httpSum));

  // direct(DB) == HTTP — 허브 전체 모집단으로 비교(기존 데이터 무관).
  const directSum = await directHubSummary();
  ck("[검증] direct(DB 재계산, 허브 전체) == HTTP summary", eqSummary(directSum, httpSum), `direct=${J(directSum)} http=${J(httpSum)}`);

  // 산하 액트/라인급/소요 델타 개별 확인
  ck("[요약] 산하 액트 +4 · 산하 라인급 +1 · 총 소요 +50분 반영",
    httpSum.actCount === base.actCount + 4 && httpSum.lineGroupCount === base.lineGroupCount + 1 && httpSum.totalDurationMinutes === base.totalDurationMinutes + 50);

  // [회귀] 산하 액트 있는 라인급 삭제 차단(409) 유지
  const delBlock = await api(`/api/admin/processes/line-groups/${groupId}`, { method: "DELETE" });
  ck("[회귀] 산하 액트 있는 라인급 삭제 차단(409)", delBlock.status === 409 && /산하 등록된 액트가 존재합니다/.test(delBlock.json.error ?? ""), `status=${delBlock.status}`);

  // 액트 삭제(HTTP) — '필수'(required) 삭제 후 요약 갱신
  const reqAct = created.find((x) => x.actName.endsWith("필수"));
  const del = await api(`/api/admin/processes/acts/${reqAct.id}`, { method: "DELETE" });
  ck("[삭제] 액트 DELETE 200", del.status === 200 && del.json.success);
  const gone = (await sb.from("process_acts").select("id").eq("id", reqAct.id).maybeSingle()).data;
  ck("[삭제] DB 에서 액트 제거 확인", !gone);

  const info2 = await api(`/api/admin/processes/info?hub=${HUB}`);
  const sum2 = info2.json.data?.summary;
  // required(A5/B2/C1) 삭제 후 시드 잔여: dur=40, required 델타 0, excellent=+optional A3/B1/C0, max=+optional+selection A7/B1/C2
  const expected2 = {
    actCount: base.actCount + 3, lineGroupCount: base.lineGroupCount + 1,
    totalDurationMinutes: base.totalDurationMinutes + 40,
    required: addT(base.required, { check: 0, advantage: 0, penalty: 0 }),
    excellent: addT(base.excellent, { check: 3, advantage: 1, penalty: 0 }),
    max: addT(base.max, { check: 7, advantage: 1, penalty: 2 }),
  };
  ck("[삭제] 삭제 후 요약 즉시 갱신(액트 +3·required 델타0·max +A7/B1/C2)", eqSummary(sum2, expected2), J(sum2));
  const directSum2 = await directHubSummary();
  ck("[검증] 삭제 후 direct == HTTP", eqSummary(directSum2, sum2));

  // 잘못된 id 삭제 400 / 없는 id 404
  const badId = await api(`/api/admin/processes/acts/not-a-uuid`, { method: "DELETE" });
  ck("[검증] 잘못된 id 삭제 400", badId.status === 400);
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally { await cleanup(); console.log("(cleanup 완료 — net-zero)"); console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(fail > 0 ? 1 : 0); }

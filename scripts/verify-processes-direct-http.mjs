// 프로세스 등록(액트/라인급 마스터) direct==HTTP 검증.
//   - 라인급 등록(HTTP) / 액트 등록(HTTP) / 라인급 삭제 차단(409) / 빈 라인급 삭제(200)
//   - direct(service-role DB 직독) == HTTP 응답 DTO 동등성
//   - 마스터 카탈로그 Phase: snapshot/주차 성장 계산 무접촉 (이 스크립트도 그 경로 미호출).
// 전제: dev 서버 localhost:3000 + db/migrations/2026-06-12_process_acts.sql 적용.
// 정리(net-zero): TAG 로 표시한 테스트 행은 service-role 로 전부 삭제.
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
const HUB = "club", TAG = "ZZ-proc";
const J = (o) => JSON.stringify(o);

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = []; const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookie = cap.map((i) => `${i.name}=${i.value}`).join("; ");

const api = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { "Content-Type": "application/json", cookie, ...(init.headers ?? {}) } });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
};
let pass = 0, fail = 0; const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function cleanup() {
  const groups = (await sb.from("process_line_groups").select("id").eq("hub", HUB).like("name", `${TAG}%`)).data ?? [];
  const ids = groups.map((g) => g.id);
  if (ids.length) {
    await sb.from("process_acts").delete().in("line_group_id", ids);
    await sb.from("process_line_groups").delete().in("id", ids);
  }
}

try {
  await cleanup();

  // [6] 라인급 등록 (HTTP)
  const gName = `${TAG} 라인급A`;
  const cg = await api("/api/admin/processes/line-groups", { method: "POST", body: J({ hub: HUB, name: gName }) });
  ck("[6] 라인급 등록 — HTTP 201 + DTO 반환", cg.status === 201 && cg.json.success && cg.json.data?.name === gName, `status=${cg.status} ${cg.json.error ?? ""}`);
  const groupId = cg.json.data?.id;

  // direct == HTTP (라인급)
  const dG = (await sb.from("process_line_groups").select("id,hub,name").eq("id", groupId).maybeSingle()).data;
  ck("[3·4·5] 라인급 direct(DB) == HTTP", !!dG && dG.id === groupId && dG.hub === HUB && dG.name === gName, J({ direct: dG, http: { id: groupId, hub: HUB, name: gName } }));

  // GET 목록에 노출
  const gl = await api(`/api/admin/processes/line-groups?hub=${HUB}`);
  ck("[6] GET 라인급 목록에 노출 (actCount=0)", gl.json.data?.some((x) => x.id === groupId && x.actCount === 0));

  // [8] 액트 등록 (HTTP)
  const actBody = {
    line_group_id: groupId, hub: HUB, act_name: `${TAG} [브리핑] 클럽 시작`,
    duration_minutes: 15, occur_week: "N", occur_dow: 1, occur_time: "06:30",
    check_week: "N1", check_dow: 5, check_time: "21:00",
    point_check: 12, point_advantage: 3, point_penalty: 2,
    cafe: "occur", check_target: "check", act_type: "required",
    overview: "개요 텍스트", remarks: "비고 텍스트",
  };
  const ca = await api("/api/admin/processes/acts", { method: "POST", body: J(actBody) });
  ck("[8] 액트 등록 — HTTP 201 + DTO 반환", ca.status === 201 && ca.json.success && ca.json.data?.actName === actBody.act_name, `status=${ca.status} ${ca.json.error ?? ""}`);
  const actId = ca.json.data?.id;
  const httpAct = ca.json.data;

  // [9] 액트 저장 확인 + direct == HTTP (전 필드)
  const dA = (await sb.from("process_acts").select("*").eq("id", actId).maybeSingle()).data;
  const fieldsOk = dA
    && dA.line_group_id === groupId && dA.hub === HUB && dA.act_name === actBody.act_name
    && dA.duration_minutes === 15 && dA.occur_week === "N" && dA.occur_dow === 1 && dA.occur_time === "06:30"
    && dA.check_week === "N1" && dA.check_dow === 5 && dA.check_time === "21:00"
    && dA.point_check === 12 && dA.point_advantage === 3 && dA.point_penalty === 2
    && dA.cafe === "occur" && dA.check_target === "check" && dA.act_type === "required"
    && dA.overview === "개요 텍스트" && dA.remarks === "비고 텍스트";
  ck("[9] 액트 저장 확인 — direct(DB) 전 필드 일치", !!fieldsOk, dA ? J({ pc: dA.point_check, pa: dA.point_advantage, pp: dA.point_penalty, ct: dA.occur_time }) : "no row");
  const dtoMatch = httpAct
    && httpAct.pointCheck === dA?.point_check && httpAct.pointAdvantage === dA?.point_advantage
    && httpAct.pointPenalty === dA?.point_penalty && httpAct.occurTime === dA?.occur_time
    && httpAct.checkWeek === dA?.check_week && httpAct.actType === dA?.act_type
    && httpAct.lineGroupId === dA?.line_group_id;
  ck("[5] 액트 direct == HTTP DTO 매핑(snake↔camel)", !!dtoMatch);

  // GET 액트 목록에 노출 + 라인급명 graft
  const al = await api(`/api/admin/processes/acts?hub=${HUB}`);
  ck("[9] GET 액트 목록에 노출 + lineGroupName graft", al.json.data?.some((x) => x.id === actId && x.lineGroupName === gName));

  // 라인급 actCount 갱신 확인
  const gl2 = await api(`/api/admin/processes/line-groups?hub=${HUB}`);
  ck("[6] 라인급 actCount=1 반영", gl2.json.data?.some((x) => x.id === groupId && x.actCount === 1));

  // [7] 라인급 삭제 차단 — 산하 액트 존재 → 409 + 차단 문구
  const delBlocked = await api(`/api/admin/processes/line-groups/${groupId}`, { method: "DELETE" });
  ck("[7] 라인급 삭제 차단 — 409 + '산하 등록된 액트가 존재합니다' 문구",
    delBlocked.status === 409 && /산하 등록된 액트가 존재합니다/.test(delBlocked.json.error ?? ""), `status=${delBlocked.status}`);
  // 차단 후에도 행 보존 확인
  const stillThere = (await sb.from("process_line_groups").select("id").eq("id", groupId).maybeSingle()).data;
  ck("[7] 삭제 차단 후 라인급 행 보존(미삭제)", !!stillThere);

  // 빈 라인급 삭제 성공(정상 경로) — 액트 없는 별도 그룹.
  const empty = await api("/api/admin/processes/line-groups", { method: "POST", body: J({ hub: HUB, name: `${TAG} 라인급B(빈)` }) });
  const emptyId = empty.json.data?.id;
  const delOk = await api(`/api/admin/processes/line-groups/${emptyId}`, { method: "DELETE" });
  const goneAfter = (await sb.from("process_line_groups").select("id").eq("id", emptyId).maybeSingle()).data;
  ck("[7] 빈 라인급 삭제 — 200 + 실제 삭제", delOk.status === 200 && delOk.json.success && !goneAfter);

  // [검증] 중복 라인급명 거부 (409)
  const dup = await api("/api/admin/processes/line-groups", { method: "POST", body: J({ hub: HUB, name: gName }) });
  ck("[검증] 동일 허브 라인급명 중복 거부(409)", dup.status === 409, `status=${dup.status}`);

  // [검증] 무효 hub 400
  const badHub = await api("/api/admin/processes/line-groups", { method: "POST", body: J({ hub: "nope", name: `${TAG} x` }) });
  ck("[검증] 무효 hub 400", badHub.status === 400);

  // [검증] 포인트 범위 초과(21) 400
  const badPt = await api("/api/admin/processes/acts", { method: "POST", body: J({ ...actBody, point_check: 21 }) });
  ck("[검증] point_check 21 → 400(0~20)", badPt.status === 400);
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally { await cleanup(); console.log("(cleanup 완료 — net-zero)"); console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(fail > 0 ? 1 : 0); }

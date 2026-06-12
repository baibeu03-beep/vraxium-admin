// 프로세스 체크 [섹션.1] 액트 목록(표시 전용) direct==HTTP 검증.
//   - GET /api/admin/processes/check?hub=info&org=oranke : board.acts (마스터 기준)
//   - 발생 시점(필요) 순 정렬(N→N+1 · 일→토 · 빠른 시간 · sort_order/created_at)
//   - 컬럼 채움(라인급/소요/Po.A·B·C/크루반응/카페) · 실제 시점 빈칸 · 상태=needed(체크 필요)
//   - direct(process_acts 동일 정렬) == HTTP acts 순서
//   - org 분기(encre 도 동일 목록·동일 순서, 상태 needed)
// 전제: dev 서버(localhost:3000). 상태 저장 테이블 의존 없음(표시 전용·best-effort). net-zero(TAG 정리).
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
const HUB = "info", TAG = "ZZ-pchk-acts";
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

async function cleanup() {
  const g = (await sb.from("process_line_groups").select("id").eq("hub", HUB).like("name", `${TAG}%`)).data ?? [];
  const ids = g.map((x) => x.id);
  if (ids.length) { await sb.from("process_acts").delete().in("line_group_id", ids); await sb.from("process_line_groups").delete().in("id", ids); }
}

// direct 정렬(서버 comparator 미러).
const weekRank = (w) => (w === "N" ? 0 : 1);
function sortDirect(rows) {
  return [...rows].sort((a, b) =>
    weekRank(a.occur_week) - weekRank(b.occur_week) ||
    a.occur_dow - b.occur_dow ||
    a.occur_time.localeCompare(b.occur_time) ||
    a.created_at.localeCompare(b.created_at));
}

try {
  await cleanup();

  const cg = await api("/api/admin/processes/line-groups", { method: "POST", body: J({ hub: HUB, name: `${TAG} 라인급` }) });
  const groupId = cg.json.data?.id;
  const mk = (name, ow, od, ot, type, cafe) => ({
    line_group_id: groupId, hub: HUB, act_name: `${TAG} ${name}`, duration_minutes: 10,
    occur_week: ow, occur_dow: od, occur_time: ot, check_week: "N", check_dow: 3, check_time: "21:00",
    point_check: 3, point_advantage: 2, point_penalty: 1, cafe, check_target: "check", act_type: type,
    overview: null, remarks: null,
  });
  // 생성 순서를 일부러 뒤섞어 정렬을 검증: A(N 수 09:00), B(N 화 08:00), C(N 화 06:30), D(N+1 월 06:00)
  // 기대 정렬: C, B, A, D
  const seed = [
    ["A", "N", 3, "09:00", "required", "occur"],
    ["D", "N1", 1, "06:00", "optional", "none"],
    ["B", "N", 2, "08:00", "required", "occur"],
    ["C", "N", 2, "06:30", "optional", "none"],
  ];
  const made = {};
  for (const s of seed) { const c = await api("/api/admin/processes/acts", { method: "POST", body: J(mk(...s)) }); made[s[0]] = c.json.data?.id; }
  ck("시드 — 라인급1 + 액트4(A/B/C/D, occur 뒤섞어 생성)", !!groupId && Object.values(made).every(Boolean));

  // HTTP 보드.
  const b = await api(`/api/admin/processes/check?hub=${HUB}&org=oranke`);
  ck("[HTTP] GET 보드 200 + acts 배열", b.status === 200 && b.json.success && Array.isArray(b.json.data?.acts), `status=${b.status}`);
  const board = b.json.data;
  ck("[주차] 이번 주 periodLabel 고정 표기", /^\d{2}년, .+시즌, \d+주차$/.test(board.week?.periodLabel ?? ""), board.week?.periodLabel);

  const mine = (board.acts ?? []).filter((a) => a.actName?.startsWith(TAG));
  const order = mine.map((a) => a.actName.replace(`${TAG} `, ""));
  ck("[정렬] 발생 시점(필요) 순 = C,B,A,D (화06:30→화08:00→수09:00→N+1 월)", J(order) === J(["C", "B", "A", "D"]), J(order));

  // 같은 주 안에서 화요일 액트가 수요일 액트보다 위(아래 아님).
  const idxB = order.indexOf("B"), idxA = order.indexOf("A");
  ck("[정렬] 같은 주 화(B)가 수(A)보다 위", idxB >= 0 && idxA >= 0 && idxB < idxA);

  // 컬럼 채움 + 실제 시점 빈칸 + 상태 needed.
  const C = mine.find((a) => a.actName.endsWith("C"));
  ck("[컬럼] 라인급/소요/Po.A·B·C/크루반응/카페 채움", C && C.lineGroupName === `${TAG} 라인급` && C.durationMinutes === 10 && C.pointCheck === 3 && C.pointAdvantage === 2 && C.pointPenalty === 1 && C.crewReactionLabel === "자율" && C.cafeLabel === "미발생", J(C && { g: C.lineGroupName, d: C.durationMinutes, cr: C.crewReactionLabel, cafe: C.cafeLabel }));
  const A = mine.find((a) => a.actName.endsWith("A"));
  ck("[컬럼] A: 크루반응=필수 · 카페=발생", A && A.crewReactionLabel === "필수" && A.cafeLabel === "발생");
  ck("[실제시점] 발생/체크 시점(실제) 빈칸(null)", mine.every((a) => a.requestedAt === null && a.scheduledCheckAt === null));
  ck("[상태] 표시 전용 — 전부 needed(버튼 '체크 필요')", mine.every((a) => a.status === "needed"));

  // direct(process_acts) == HTTP acts 순서.
  const direct = sortDirect((await sb.from("process_acts").select("id,act_name,occur_week,occur_dow,occur_time,created_at").eq("line_group_id", groupId)).data ?? []);
  const directOrder = direct.map((x) => x.act_name.replace(`${TAG} `, ""));
  ck("[검증] direct(process_acts 동일 정렬) == HTTP 순서", J(directOrder) === J(order), `direct=${J(directOrder)}`);

  // org 분기 — encre 도 동일 목록·순서(마스터 org 무관) · 상태 needed.
  const bEnc = await api(`/api/admin/processes/check?hub=${HUB}&org=encre`);
  const mineEnc = (bEnc.json.data?.acts ?? []).filter((a) => a.actName?.startsWith(TAG)).map((a) => a.actName.replace(`${TAG} `, ""));
  ck("[org분기] encre 동일 목록·동일 순서", J(mineEnc) === J(order), J(mineEnc));
  ck("[org분기] encre 상태도 needed(표시 전용)", (bEnc.json.data?.acts ?? []).filter((a) => a.actName?.startsWith(TAG)).every((a) => a.status === "needed"));

  // 검증용 — 잘못된 org 400.
  const badOrg = await api(`/api/admin/processes/check?hub=${HUB}&org=nope`);
  ck("[검증] 잘못된 org 400", badOrg.status === 400);
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally { await cleanup(); console.log("(cleanup 완료 — net-zero)"); console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(fail > 0 ? 1 : 0); }

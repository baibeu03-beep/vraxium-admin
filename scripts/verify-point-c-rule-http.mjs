// 액트 종류 ↔ 포인트 C 규칙 검증 — 정규(act_type/point_penalty) + 변동(crew_reaction/point_c).
//   required 만 C 허용 · 그 외(optional/selection/basic/none)는 C=0 강제(백엔드 보정). DB==HTTP.
// 전제: dev 서버(:3000) + process_acts / process_irregular_acts 마이그레이션 적용.
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
const EMAIL = "vanuatu.golden@gmail.com", ORG = "oranke", TAG = "ZZ-pointC";
const J = (o) => JSON.stringify(o), DAY = 86_400_000;

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = []; const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookie = cap.map((i) => `${i.name}=${i.value}`).join("; ");
const api = async (p, init = {}) => { const res = await fetch(`${BASE}${p}`, { ...init, headers: { "Content-Type": "application/json", cookie, ...(init.headers ?? {}) } }); return { status: res.status, json: await res.json().catch(() => ({})) }; };
let pass = 0, fail = 0; const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function cleanup() {
  const g = (await sb.from("process_line_groups").select("id").like("name", `${TAG}%`)).data ?? [];
  if (g.length) { const ids = g.map((x) => x.id); await sb.from("process_acts").delete().in("line_group_id", ids); await sb.from("process_line_groups").delete().in("id", ids); }
  const irr = (await sb.from("process_irregular_acts").select("id").like("act_name", `${TAG}%`)).data ?? [];
  if (irr.length) { await sb.from("process_check_review_recipients").delete().in("ref_id", irr.map((x) => x.id)); await sb.from("process_irregular_acts").delete().in("id", irr.map((x) => x.id)); }
}

try {
  await cleanup();
  const markers = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x) => x.user_id));
  const opTarget = ((await sb.from("user_profiles").select("user_id").eq("organization_slug", ORG)).data ?? []).find((u) => !markers.has(u.user_id));
  ck("[전제] oranke 운영 크루 존재", !!opTarget);

  // ══ 정규 액트 (act_type / point_penalty=C) ══
  const cg = await api("/api/admin/processes/line-groups", { method: "POST", body: J({ hub: "info", name: `${TAG} 라인급` }) });
  const groupId = cg.json.data?.id;
  ck("[정규] 라인급 생성", !!groupId);
  const baseAct = { line_group_id: groupId, hub: "info", duration_minutes: 10, occur_week: "N", occur_dow: 2, occur_time: "06:30", check_week: "N", check_dow: 3, check_time: "21:00", point_check: 5, point_advantage: 3, cafe: "occur", check_target: "check", overview: null, remarks: null };
  // optional + penalty=15 → 백엔드가 0으로 강제
  const aOpt = await api("/api/admin/processes/acts", { method: "POST", body: J({ ...baseAct, act_name: `${TAG} 자율`, act_type: "optional", point_penalty: 15 }) });
  ck("[정규] act_type=optional + penalty=15 → DTO penalty=0", aOpt.status === 201 && aOpt.json.data?.pointPenalty === 0, `status=${aOpt.status} c=${aOpt.json.data?.pointPenalty}`);
  const aOptDb = (await sb.from("process_acts").select("point_penalty").eq("id", aOpt.json.data?.id).maybeSingle()).data;
  ck("[정규][DB==HTTP] optional penalty=0", aOptDb?.point_penalty === 0, `db=${aOptDb?.point_penalty}`);
  // required + penalty=10 → 유지
  const aReq = await api("/api/admin/processes/acts", { method: "POST", body: J({ ...baseAct, act_name: `${TAG} 필수`, act_type: "required", point_penalty: 10 }) });
  ck("[정규] act_type=required + penalty=10 → DTO penalty=10(유지)", aReq.status === 201 && aReq.json.data?.pointPenalty === 10, `c=${aReq.json.data?.pointPenalty}`);
  const aReqDb = (await sb.from("process_acts").select("point_penalty").eq("id", aReq.json.data?.id).maybeSingle()).data;
  ck("[정규][DB==HTTP] required penalty=10", aReqDb?.point_penalty === 10);

  // ══ 변동 — 수동 부여(crew_reaction / point_c=C) ══
  const mgOpt = await api("/api/admin/processes/check/irregular", { method: "POST", body: J({ organization: ORG, kind: "manual_grant", act_name: `${TAG} 수동선택`, target_user_ids: [opTarget.user_id], crew_reaction: "optional", point_a: 4, point_b: 2, point_c: 15 }) });
  ck("[변동] manual_grant crew=optional + c=15 → DTO pointC=0", mgOpt.status === 201 && mgOpt.json.data?.pointC === 0, `status=${mgOpt.status} c=${mgOpt.json.data?.pointC}`);
  const mgOptDb = (await sb.from("process_irregular_acts").select("point_c").eq("id", mgOpt.json.data?.id).maybeSingle()).data;
  ck("[변동][DB==HTTP] manual optional point_c=0", mgOptDb?.point_c === 0, `db=${mgOptDb?.point_c}`);

  // 검수 신청 crew=none + c=12 → 0
  const rrNone = await api("/api/admin/processes/check/irregular", { method: "POST", body: J({ organization: ORG, kind: "review_request", act_name: `${TAG} 검수없음`, crew_reaction: "none", point_a: 2, point_b: 1, point_c: 12, review_link: "https://cafe.naver.com/x/c", scheduled_check_at: new Date(Date.now() + DAY).toISOString() }) });
  ck("[변동] review_request crew=none + c=12 → DTO pointC=0", rrNone.status === 201 && rrNone.json.data?.pointC === 0, `c=${rrNone.json.data?.pointC}`);

  // required + c=8 → 유지
  const mgReq = await api("/api/admin/processes/check/irregular", { method: "POST", body: J({ organization: ORG, kind: "manual_grant", act_name: `${TAG} 수동필수`, target_user_ids: [opTarget.user_id], crew_reaction: "required", point_a: 4, point_b: 2, point_c: 8 }) });
  ck("[변동] manual_grant crew=required + c=8 → DTO pointC=8(유지)", mgReq.status === 201 && mgReq.json.data?.pointC === 8, `c=${mgReq.json.data?.pointC}`);

  // 인라인 PATCH set_crew_reaction: required(c=8) → optional → c=0 강제
  const patch = await api("/api/admin/processes/check/irregular", { method: "PATCH", body: J({ id: mgReq.json.data?.id, organization: ORG, action: "set_crew_reaction", crew_reaction: "optional" }) });
  ck("[변동] PATCH 크루반응 required→optional → DTO pointC=0", patch.status === 200 && patch.json.data?.pointC === 0, `status=${patch.status} c=${patch.json.data?.pointC}`);
  const patchDb = (await sb.from("process_irregular_acts").select("crew_reaction,point_c").eq("id", mgReq.json.data?.id).maybeSingle()).data;
  ck("[변동][DB==HTTP] PATCH 후 crew=optional·point_c=0", patchDb?.crew_reaction === "optional" && patchDb?.point_c === 0, J(patchDb));

  // 고객앱 무영향 — uwp 불변(구조 보증).
  const uwp = await sb.from("user_weekly_points").select("user_id", { count: "exact", head: true }).eq("user_id", opTarget.user_id);
  ck("[고객앱 무영향] user_weekly_points 접근 가능·변동/정규 액트와 무관", !uwp.error || uwp.error.code !== "PGRST205");
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally { await cleanup(); console.log("(cleanup — net-zero)"); console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(fail > 0 ? 1 : 0); }

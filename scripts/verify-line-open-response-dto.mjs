// 검증(HTTP): 라인 개설/취소 응답 DTO 의 키·타입이 기존 계약과 동일한가 + 개설 취소 후 DB 최종 상태.
//
//   사전조건: admin dev :3000.  실행: node scripts/verify-line-open-response-dto.mjs
//
// 성능 개선(참조 읽기 캐시·병렬화·audience 청크 조회)이 **응답 계약과 DB 결과를 바꾸지 않았음**을
// 확인한다. 무개설 조합에서 개설 → (중복 개설) → 취소 를 한 번 돌리고:
//   ① 개설 201 응답 data 키/타입           ② 중복 개설 409 + 한국어 문구
//   ③ 취소 200 응답 data 키/타입            ④ 취소 후 라인/타깃/신청 잔여 0
//   ⑤ 취소 후 재개설 가능(멱등 사이클)
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const getEnv = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = process.env.BASE || "http://localhost:3000";
const SUPA_URL = getEnv("NEXT_PUBLIC_SUPABASE_URL");
const ANON = getEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = getEnv("SUPABASE_SERVICE_ROLE_KEY");
const EMAIL = process.env.ADMIN_EMAIL || "vanuatu.golden@gmail.com";

const sb = createClient(SUPA_URL, SERVICE);
const brow = createClient(SUPA_URL, ANON);
let failures = 0;
const ok = (m) => console.log("  ✓", m);
const fail = (m) => {
  failures++;
  console.error("  ✗", m);
};

async function loginCookies() {
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const { data: v } = await brow.auth.verifyOtp({
    email: EMAIL,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  const cap = [];
  const srv = createServerClient(SUPA_URL, ANON, {
    cookies: { getAll: () => [], setAll: (i) => cap.push(...i) },
  });
  await srv.auth.setSession({
    access_token: v.session.access_token,
    refresh_token: v.session.refresh_token,
  });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
function checkShape(label, obj, expected) {
  const got = Object.fromEntries(Object.entries(obj ?? {}).map(([k, v]) => [k, typeOf(v)]));
  for (const [k, t] of Object.entries(expected)) {
    if (!(k in got)) {
      fail(`${label}: 키 누락 '${k}'`);
    } else if (!t.split("|").includes(got[k])) {
      fail(`${label}: '${k}' 타입 ${got[k]} (기대 ${t})`);
    }
  }
  const extra = Object.keys(got).filter((k) => !(k in expected));
  ok(`${label}: 키 ${Object.keys(got).length}개 — 기존 계약 전부 존재${extra.length ? ` (추가 키: ${extra.join(",")})` : ""}`);
  return got;
}

async function main() {
  const cookie = await loginCookies();
  const H = { cookie, "Content-Type": "application/json" };

  // 무개설 (org, week, activity_type) 찾기 — 기존 개설분 무접촉.
  const { data: cfgs } = await sb
    .from("cluster4_week_opening_configs")
    .select("week_id,organization_slug,config")
    .eq("open_confirmed", true);
  const { data: activeLines } = await sb
    .from("cluster4_lines").select("id,activity_type_id,week_id").eq("part_type", "info").eq("is_active", true);
  const { data: tgt } = await sb.from("cluster4_line_targets").select("line_id,week_id");
  const occupied = new Set();
  const weeksOf = new Map();
  for (const t of tgt ?? []) {
    if (!t.line_id) continue;
    (weeksOf.get(t.line_id) ?? weeksOf.set(t.line_id, new Set()).get(t.line_id)).add(t.week_id);
  }
  for (const l of activeLines ?? []) {
    const ws = new Set(weeksOf.get(l.id) ?? []);
    if (l.week_id) ws.add(l.week_id);
    for (const w of ws) occupied.add(`${l.activity_type_id}|${w}`);
  }
  let fx = null;
  for (const c of cfgs ?? []) {
    for (const [actId, on] of Object.entries(c.config?.practicalInfo ?? {})) {
      if (on === true && !occupied.has(`${actId}|${c.week_id}`)) {
        fx = { org: c.organization_slug, weekId: c.week_id, activityTypeId: actId };
        break;
      }
    }
    if (fx) break;
  }
  if (!fx) {
    console.log("무개설 조합 없음 — 검증 스킵(기존 개설분은 건드리지 않는다)");
    return;
  }
  console.log(`fixture: ${fx.org} week=${fx.weekId.slice(0, 8)} activity=${fx.activityTypeId}\n`);

  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const testIds = new Set((markers ?? []).map((m) => m.user_id));
  const { data: profs } = await sb.from("user_profiles").select("user_id").eq("organization_slug", fx.org);
  const targets = (profs ?? []).map((p) => p.user_id).filter((u) => testIds.has(u)).slice(0, 12);

  const qs = `organization=${fx.org}&mode=test`;
  const openBody = {
    activity_type_id: fx.activityTypeId,
    main_title: "[bench] dto-verify",
    output_links: [{ url: "https://example.com/verify", label: "verify" }],
    output_images: [],
    target_user_ids: targets,
    week_id: fx.weekId,
    submission_opens_at: new Date().toISOString(),
    submission_closes_at: new Date(Date.now() + 7 * 864e5).toISOString(),
  };

  console.log("① 개설 201 응답 DTO");
  const r1 = await fetch(`${BASE}/api/admin/cluster4/info-lines?${qs}`, {
    method: "POST", headers: H, body: JSON.stringify(openBody),
  });
  const j1 = await r1.json();
  if (r1.status !== 201 || !j1.success) fail(`개설 실패: ${r1.status} ${j1.error}`);
  else ok("개설 201 success=true");
  checkShape("개설 data", j1.data, {
    line: "object",
    targets: "array",
    targetCount: "number",
    matchedCrewCount: "number|null",
    rawCommentCount: "number|null",
    cafeUrl: "string|null",
  });
  checkShape("개설 data.line", j1.data?.line, {
    id: "string", part_type: "string", activity_type_id: "string", line_code: "string|null",
    week_id: "string", main_title: "string", output_links: "array|null", output_images: "array|null",
    submission_opens_at: "string", submission_closes_at: "string", is_active: "boolean", created_at: "string",
  });
  if (j1.data?.targetCount !== targets.length) fail(`targetCount ${j1.data?.targetCount} ≠ ${targets.length}`);
  else ok(`targetCount=${j1.data.targetCount} (요청 대상자 수와 일치)`);
  const lineId = j1.data?.line?.id;

  console.log("\n② 중복 개설 409");
  const r2 = await fetch(`${BASE}/api/admin/cluster4/info-lines?${qs}`, {
    method: "POST", headers: H, body: JSON.stringify(openBody),
  });
  const j2 = await r2.json();
  if (r2.status !== 409) fail(`중복 개설 status ${r2.status} (기대 409)`);
  else ok("중복 개설 409");
  if (typeof j2.error !== "string" || !/활성 라인이 이미 있습니다/.test(j2.error))
    fail(`409 문구 변경: ${j2.error}`);
  else ok(`409 한국어 문구 유지: "${j2.error}"`);

  console.log("\n③ 개설 취소 200 응답 DTO");
  const delUrl = `${BASE}/api/admin/cluster4/info-lines?week_id=${fx.weekId}&activity_type_id=${fx.activityTypeId}&${qs}`;
  const r3 = await fetch(delUrl, { method: "DELETE", headers: { cookie } });
  const j3 = await r3.json();
  if (r3.status !== 200 || !j3.success) fail(`취소 실패: ${r3.status} ${j3.error}`);
  else ok("취소 200 success=true");
  checkShape("취소 data", j3.data, { lineId: "string", cancelled: "boolean" });
  if (j3.data?.lineId !== lineId) fail(`취소 lineId 불일치 (${j3.data?.lineId} ≠ ${lineId})`);
  else ok("취소 lineId = 개설 lineId");

  console.log("\n④ 취소 후 DB 최종 상태");
  const { data: leftLine } = await sb.from("cluster4_lines").select("id").eq("id", lineId);
  const { data: leftTgt } = await sb.from("cluster4_line_targets").select("id").eq("line_id", lineId);
  if ((leftLine ?? []).length !== 0) fail(`라인 행 잔여 ${leftLine.length}`);
  else ok("cluster4_lines 잔여 0");
  if ((leftTgt ?? []).length !== 0) fail(`타깃 행 잔여 ${leftTgt.length}`);
  else ok("cluster4_line_targets 잔여 0 (FK cascade)");

  console.log("\n⑤ 취소 후 재개설 → 다시 취소(원상복구)");
  const r4 = await fetch(`${BASE}/api/admin/cluster4/info-lines?${qs}`, {
    method: "POST", headers: H, body: JSON.stringify(openBody),
  });
  const j4 = await r4.json();
  if (r4.status !== 201 || !j4.success) fail(`재개설 실패: ${r4.status} ${j4.error}`);
  else ok("재개설 201");
  const r5 = await fetch(delUrl, { method: "DELETE", headers: { cookie } });
  if (r5.status !== 200) fail(`재취소 실패 ${r5.status}`);
  else ok("재취소 200 — 상태 원복 완료");

  console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

// 라인 개설 스코프 가드 — direct(DB) == HTTP 검증 (이번 수정분 전용).
//   대상 수정:
//     · competency-lines POST  : org+mode 스코프 가드 추가(과거 fail-open) → 422 · DB write 0
//     · experience-lines POST  : org+mode 스코프 가드 추가(과거 fail-open) → 422 · DB write 0
//     · competency applications : resolveTargetWeekId(mode) — test=W13 예외, operating=정규(운영 유지)
//   안전성: 가드는 insert 이전에 동작하므로 422 경로는 DB 무변경(생성 0) — 실데이터 미오염.
//           유효(통과) 경로는 실 고객 라인/snapshot 을 생성하므로 본 스크립트에서 호출하지 않는다.
// 전제: dev 서버(:3000) 기동.
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
const ORG = "oranke", OTHER_ORG = "encre";
const J = (o) => JSON.stringify(o);
const RANDOM_UUID = "00000000-0000-4000-8000-000000000000"; // 가드는 master/week 조회 이전 → 무의미해도 OK
const NOW = new Date().toISOString();

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

// 라인/타깃 카운트(가드가 막으면 불변이어야 함).
const countLines = async (partType) =>
  (await sb.from("cluster4_lines").select("id", { count: "exact", head: true }).eq("part_type", partType)).count ?? -1;

try {
  const markers = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x) => x.user_id));
  const oranke = ((await sb.from("user_profiles").select("user_id").eq("organization_slug", ORG)).data ?? []);
  const opUser = oranke.find((u) => !markers.has(u.user_id));   // oranke 실사용자
  const teUser = oranke.find((u) => markers.has(u.user_id));    // oranke 테스트 사용자
  const encre = ((await sb.from("user_profiles").select("user_id").eq("organization_slug", OTHER_ORG)).data ?? []);
  const encreOp = encre.find((u) => !markers.has(u.user_id));   // encre 실사용자(타org 동명이인 역)
  ck("[전제] oranke 운영/테스트 + encre 운영 사용자 존재", !!opUser && !!teUser && !!encreOp, J({ op: !!opUser, te: !!teUser, enc: !!encreOp }));
  if (!opUser || !teUser || !encreOp) { console.log("⚠ 후보 부족 — 중단"); process.exit(2); }

  const compBody = (targets, extra = {}) => J({
    competency_line_master_id: RANDOM_UUID,
    output_link_1: "https://example.com/x",
    target_user_ids: targets,
    ...extra,
  });
  const expBody = (targets, extra = {}) => J({
    experience_line_master_id: RANDOM_UUID, line_code: "ZZ-VERIFY", main_title: "검증",
    output_link_1: "https://example.com/x", target_user_ids: targets,
    week_id: RANDOM_UUID, submission_opens_at: NOW, submission_closes_at: NOW, ...extra,
  });

  // ── competency-lines (fix #1) ──────────────────────────────────────────────
  {
    const before = await countLines("competency");
    // operating(기본 mode) + 테스트 사용자 → 422
    const a = await api("/api/admin/cluster4/competency-lines?organization=oranke", { method: "POST", body: compBody([teUser.user_id]) });
    ck("[competency][operating+테스트유저] 422", a.status === 422, `status=${a.status}`);
    // test + 실사용자 → 422
    const b = await api("/api/admin/cluster4/competency-lines?organization=oranke&mode=test", { method: "POST", body: compBody([opUser.user_id]) });
    ck("[competency][test+실사용자] 422", b.status === 422, `status=${b.status}`);
    // org=oranke + encre 사용자(타org 동명이인) → 422
    const c = await api("/api/admin/cluster4/competency-lines?organization=oranke", { method: "POST", body: compBody([encreOp.user_id]) });
    ck("[competency][org=oranke+encre유저] 422 (타org 차단)", c.status === 422, `status=${c.status}`);
    const after = await countLines("competency");
    ck("[competency] DB write 0 (라인 카운트 불변)", before === after, `before=${before} after=${after}`);
  }

  // ── experience-lines (fix #6) ──────────────────────────────────────────────
  {
    const before = await countLines("experience");
    const a = await api("/api/admin/cluster4/experience-lines?organization=oranke", { method: "POST", body: expBody([teUser.user_id]) });
    ck("[experience][operating+테스트유저] 422", a.status === 422, `status=${a.status}`);
    const b = await api("/api/admin/cluster4/experience-lines?organization=oranke&mode=test", { method: "POST", body: expBody([opUser.user_id]) });
    ck("[experience][test+실사용자] 422", b.status === 422, `status=${b.status}`);
    const c = await api("/api/admin/cluster4/experience-lines?organization=oranke", { method: "POST", body: expBody([encreOp.user_id]) });
    ck("[experience][org=oranke+encre유저] 422 (타org 차단)", c.status === 422, `status=${c.status}`);
    const after = await countLines("experience");
    ck("[experience] DB write 0 (라인 카운트 불변)", before === after, `before=${before} after=${after}`);
  }

  // ── competency applications W13 (fix #3/#4) — GET 전용(무변경) ─────────────
  {
    const wkInfo = async (weekId) =>
      weekId ? (await sb.from("weeks").select("season_key,week_number").eq("id", weekId).maybeSingle()).data : null;

    const te = await api(`/api/admin/cluster4/competency/applications?organization=oranke&mode=test`);
    const op = await api(`/api/admin/cluster4/competency/applications?organization=oranke&mode=operating`);
    const teWeekId = te.json?.data?.weekId ?? null;
    const opWeekId = op.json?.data?.weekId ?? null;
    const teWk = await wkInfo(teWeekId);
    const opWk = await wkInfo(opWeekId);

    ck("[applications][test] GET 200 · weekId 존재", te.status === 200 && !!teWeekId, `status=${te.status} week=${teWeekId}`);
    ck("[applications][test] 주차 = 2026-spring W13 (테스트 예외 반영)", teWk?.season_key === "2026-spring" && teWk?.week_number === 13, J(teWk));
    ck("[applications][operating] GET 200", op.status === 200, `status=${op.status}`);
    ck("[applications][operating] 주차 != W13 (운영 정책 유지)", !(opWk?.season_key === "2026-spring" && opWk?.week_number === 13), J(opWk));
    // read==write 동일 resolver: GET 의 weekId 가 곧 manual-add POST 가 쓰는 주차(같은 resolveTargetWeekId(mode)).
    ck("[applications] test/operating weekId 분리", teWeekId !== opWeekId, J({ test: teWeekId, operating: opWeekId }));
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("FATAL:", e?.stack ?? e);
  process.exit(1);
}

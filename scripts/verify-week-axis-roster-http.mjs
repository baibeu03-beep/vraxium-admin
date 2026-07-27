// 화면 주차 축 정합 검증 (실제 HTTP · GET only) — 2026-07-27
//
//   node --dns-result-order=ipv4first scripts/verify-week-axis-roster-http.mjs
//
// 대상 4화면이 **같은 (org, team, mode, weekId)** 로스터를 쓰는지 확인한다.
//   ① 프로세스 체크 보드      /api/admin/processes/check            (teamParts + 파트별 selectedPart.crewCount)
//   ② 실무 경험 파트 입력      /api/admin/cluster4/experience/part-input   (parts + 파트별 crews)
//   ③ 실무 경험 팀 총괄        /api/admin/cluster4/experience/team-overall (parts[].crews)
//   ④ 라인 개설 코호트         /api/admin/team-parts/info/weeks/[weekId]/line-opening-management
//
// 회귀 방지 핵심: **과거 주차에 현재 주차 override 가 소급 적용되지 않는다.**
//   encre 비주얼랩(T) 는 2026-07-20 부터 파트장 override 가 걸려 있다.
//   → 07-13/07-06/06-29 로스터에는 e1a17a4a·36138fb1 이 평가 대상으로 **포함**되고,
//     role=part_leader 인 fff3941f·98807fea 는 **제외**되어야 한다(조사 결과와 동일).
//
// 데이터 변경 없음(GET only).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const req = createRequire(resolve(root, "package.json"));
const { createClient } = req("@supabase/supabase-js");
const { createServerClient } = req("@supabase/ssr");
const env = readFileSync(resolve(root, ".env.local"), "utf8");
const g = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const SUPABASE_URL = g("NEXT_PUBLIC_SUPABASE_URL");
const ANON = g("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const sb = createClient(SUPABASE_URL, g("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const ORG = "encre";
const TEAM = "비주얼랩(T)";
// 조사에서 확인된 기대 집합(과거 주차 = override 미적용 시점).
const PAST_INCLUDE = ["e1a17a4a", "36138fb1"]; // 현재는 파트장 override, 과거엔 일반 → 평가 대상
const PAST_EXCLUDE = ["fff3941f", "98807fea"]; // role=part_leader·심화 → 항상 평가 대상 아님

let pass = 0, fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };
const J = (v) => JSON.stringify(v);
const short = (a) => a.map((x) => x.slice(0, 8)).sort();

const { data: adm } = await sb.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
const b = createClient(SUPABASE_URL, ANON);
const { data: l } = await sb.auth.admin.generateLink({ type: "magiclink", email: adm[0].email });
const { data: v } = await b.auth.verifyOtp({ email: adm[0].email, token: l.properties.email_otp, type: "magiclink" });
const cap = [];
const srv = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const COOKIE = cap.map((i) => `${i.name}=${i.value}`).join("; ");
console.log(`admin = ${adm[0].email}`);

const api = async (p) => {
  const r = await fetch(`${BASE}${p}`, { headers: { cookie: COOKIE }, cache: "no-store" });
  let j = null; try { j = await r.json(); } catch { /* */ }
  return { status: r.status, json: j };
};

const { data: team } = await sb.from("cluster4_teams").select("id").eq("team_name", TEAM).limit(1).maybeSingle();
const TEAM_ID = team.id;
const { data: mk } = await sb.from("test_user_markers").select("user_id").limit(1);
const ACT_AS = mk?.[0]?.user_id ?? null;
const PATHS = [
  { label: "operating", q: "" },
  { label: "test", q: "&mode=test" },
  ...(ACT_AS ? [{ label: "test+actAs", q: `&mode=test&actAsTestUserId=${ACT_AS}` }] : []),
];

// 대상 주차 = 현재 주차 + 조사에서 차이가 재현된 3개 과거 주차.
const TARGET_STARTS = ["2026-07-13", "2026-07-06", "2026-06-29"];
const { data: weekRows } = await sb.from("weeks").select("id,start_date,week_number").in("start_date", TARGET_STARTS);
const { data: curRow } = await sb
  .from("weeks").select("id,start_date")
  .lte("start_date", new Date().toISOString().slice(0, 10))
  .order("start_date", { ascending: false }).limit(1).maybeSingle();
const WEEKS = [
  { id: curRow.id, start: curRow.start_date, label: "현재 주차" },
  ...TARGET_STARTS.map((s) => {
    const w = (weekRows ?? []).find((x) => x.start_date === s);
    return w ? { id: w.id, start: s, label: `과거 ${s}` } : null;
  }).filter(Boolean),
];
console.log(`fixture = [${ORG}] ${TEAM} teamId=${TEAM_ID} actAs=${ACT_AS ?? "-"}`);
console.log(`주차 = ${J(WEEKS.map((w) => w.label))}\n`);

// ── 화면별 로스터 수집기 ─────────────────────────────────────────────────
async function checkBoard(weekId, q) {
  const r = await api(`/api/admin/processes/check?hub=experience&org=${ORG}&team=${TEAM_ID}&week=${weekId}${q}`);
  const parts = r.json?.data?.teamParts ?? [];
  const perPart = {};
  for (const p of parts) {
    const rp = await api(`/api/admin/processes/check?hub=experience&org=${ORG}&team=${TEAM_ID}&week=${weekId}&scope=part&part=${encodeURIComponent(p)}${q}`);
    perPart[p] = rp.json?.data?.selectedPart?.crewCount ?? null;
  }
  return { status: r.status, parts, perPart, keys: Object.keys(r.json?.data ?? {}) };
}
async function partInput(weekId, q) {
  const r = await api(`/api/admin/cluster4/experience/part-input?organization=${ORG}&team_id=${TEAM_ID}&team_name=${encodeURIComponent(TEAM)}&week_id=${weekId}${q}`);
  const parts = r.json?.data?.parts ?? [];
  const byPart = {};
  const all = [];
  for (const p of parts) {
    const rp = await api(`/api/admin/cluster4/experience/part-input?organization=${ORG}&team_id=${TEAM_ID}&team_name=${encodeURIComponent(TEAM)}&week_id=${weekId}&part=${encodeURIComponent(p)}${q}`);
    const ids = (rp.json?.data?.crews ?? []).map((c) => c.userId);
    byPart[p] = ids.sort();
    all.push(...ids);
  }
  return { status: r.status, parts, byPart, all: all.sort(), keys: Object.keys(r.json?.data ?? {}), actor: r.json?.data?.actor ?? null };
}
async function overall(weekId, q) {
  const r = await api(`/api/admin/cluster4/experience/team-overall?organization=${ORG}&week_id=${weekId}&team_id=${TEAM_ID}&team_name=${encodeURIComponent(TEAM)}${q}`);
  const parts = r.json?.data?.parts ?? [];
  const nonLeader = [];
  const leaders = [];
  for (const p of parts) for (const c of p.crews ?? []) (c.isPartLeader ? leaders : nonLeader).push(c.userId);
  return {
    status: r.status,
    parts: parts.map((p) => p.partName),
    nonLeader: nonLeader.sort(),
    leaders: leaders.sort(),
    keys: Object.keys(r.json?.data ?? {}),
  };
}
async function cohort(weekId, q) {
  // ⚠ 이 라우트의 조직 파라미터는 organization 이 아니라 **club** 이다(400 주의).
  const r = await api(`/api/admin/team-parts/info/weeks/${weekId}/line-opening-management?club=${ORG}${q}`);
  const d = r.json?.data;
  const expTeams = d?.practicalExperience?.teams ?? [];
  const t = expTeams.find((x) => x.teamName === TEAM) ?? null;
  // 코호트 모수 = 관리 라인이 아닌 라인의 eligibleCrewCount(관리 라인은 심화 크루만이라 모수가 다름).
  const line = (t?.lines ?? []).find((x) => x.eligibleCrewCount != null && !/관리/.test(x.lineName ?? "")) ?? null;
  return { status: r.status, eligible: line?.eligibleCrewCount ?? null, keys: Object.keys(d ?? {}) };
}

// ── 검증 ────────────────────────────────────────────────────────────────
const dtoKeys = { check: new Set(), part: new Set(), overall: new Set(), cohort: new Set() };
for (const w of WEEKS) {
  console.log(`\n═══ ${w.label} (${w.start}) ═══`);
  const perPathPart = [];
  const perPathCheck = [];
  for (const p of PATHS) {
    const [cb, pi, ov, co] = await Promise.all([
      checkBoard(w.id, p.q), partInput(w.id, p.q), overall(w.id, p.q), cohort(w.id, p.q),
    ]);
    dtoKeys.check.add(J(cb.keys)); dtoKeys.part.add(J(pi.keys));
    dtoKeys.overall.add(J(ov.keys)); dtoKeys.cohort.add(J(co.keys));
    console.log(
      `  [${p.label}] 체크 parts=${J(cb.parts)} 크루수=${J(cb.perPart)}\n` +
      `             경험 parts=${J(pi.parts)} 크루=${J(short(pi.all))}\n` +
      `             총괄 평가대상=${J(short(ov.nonLeader))} 파트장=${J(short(ov.leaders))} / 코호트 모수=${co.eligible}`,
    );
    ck(`[${w.label}/${p.label}] 4화면 200`, cb.status === 200 && pi.status === 200 && ov.status === 200 && co.status === 200,
      `${cb.status}/${pi.status}/${ov.status}/${co.status}`);

    // ① 파트 목록과 파트별 크루가 같은 weekId — 체크 파트별 크루수 == 경험 파트별 크루수
    for (const part of pi.parts) {
      ck(`[${w.label}/${p.label}] '${part}' 체크 crewCount == 경험 crews`, cb.perPart[part] === pi.byPart[part].length,
        `${cb.perPart[part]} vs ${pi.byPart[part].length}`);
    }
    // 경험 평가 대상 == 팀총괄 비-파트장
    ck(`[${w.label}/${p.label}] 경험 평가대상 == 총괄 비파트장`, J(short(pi.all)) === J(short(ov.nonLeader)),
      `${J(short(pi.all))} vs ${J(short(ov.nonLeader))}`);
    // 코호트 모수 == 총괄 전체(평가대상 + 파트장)
    ck(`[${w.label}/${p.label}] 코호트 모수 == 총괄 크루 총원`, co.eligible === ov.nonLeader.length + ov.leaders.length,
      `${co.eligible} vs ${ov.nonLeader.length + ov.leaders.length}`);

    perPathPart.push(J({ parts: pi.parts, byPart: pi.byPart }));
    perPathCheck.push(J({ parts: cb.parts, perPart: cb.perPart }));
  }
  ck(`[${w.label}] 경험 3경로 동일(actor 제외)`, new Set(perPathPart).size === 1);
  ck(`[${w.label}] 체크 3경로 동일`, new Set(perPathCheck).size === 1);

  // ② 과거 주차에 현재 override 소급 금지
  if (w.label.startsWith("과거")) {
    const pi = await partInput(w.id, "&mode=test");
    const ids = short(pi.all);
    for (const u of PAST_INCLUDE) ck(`[${w.label}] 과거엔 일반이던 ${u} 포함(override 미소급)`, ids.includes(u), J(ids));
    for (const u of PAST_EXCLUDE) ck(`[${w.label}] 파트장 ${u} 제외`, !ids.includes(u), J(ids));
  }
}

console.log("\n═══ DTO 키 불변 ═══");
ck("체크 보드 DTO 키 단일", dtoKeys.check.size === 1);
ck("part-input DTO 키 단일", dtoKeys.part.size === 1, [...dtoKeys.part][0]);
ck("team-overall DTO 키 단일", dtoKeys.overall.size === 1);
ck("line-opening-management DTO 키 단일", dtoKeys.cohort.size === 1);

console.log(`\n== PASS ${pass} / FAIL ${fail} ==`);
process.exit(fail > 0 ? 1 : 0);

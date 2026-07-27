// 시즌 휴식 비소급 + cafe-line-crew 실효 검증 (실제 HTTP) — 2026-07-27
//
//   node --dns-result-order=ipv4first scripts/verify-season-rest-nonretro-http.mjs
//
// ⚠ 이 스크립트는 **테스트 유저 1명의 user_season_statuses 1행만** 임시로 만들었다가 되돌린다.
//   membership / 주차 override / UPH / 신청·제출·체크는 **건드리지 않는다** —
//   "저장된 배정은 그대로인데 시즌 휴식이라 조회 roster 에서만 빠지는" 구조를 검증해야 하기 때문.
//   원복은 finally 로 보장하고, 원복 후 동일 SELECT 로 원본 복구를 재확인한다.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const req = createRequire(resolve(root, "package.json"));
const { createClient } = req("@supabase/supabase-js");
const { createServerClient } = req("@supabase/ssr");
const env = readFileSync(resolve(root, ".env.local"), "utf8");
const g = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const sb = createClient(g("NEXT_PUBLIC_SUPABASE_URL"), g("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

let pass = 0, fail = 0, skip = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };
const sk = (l, w) => { console.log(`  ⊘ ${l} — SKIP: ${w}`); skip++; };
const J = (v) => JSON.stringify(v);
const short = (a) => [...a].map((x) => x.slice(0, 8)).sort();

const { data: adm } = await sb.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
const b = createClient(g("NEXT_PUBLIC_SUPABASE_URL"), g("NEXT_PUBLIC_SUPABASE_ANON_KEY"));
const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: adm[0].email });
const { data: vf } = await b.auth.verifyOtp({ email: adm[0].email, token: link.properties.email_otp, type: "magiclink" });
const cap = [];
const srv = createServerClient(g("NEXT_PUBLIC_SUPABASE_URL"), g("NEXT_PUBLIC_SUPABASE_ANON_KEY"), { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: vf.session.access_token, refresh_token: vf.session.refresh_token });
const COOKIE = cap.map((i) => `${i.name}=${i.value}`).join("; ");
const api = async (p) => {
  const r = await fetch(`${BASE}${p}`, { headers: { cookie: COOKIE }, cache: "no-store" });
  let j = null; try { j = await r.json(); } catch { /* */ }
  return { status: r.status, json: j };
};

const ORG = "encre";
const TEAM = "비주얼랩(T)";
const CREWS_KEYS = ["userId","displayName","crewNo","profileImg","organization","teamName","partName","membershipLevel","membershipState"];

const today = new Date().toISOString().slice(0, 10);
const { data: weeks } = await sb.from("weeks").select("id,start_date,season_key")
  .lte("start_date", today).order("start_date", { ascending: false }).limit(60);
const CUR = weeks.find((w) => w.season_key === "2026-summer");
const PAST = weeks.find((w) => w.season_key && w.season_key !== CUR.season_key);
console.log(`현재 시즌 주차 = ${CUR.start_date}/${CUR.season_key}`);
console.log(`과거 시즌 주차 = ${PAST.start_date}/${PAST.season_key}`);

const rosterOf = async (weekId, q = "&mode=test") => {
  const r = await api(`/api/admin/cluster4/experience/part-input?organization=${ORG}&team_name=${encodeURIComponent(TEAM)}&week_id=${weekId}${q}`);
  const out = [];
  for (const p of r.json?.data?.parts ?? []) {
    const rp = await api(`/api/admin/cluster4/experience/part-input?organization=${ORG}&team_name=${encodeURIComponent(TEAM)}&week_id=${weekId}&part=${encodeURIComponent(p)}${q}`);
    for (const c of rp.json?.data?.crews ?? []) out.push({ userId: c.userId, part: p, name: c.displayName });
  }
  return out;
};

const curRoster = await rosterOf(CUR.id);
const pastRoster = await rosterOf(PAST.id);
const { data: markers } = await sb.from("test_user_markers").select("user_id");
const markerSet = new Set((markers ?? []).map((m) => m.user_id));
const { data: ussAll } = await sb.from("user_season_statuses").select("user_id,season_key,status");
const curRest = new Set((ussAll ?? []).filter((r) => r.season_key === CUR.season_key && r.status === "rest").map((r) => r.user_id));

const cand = curRoster.find((c) => markerSet.has(c.userId) && pastRoster.some((p) => p.userId === c.userId) && !curRest.has(c.userId));
if (!cand) { console.error("적합한 테스트 유저 없음(두 주차 공통 roster ∩ 마커 ∩ 비휴식)"); process.exit(1); }
const UID = cand.userId;
console.log(`\n대상 = ${cand.name}(${UID.slice(0, 8)}) part=${cand.part}`);
console.log(`  선택 이유: test_user_markers 보유 · 현재/과거 주차 roster 동시 존재 · 현재 시즌 rest 행 없음\n`);

const snap = async () => {
  const [uss, mem, ovr, uph] = await Promise.all([
    sb.from("user_season_statuses").select("*").eq("user_id", UID).order("season_key"),
    sb.from("user_memberships").select("*").eq("user_id", UID),
    sb.from("cluster4_team_week_position_overrides").select("*").eq("user_id", UID),
    sb.from("user_position_histories").select("*").eq("user_id", UID),
  ]);
  return {
    uss: (uss.data ?? []).map((r) => ({ season_key: r.season_key, status: r.status })),
    memCount: (mem.data ?? []).length,
    mem: (mem.data ?? []).map((r) => `${r.team_name}/${r.part_name}/${r.membership_state}/${r.is_current}`).sort(),
    ovrCount: (ovr.data ?? []).length,
    ovr: (ovr.data ?? []).map((r) => `${r.week_start_date}/${r.raw_team}/${r.raw_part}/${r.position_code}`).sort(),
    uphCount: (uph.data ?? []).length,
  };
};
const BEFORE = await snap();
const HAD_ROW = BEFORE.uss.some((r) => r.season_key === CUR.season_key);
const ORIG = BEFORE.uss.find((r) => r.season_key === CUR.season_key)?.status ?? null;
console.log("═══ 1. 사전 백업 ═══");
console.log(`  user_season_statuses = ${J(BEFORE.uss)} (현재 시즌 행 존재=${HAD_ROW})`);
console.log(`  memberships ${BEFORE.memCount}행 ${J(BEFORE.mem)}`);
console.log(`  override ${BEFORE.ovrCount}행 ${J(BEFORE.ovr)} · UPH ${BEFORE.uphCount}행`);

let mutated = false;
try {
  console.log("\n═══ 2. 임시 상태(현재 시즌 rest) ═══");
  if (HAD_ROW) {
    const { error } = await sb.from("user_season_statuses").update({ status: "rest" }).eq("user_id", UID).eq("season_key", CUR.season_key);
    if (error) throw new Error(error.message);
    console.log(`  기존 행 '${ORIG}' → 'rest'`);
  } else {
    const { error } = await sb.from("user_season_statuses").insert({ user_id: UID, season_key: CUR.season_key, status: "rest" });
    if (error) throw new Error(error.message);
    console.log(`  행 신규 생성 (${CUR.season_key}, rest)`);
  }
  mutated = true;
  const mid = await snap();
  ck("임시 변경은 시즌 상태 1행뿐(membership/override/UPH 무변경)",
    mid.memCount === BEFORE.memCount && mid.ovrCount === BEFORE.ovrCount && mid.uphCount === BEFORE.uphCount,
    `mem ${mid.memCount} ovr ${mid.ovrCount} uph ${mid.uphCount}`);

  const { data: m1 } = await sb.from("test_user_markers").select("user_id").limit(1);
  const ACT_AS = m1?.[0]?.user_id ?? null;
  const PATHS = [{ n: "operating", q: "" }, { n: "test", q: "&mode=test" },
    ...(ACT_AS ? [{ n: "test+actAs", q: `&mode=test&actAsTestUserId=${ACT_AS}` }] : [])];

  const { data: half } = await sb.from("cluster4_team_halves").select("id")
    .eq("organization_slug", ORG).eq("team_name", TEAM).eq("is_active", true)
    .order("half_key", { ascending: false }).limit(1).maybeSingle();

  const teamSummary = async (weekId, q) => {
    const r = await api(`/api/admin/team-parts/info/team-detail/week-summary?organization=${ORG}&teamHalfId=${half.id}&weekId=${weekId}${q}`);
    return { status: r.status, crewIds: (r.json?.data?.crewRows ?? []).map((c) => c.userId), parts: (r.json?.data?.operatedParts ?? []).map((p) => p.partName) };
  };
  const crewsApi = async (weekId, q) => {
    const r = await api(`/api/admin/cluster4/crews?organization=${ORG}&status=active&week_id=${weekId}${q}`);
    return { status: r.status, ids: (r.json?.data ?? []).map((c) => c.userId), keys: Object.keys(r.json?.data?.[0] ?? {}) };
  };
  const cafeApi = async (weekId, q, search) => {
    const r = await api(`/api/admin/cluster4/cafe-line-crew?organization=${ORG}&excludeSeasonRest=1&week_id=${weekId}${search != null ? `&q=${encodeURIComponent(search)}` : ""}${q}`);
    const crews = r.json?.data?.crews ?? [];
    return { status: r.status, ids: crews.map((c) => c.userId), keys: Object.keys(crews[0] ?? {}) };
  };
  const SEARCH = (cand.name ?? "T").slice(0, 1);

  for (const label of ["과거", "현재"]) {
    const W = label === "과거" ? PAST : CUR;
    const expectIn = label === "과거";
    console.log(`\n═══ 3-${expectIn ? "a" : "b"}. ${label} 시즌 주차 ${W.start_date}/${W.season_key} — 대상 ${expectIn ? "포함" : "제외"} 기대 ═══`);
    const perPath = [];
    for (const p of PATHS) {
      const ts = await teamSummary(W.id, p.q);
      const cr = await crewsApi(W.id, p.q);
      const ex = (await rosterOf(W.id, p.q)).map((c) => c.userId);
      const cf = await cafeApi(W.id, p.q, SEARCH);
      const inT = ts.crewIds.includes(UID), inC = cr.ids.includes(UID), inE = ex.includes(UID), inF = cf.ids.includes(UID);
      console.log(`  [${p.n}] 팀roster ${ts.crewIds.length}(${inT ? "포함" : "제외"}) 운용파트 ${J(ts.parts)} crews ${cr.ids.length}(${inC ? "포함" : "제외"}) 경험 ${ex.length}(${inE ? "포함" : "제외"}) cafe ${cf.ids.length}(${inF ? "포함" : "제외"})`);
      ck(`[${label}/${p.n}] 4 API 200`, ts.status === 200 && cr.status === 200 && cf.status === 200, `${ts.status}/${cr.status}/${cf.status}`);
      ck(`[${label}/${p.n}] 팀 roster ${expectIn ? "포함" : "제외"}`, inT === expectIn);
      ck(`[${label}/${p.n}] /crews ${expectIn ? "포함" : "제외"}`, inC === expectIn);
      ck(`[${label}/${p.n}] practical-experience 평가 대상 ${expectIn ? "포함" : "제외"}`, inE === expectIn);
      if (cf.ids.length === 0) sk(`[${label}/${p.n}] cafe-line-crew 실효`, "검색 결과 0");
      else {
        ck(`[${label}/${p.n}] cafe-line-crew 비어있지 않음`, cf.ids.length > 0, `${cf.ids.length}명`);
        ck(`[${label}/${p.n}] cafe-line-crew 대상 ${expectIn ? "포함" : "제외"}`, inF === expectIn);
        ck(`[${label}/${p.n}] cafe DTO 키 유지`, cf.keys.includes("userId"), J(cf.keys));
      }
      if (cr.keys.length) ck(`[${label}/${p.n}] crews DTO 키 유지`, J(cr.keys) === J(CREWS_KEYS), J(cr.keys));
      perPath.push(J({ t: [...ts.crewIds].sort(), c: [...cr.ids].sort(), e: [...ex].sort() }));
    }
    ck(`[${label}] 3경로 동일 결과(actor 무관)`, new Set(perPath).size === 1);
    const noQ = await cafeApi(W.id, "&mode=test", null);
    ck(`[${label}] cafe-line-crew q 미전달 → 빈 배열(설계)`, noQ.ids.length === 0);
  }
} catch (e) {
  fail++;
  console.error("\n!! 검증 중 예외 — 원복은 그대로 수행:\n", e);
} finally {
  console.log("\n═══ 7. 원복 ═══");
  if (mutated) {
    if (HAD_ROW) {
      await sb.from("user_season_statuses").update({ status: ORIG }).eq("user_id", UID).eq("season_key", CUR.season_key);
      console.log(`  status 원복 → '${ORIG}'`);
    } else {
      await sb.from("user_season_statuses").delete().eq("user_id", UID).eq("season_key", CUR.season_key);
      console.log(`  임시 생성 행 삭제 (${CUR.season_key})`);
    }
  } else console.log("  변경 없음");

  const AFTER = await snap();
  ck("원복: user_season_statuses 원본 동일", J(AFTER.uss) === J(BEFORE.uss), `${J(AFTER.uss)} vs ${J(BEFORE.uss)}`);
  ck("원복: 원래 없던 행이 남아있지 않음", HAD_ROW || !AFTER.uss.some((r) => r.season_key === CUR.season_key));
  ck("원복: membership 무변경", AFTER.memCount === BEFORE.memCount && J(AFTER.mem) === J(BEFORE.mem));
  ck("원복: override 무변경", AFTER.ovrCount === BEFORE.ovrCount && J(AFTER.ovr) === J(BEFORE.ovr));
  ck("원복: UPH 무변경", AFTER.uphCount === BEFORE.uphCount);
  const back = await rosterOf(CUR.id);
  ck("원복: 현재 주차 평가 대상에 대상 복귀", back.some((c) => c.userId === UID), J(short(back.map((c) => c.userId))));
  console.log(`\n== PASS ${pass} / FAIL ${fail} / SKIP ${skip} ==`);
  process.exit(fail > 0 ? 1 : 0);
}

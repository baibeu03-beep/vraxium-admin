// 모집단 자격(eligibility) 정책 검증 — 실 HTTP (2026-07-27)
//
//   node --dns-result-order=ipv4first scripts/verify-evaluation-eligibility-http.mjs
//
// 정책(집합 2종)
//   ① 팀·파트 활동 가능 = 전체 − 시즌 휴식 − (효력 발생 후) 활동 중단
//        → 엘리트·바사노스는 **남는다**(소속·평가자/운영자 역할 유지)
//   ② 실무 평가 가능   = ① − 엘리트 − 바사노스 (− 평가자 전용 역할: 실무 경험 파트장)
//
// 상태별 표본을 뽑아 화면·DTO 별 포함/제외를 **userId 기준**으로 대조한다.
//   · /admin/members            clubbing_expand / clubbing_reduce
//   · team-parts week-summary   crewRows(팀 소속) · operatedParts(운용 파트 인원)
//   · 실무 경험 part-input      parts(드롭다운) · crews(평가 대상) · cells
//   · 실무 경험 team-overall    parts[].crews(보드 행) · application(신청 대상)
//   · 실무 정보/역량 후보       /api/admin/cluster4/crews · cafe-line-crew(평가 모집단 opt-in)
//   · 체크 스코프 / Point C     /api/admin/processes/check (targets · roster)
//
// 읽기 전용(GET only). 상태를 바꾸지 않는다.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const requireAdmin = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = requireAdmin("@supabase/supabase-js");
const { createServerClient } = requireAdmin("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const SUPABASE_URL = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const sb = createClient(SUPABASE_URL, get("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

let pass = 0;
let fail = 0;
const failures = [];
const ck = (label, ok, detail = "") => {
  console.log(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else { fail++; failures.push(label); }
};
const J = (v) => JSON.stringify(v);
const setEq = (a, b) => J([...a].sort()) === J([...b].sort());

let COOKIE = "";
async function makeAdminCookie() {
  const { data: adm } = await sb.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? adm?.[0]?.email;
  const b = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await sb.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: v } = await b.auth.verifyOtp({ email: adminEmail, token: linkData.properties.email_otp, type: "magiclink" });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (i) => captured.push(...i) } });
  await server.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  console.log(`admin = ${adminEmail}`);
  return captured.map((i) => `${i.name}=${i.value}`).join("; ");
}
async function api(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie: COOKIE } });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

// 상태 표본 — (표시명, 기대 상태). 팀·파트 배정 보유자로 고른다.
const SAMPLES = [
  { label: "정상 활동", name: "T김건우", org: "encre", team: "비주얼랩(T)", teamActive: true, evaluable: true },
  { label: "시즌 휴식", name: "T조수빈", org: "encre", team: "비주얼랩(T)", teamActive: false, evaluable: false },
  { label: "활동 중단", name: "T고수림", org: "oranke", team: "콘텐츠실험(T)", teamActive: false, evaluable: false },
  { label: "엘리트", name: "T이보영", org: "encre", team: "비주얼랩(T)", teamActive: true, evaluable: false },
  { label: "바사노스", name: "T장시현", org: "phalanx", team: "운영(T)", teamActive: true, evaluable: false },
];

void (async () => {
  COOKIE = await makeAdminCookie();

  for (const s of SAMPLES) {
    const { data: p } = await sb
      .from("user_profiles").select("user_id,growth_status,current_part_name").eq("display_name", s.name).maybeSingle();
    if (!p) { console.log(`\n■ ${s.label} ${s.name} — 프로필 없음(SKIP)`); continue; }
    const uid = p.user_id;
    console.log(`\n■ ${s.label} — ${s.name}(${uid.slice(0, 8)}) growth_status=${p.growth_status}`);
    console.log(`   기대: 팀·파트 활동가능=${s.teamActive} / 실무 평가가능=${s.evaluable}`);

    // /admin/members
    const inFilter = async (f) => {
      const r = await api(`/api/admin/members/roster?organization=${s.org}&mode=test&page=1&pageSize=200&filter=${f}`);
      return (r.json?.data?.members ?? []).some((m) => m.userId === uid);
    };
    const expand = await inFilter("clubbing_expand");
    const reduce = await inFilter("clubbing_reduce");
    console.log(`   /admin/members  확대=${expand} 축소=${reduce}`);
    ck(`${s.label}: 클러빙_축소는 평가 가능자만`, reduce === s.evaluable || (!s.evaluable && !reduce));

    // team-parts
    const { data: half } = await sb.from("cluster4_team_halves").select("id")
      .eq("organization_slug", s.org).eq("team_name", s.team).eq("is_active", true)
      .order("half_key", { ascending: false }).limit(1).maybeSingle();
    const tp = await api(`/api/admin/team-parts/info/team-detail/week-summary?organization=${s.org}&teamHalfId=${half?.id}&mode=test`);
    const crewRows = tp.json?.data?.crewRows ?? [];
    const row = crewRows.find((c) => c.userId === uid);
    const opParts = (tp.json?.data?.operatedParts ?? []).map((x) => x.partName);
    const weekId = tp.json?.data?.week?.weekId;
    ck(`${s.label}: team-parts 팀 소속 = ${s.teamActive}`, Boolean(row) === s.teamActive, `실제=${Boolean(row)} 파트='${row?.rawPart ?? "-"}'`);
    ck(`${s.label}: 운용 파트 인원 포함 = ${s.teamActive}`,
      (row ? opParts.includes((row.rawPart ?? "").trim()) : false) === s.teamActive);

    // 실무 경험 — parts/crews/cells
    const teamsRes = await api(`/api/admin/cluster4/teams?organization=${s.org}&mode=test`);
    const tid = (teamsRes.json?.data ?? []).find((t) => t.teamName === s.team)?.id;
    const part = row?.rawPart ?? p.current_part_name ?? "";
    const exp = await api(`/api/admin/cluster4/experience/part-input?organization=${s.org}&team_id=${tid}&team_name=${encodeURIComponent(s.team)}&week_id=${weekId}&part=${encodeURIComponent(part)}&mode=test`);
    const expCrews = (exp.json?.data?.crews ?? []).map((c) => c.userId);
    const expCells = (exp.json?.data?.cells ?? []).map((c) => c.crewUserId);
    ck(`${s.label}: 실무 경험 crews = ${s.evaluable}`, expCrews.includes(uid) === s.evaluable, `crews=${expCrews.length}`);
    ck(`${s.label}: 실무 경험 cells 에 미포함(평가 제외자)`, s.evaluable || !expCells.includes(uid));

    // 실무 경험 팀 총괄 보드 — 평가 제외자라도 파트장이면 행 유지.
    const ov = await api(`/api/admin/cluster4/experience/team-overall?organization=${s.org}&week_id=${weekId}&team_id=${tid}&team_name=${encodeURIComponent(s.team)}&mode=test`);
    const boardCrews = (ov.json?.data?.parts ?? []).flatMap((x) => (x.crews ?? []));
    const boardRow = boardCrews.find((c) => c.userId === uid);
    const expectBoard = s.evaluable || Boolean(boardRow?.isPartLeader);
    ck(`${s.label}: 팀 총괄 보드 행 = ${expectBoard}`, Boolean(boardRow) === expectBoard,
      `실제=${Boolean(boardRow)} 파트장=${Boolean(boardRow?.isPartLeader)}`);

    // 실무 정보/역량 후보
    const crewsApi = await api(`/api/admin/cluster4/crews?organization=${s.org}&status=active&mode=test&week_id=${weekId}`);
    ck(`${s.label}: 라인 개설 후보(crews API) = ${s.evaluable}`,
      (crewsApi.json?.data ?? []).some((c) => c.userId === uid) === s.evaluable);

    const picker = await api(`/api/admin/cluster4/cafe-line-crew?organization=${s.org}&mode=test&q=${encodeURIComponent(s.name)}&excludeSeasonRest=1&week_id=${weekId}`);
    ck(`${s.label}: 개설 피커(평가 모집단) = ${s.evaluable}`,
      (picker.json?.data?.crews ?? []).some((c) => c.userId === uid) === s.evaluable);
  }

  // ── 체크 스코프 / Point C 모집단 — 평가 제외자 전원 미포함 ────────────────
  console.log("\n■ 체크 스코프 / Point C 모집단(비팀 허브)");
  const { data: excluded } = await sb
    .from("user_profiles").select("user_id,display_name,growth_status,organization_slug")
    .in("growth_status", ["graduated", "suspended", "paused"]);
  for (const org of ["encre", "oranke", "phalanx"]) {
    const r = await api(`/api/admin/processes/check?hub=info&org=${org}&mode=test`);
    const ok = r.status === 200;
    const board = r.json?.data ?? null;
    const roster = new Set(
      (board?.acts ?? []).flatMap((a) => (a.completedCrewList ?? []).map((c) => c.userId ?? c)),
    );
    const leak = (excluded ?? []).filter((e) => e.organization_slug === org && roster.has(e.user_id));
    ck(`[info/${org}] 체크 보드 200 · 평가 제외자 누수 0`, ok && leak.length === 0,
      `status=${r.status} 누수=${J(leak.map((x) => x.display_name))}`);
  }

  // ── 3경로 파리티(operating / test / actAsTestUserId) ────────────────────────
  console.log("\n■ 3경로 파리티(모집단 함수·DTO 동일)");
  {
    const org = "encre";
    const team = "비주얼랩(T)";
    const teamsRes = await api(`/api/admin/cluster4/teams?organization=${org}&mode=test`);
    const tid = (teamsRes.json?.data ?? []).find((t) => t.teamName === team)?.id;
    const { data: half } = await sb.from("cluster4_team_halves").select("id")
      .eq("organization_slug", org).eq("team_name", team).eq("is_active", true)
      .order("half_key", { ascending: false }).limit(1).maybeSingle();
    const tp = await api(`/api/admin/team-parts/info/team-detail/week-summary?organization=${org}&teamHalfId=${half?.id}&mode=test`);
    const weekId = tp.json?.data?.week?.weekId;
    const { data: tu } = await sb.from("test_user_markers").select("user_id").limit(50);
    const { data: leaders } = await sb.from("user_profiles").select("user_id")
      .in("user_id", (tu ?? []).map((x) => x.user_id)).eq("role", "team_leader").limit(1);
    const actAs = (leaders ?? [])[0]?.user_id ?? null;
    const q = (m, a) => `/api/admin/cluster4/experience/part-input?organization=${org}&team_id=${tid}&team_name=${encodeURIComponent(team)}&week_id=${weekId}&part=${encodeURIComponent("아트")}${m === "test" ? "&mode=test" : ""}${a ? `&actAsTestUserId=${a}` : ""}`;
    const A = await api(q("operating", null));
    const B = await api(q("test", null));
    const C = actAs ? await api(q("test", actAs)) : B;
    const ids = (r) => (r.json?.data?.crews ?? []).map((c) => c.userId);
    ck("status 동일", A.status === B.status && B.status === C.status, `${A.status}/${B.status}/${C.status}`);
    ck("DTO 키 동일", J(Object.keys(A.json?.data ?? {})) === J(Object.keys(C.json?.data ?? {})));
    ck("parts 동일", setEq(A.json?.data?.parts ?? [], C.json?.data?.parts ?? []), J(A.json?.data?.parts));
    ck("crews userId 집합 동일", setEq(ids(A), ids(C)), `${J(ids(A))} / ${J(ids(C))}`);
    // demoUserId 는 무시되어야 한다(모집단 무영향).
    const D = await api(`${q("test", null)}&demoUserId=${actAs ?? ""}`);
    ck("demoUserId 무시(모집단 동일)", setEq(ids(B), ids(D)), `${J(ids(B))} / ${J(ids(D))}`);
  }

  console.log(`\n== PASS ${pass} / FAIL ${fail} ==`);
  if (fail > 0) {
    console.log(`실패:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
    process.exit(1);
  }
})();

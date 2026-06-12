// 프로세스 체크 [실무 경험 급] 섹션.1 팀 스코프 direct==HTTP 검증.
//   - GET board ?team=T : 선택 팀 기준 액트 상태/요약
//   - 팀별 상태 독립(team1 신청 ↔ team2 needed) · 신청/취소가 선택 팀에만 반영
//   - 로그 팀명 포함(섹션.0 전체 팀) · 섹션.0 board(no team) 고정 · info 회귀
// 전제: dev 서버 + 2026-06-12_process_check_v3_team_scope.sql 적용. net-zero(TAG 정리).
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
const HUB = "experience", ORG = "oranke", TAG = "ZZ-pchk-exp1";
const J = (o) => JSON.stringify(o);
const DAY = 86_400_000;

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
const findAct = (board, id) => (board.acts ?? []).find((a) => a.actId === id) ?? null;

async function cleanup() {
  const g = (await sb.from("process_line_groups").select("id").eq("hub", HUB).like("name", `${TAG}%`)).data ?? [];
  const ids = g.map((x) => x.id);
  if (ids.length) {
    const acts = (await sb.from("process_acts").select("id").in("line_group_id", ids)).data ?? [];
    const actIds = acts.map((x) => x.id);
    if (actIds.length) {
      await sb.from("process_check_logs").delete().in("act_id", actIds);
      await sb.from("process_check_statuses").delete().in("act_id", actIds);
      await sb.from("process_acts").delete().in("id", actIds);
    }
    await sb.from("process_line_groups").delete().in("id", ids);
  }
}

try {
  // 스키마 게이트(v3).
  const probe = await sb.from("process_check_statuses").select("team_id").limit(1);
  if (probe.error) {
    console.log(`⚠ v3 스키마 미적용(${probe.error.code}): ${probe.error.message}`);
    console.log("→ db/migrations/2026-06-12_process_check_v3_team_scope.sql 적용(+NOTIFY) 후 재실행.");
    process.exit(2);
  }
  await cleanup();

  // 팀 2개.
  const teams = (await sb.from("cluster4_teams").select("id,team_name").eq("organization_slug", ORG).eq("is_active", true).order("team_name", { ascending: true })).data ?? [];
  ck("[전제] oranke 팀 ≥2", teams.length >= 2, `teams=${teams.length}`);
  const T1 = teams[0], T2 = teams[1];

  // 시드 — experience 라인급 + 체크대상 액트.
  const cg = await api("/api/admin/processes/line-groups", { method: "POST", body: J({ hub: HUB, name: `${TAG} 라인급` }) });
  const groupId = cg.json.data?.id;
  const a1 = (await api("/api/admin/processes/acts", { method: "POST", body: J({
    line_group_id: groupId, hub: HUB, act_name: `${TAG} 시작알림`, duration_minutes: 10,
    occur_week: "N", occur_dow: 2, occur_time: "06:30", check_week: "N", check_dow: 3, check_time: "21:00",
    point_check: 1, point_advantage: 0, point_penalty: 0, cafe: "occur", check_target: "check", act_type: "required",
    overview: null, remarks: null,
  }) })).json.data;
  ck("시드 — experience 체크대상 액트", !!groupId && !!a1?.id);

  const board = (t) => api(`/api/admin/processes/check?hub=${HUB}&org=${ORG}${t ? `&team=${t}` : ""}`);
  const act = (teamId, action, extra = {}) => api("/api/admin/processes/check", { method: "POST", body: J({ hub: HUB, organization: ORG, act_id: a1.id, team_id: teamId, action, ...extra }) });
  const iso = (ms) => new Date(ms).toISOString();

  // 초기 — team1/team2 모두 needed.
  ck("[초기] team1/team2 모두 needed", findAct((await board(T1.id)).json.data, a1.id)?.status === "needed" && findAct((await board(T2.id)).json.data, a1.id)?.status === "needed");

  // team1 신청.
  const req1 = await act(T1.id, "request", { review_link: "https://cafe.naver.com/x/1", scheduled_check_at: iso(Date.now() + DAY) });
  ck("[신청] team1 request 201 → pending", req1.status === 201 && req1.json.data?.status === "pending", `status=${req1.status}`);

  // 독립성 — team1 pending, team2 여전히 needed.
  const bT1 = (await board(T1.id)).json.data, bT2 = (await board(T2.id)).json.data;
  ck("[독립] team1=pending · team2=needed (상태 팀별 분리)", findAct(bT1, a1.id)?.status === "pending" && findAct(bT2, a1.id)?.status === "needed");
  ck("[독립] team1 reviewLink 채움 · team2 빈칸", !!findAct(bT1, a1.id)?.reviewLink && findAct(bT2, a1.id)?.reviewLink === null);

  // direct DB — team1 행만 pending(team_id=T1), team2 행 없음.
  const dT1 = (await sb.from("process_check_statuses").select("status,team_id").eq("organization_slug", ORG).eq("hub", HUB).eq("act_id", a1.id).eq("team_id", T1.id).maybeSingle()).data;
  const dT2 = (await sb.from("process_check_statuses").select("status").eq("organization_slug", ORG).eq("hub", HUB).eq("act_id", a1.id).eq("team_id", T2.id).maybeSingle()).data;
  ck("[검증] direct(DB) team1 행 pending · team2 행 없음", dT1?.status === "pending" && dT1?.team_id === T1.id && !dT2, J({ t1: dT1?.status, t2: dT2 }));

  // team2 신청 — 둘 다 pending(독립).
  await act(T2.id, "request", { review_link: "https://cafe.naver.com/x/2", scheduled_check_at: iso(Date.now() + DAY) });
  // team1 취소 — team1 needed, team2 여전히 pending.
  const cancel1 = await act(T1.id, "cancel");
  ck("[취소] team1 cancel 201 → needed", cancel1.status === 201 && cancel1.json.data?.status === "needed");
  const bT1b = (await board(T1.id)).json.data, bT2b = (await board(T2.id)).json.data;
  ck("[독립] 취소가 선택 팀(team1)에만 반영 — team1 needed · team2 pending", findAct(bT1b, a1.id)?.status === "needed" && findAct(bT2b, a1.id)?.status === "pending");

  // 섹션.1 상태창2 — team2 신청완료 1 반영.
  ck("[상태창2] team2 actApplied≥1 · team1 actApplied=0(선택 팀 기준)", (bT2b.summary?.actApplied ?? 0) >= 1 && (bT1b.summary?.actApplied ?? -1) === 0, J({ t1: bT1b.summary?.actApplied, t2: bT2b.summary?.actApplied }));

  // 로그(섹션.0 전체 팀) — 팀명 포함 + 시드 액트 로그 존재.
  const b0 = (await board(null)).json.data;
  const myLogs = (b0.logs ?? []).filter((l) => l.actName?.startsWith(TAG));
  ck("[로그] 팀명 포함(섹션.0 전체 팀) — team1/team2 세그먼트", myLogs.length >= 3 && myLogs.some((l) => l.teamName === T1.team_name) && myLogs.some((l) => l.teamName === T2.team_name), `logs=${myLogs.length}`);
  ck("[로그] 행동 순서(과거→최신) check_requested(t1)→check_requested(t2)→check_cancelled(t1)", J(myLogs.map((l) => l.action)) === J(["check_requested", "check_requested", "check_cancelled"]), J(myLogs.map((l) => l.action)));

  // 섹션.0 board(no team) — teamless(전 팀 합산 아님·고정) · teams 목록 존재.
  ck("[섹션.0] no-team board teams 목록 존재 · 액트 teamless needed", (b0.teams ?? []).length >= 2 && findAct(b0, a1.id)?.status === "needed");

  // info 회귀 — info POST(teamless) 동작 · team_id 주면 400.
  const infoTeamReject = await api("/api/admin/processes/check", { method: "POST", body: J({ hub: "info", organization: ORG, act_id: a1.id, team_id: T1.id, action: "request", review_link: "https://cafe.naver.com/x/1", scheduled_check_at: iso(Date.now() + DAY) }) });
  ck("[회귀] info 에 team_id 주면 400(팀 구분 없음)", infoTeamReject.status === 400, infoTeamReject.json.error);
  // experience 에 team 누락 시 400.
  const expNoTeam = await api("/api/admin/processes/check", { method: "POST", body: J({ hub: HUB, organization: ORG, act_id: a1.id, action: "request", review_link: "https://cafe.naver.com/x/1", scheduled_check_at: iso(Date.now() + DAY) }) });
  ck("[검증] experience team 누락 → 400", expNoTeam.status === 400, expNoTeam.json.error);
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally { await cleanup(); console.log("(cleanup 완료 — net-zero)"); console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(fail > 0 ? 1 : 0); }

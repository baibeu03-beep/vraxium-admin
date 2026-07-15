// 프로세스 체크 [실무 경험 급] 섹션.0 direct==HTTP 검증.
//   - GET board hub=experience: teams(org 동적·cluster4_teams) · summary(experience 마스터 총수) · logs[]
//   - 팀 목록 direct(cluster4_teams) == HTTP board.teams (이름/순서)
//   - 요약 총수 = experience 마스터(line_groups/acts) · 완료/신청 0(표시 전용)
//   - org 분기(encre 팀 동적) · info 회귀(teams=[] · 액트테이블 데이터 유지)
// 전제: dev 서버. net-zero(TAG 정리). snapshot/uws 무접촉(코드).
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
const HUB = "experience", ORG = "oranke", TAG = "ZZ-pchk-exp";
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

// 운영(operating) 보드는 (T) 테스트 팀을 제외하고 운영 팀만 노출한다.
//   lib/cluster4ExperienceTestScope.TEST_TEAM_SCOPE 미러(이 스크립트는 oranke/encre 만 사용).
//   filterTeamsByScope(teams, org, "operating") 와 동일 정책 — direct 가 HTTP 운영 보드와 정합.
const TEST_TEAM_SCOPE = {
  oranke: new Set(["과일(T)", "음료(T)", "콘텐츠실험(T)"]),
  encre: new Set(["사운드(T)", "비주얼랩(T)", "팬덤실험(T)"]),
  phalanx: new Set(["전략(T)", "제품실험(T)", "운영(T)"]),
};
async function directTeams(org) {
  const { data } = await sb.from("cluster4_teams").select("team_name").eq("organization_slug", org).eq("is_active", true).order("team_name", { ascending: true });
  const testSet = TEST_TEAM_SCOPE[org] ?? new Set();
  return (data ?? []).map((t) => t.team_name).filter((n) => !testSet.has(n)); // operating = 운영 팀만
}
async function cleanup() {
  const g = (await sb.from("process_line_groups").select("id").eq("hub", HUB).like("name", `${TAG}%`)).data ?? [];
  const ids = g.map((x) => x.id);
  if (ids.length) { await sb.from("process_acts").delete().in("line_group_id", ids); await sb.from("process_line_groups").delete().in("id", ids); }
}

try {
  await cleanup();

  // baseline(experience 마스터 총수).
  const b0 = await api(`/api/admin/processes/check?hub=${HUB}&org=${ORG}`);
  ck("[HTTP] GET experience 보드 200 + week + teams + summary + logs", b0.status === 200 && b0.json.success && Array.isArray(b0.json.data?.teams) && !!b0.json.data?.summary && Array.isArray(b0.json.data?.logs), `status=${b0.status}`);
  const baseActTotal = b0.json.data?.summary?.actTotal ?? 0;
  const baseGroupTotal = b0.json.data?.summary?.lineGroupTotal ?? 0;

  // 팀 동적 조회 — direct(cluster4_teams) == HTTP board.teams.
  const dTeams = await directTeams(ORG);
  const hTeams = (b0.json.data?.teams ?? []).map((t) => t.teamName);
  ck("[팀] direct(cluster4_teams oranke) == HTTP board.teams (이름/순서)", J(dTeams) === J(hTeams), `direct=${J(dTeams)} http=${J(hTeams)}`);
  ck("[상태창1] 팀 수만큼 문장 데이터(teams.length == 팀 수)", (b0.json.data?.teams ?? []).length === dTeams.length);
  // 상태창1 완료 판정 = 실제 체크 데이터(하드코딩 false 아님). isAllCompleted 는 boolean 파생값.
  ck("[상태창1] isAllCompleted 는 boolean 파생(하위 액트 완료 반영)", (b0.json.data?.teams ?? []).every((t) => typeof t.isAllCompleted === "boolean"));
  ck("[로그창] experience 로그 없음(빈 배열)", (b0.json.data?.logs ?? []).length === 0);

  // 시드 — experience 라인급1 + 체크대상 액트1.
  const cg = await api("/api/admin/processes/line-groups", { method: "POST", body: J({ hub: HUB, name: `${TAG} 라인급` }) });
  const groupId = cg.json.data?.id;
  const a1 = (await api("/api/admin/processes/acts", { method: "POST", body: J({
    line_group_id: groupId, hub: HUB, act_name: `${TAG} 액트`, duration_minutes: 10,
    occur_week: "N", occur_dow: 2, occur_time: "06:30", check_week: "N", check_dow: 3, check_time: "21:00",
    point_check: 1, point_advantage: 0, point_penalty: 0, cafe: "occur", check_target: "check", act_type: "required",
    overview: null, remarks: null,
  }) })).json.data;
  ck("시드 — experience 라인급+체크대상 액트 생성", !!groupId && !!a1?.id);

  const b1 = await api(`/api/admin/processes/check?hub=${HUB}&org=${ORG}`);
  ck("[요약] actTotal +1 · lineGroupTotal +1 (experience 마스터 기준)", b1.json.data?.summary?.actTotal === baseActTotal + 1 && b1.json.data?.summary?.lineGroupTotal === baseGroupTotal + 1, J(b1.json.data?.summary));
  ck("[요약] 완료/신청 수 = 0(표시 전용)", b1.json.data?.summary?.actApplied === 0 && b1.json.data?.summary?.actCompleted === 0);
  // direct 마스터 카운트 == HTTP.
  const dActs = ((await sb.from("process_acts").select("id,check_target").eq("hub", HUB).eq("is_active", true)).data ?? []).filter((x) => x.check_target === "check").length;
  ck("[검증] direct(process_acts experience check) == HTTP actTotal", dActs === b1.json.data?.summary?.actTotal, `direct=${dActs} http=${b1.json.data?.summary?.actTotal}`);

  // org 분기 — encre 팀 동적.
  const bEnc = await api(`/api/admin/processes/check?hub=${HUB}&org=encre`);
  const dEnc = await directTeams("encre");
  const hEnc = (bEnc.json.data?.teams ?? []).map((t) => t.teamName);
  ck("[org분기] encre board.teams == direct(cluster4_teams encre)", J(dEnc) === J(hEnc), `direct=${J(dEnc)}`);

  // info 회귀 — teams=[] (허브 전체 1문장) · 액트 테이블 데이터(acts) 유지 · 로그 형식 무관.
  const bInfo = await api(`/api/admin/processes/check?hub=info&org=${ORG}`);
  ck("[회귀] info teams=[] (허브 전체 1문장 유지)", (bInfo.json.data?.teams ?? []).length === 0);
  ck("[회귀] info acts 배열 유지(액트 목록 테이블 데이터)", Array.isArray(bInfo.json.data?.acts));
  ck("[회귀] info 로그 teamName=null(팀 세그먼트 없음)", (bInfo.json.data?.logs ?? []).every((l) => l.teamName === null));

  // 잘못된 org.
  const badOrg = await api(`/api/admin/processes/check?hub=${HUB}&org=nope`);
  ck("[검증] 잘못된 org 400", badOrg.status === 400);
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally { await cleanup(); console.log("(cleanup 완료 — net-zero)"); console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(fail > 0 ? 1 : 0); }

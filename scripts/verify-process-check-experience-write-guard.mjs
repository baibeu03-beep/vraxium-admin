// 실무 경험 체크 보드 — write 팀 mode 재검증 가드 (fix #5) direct==HTTP 검증.
//   정책: read 목록(filterTeamsByScope)과 동일 축으로 write 도 가드.
//     · mode=test     → (T) 테스트 팀만 체크 허용. 운영 팀 team_id → 422 · write 0.
//     · mode=operating→ 운영(비T) 팀만 체크 허용. (T) 팀 team_id → 422 · write 0.
//   매칭 쌍(test+테스트팀 / operating+운영팀)은 200 으로 통과(보드 상태행 생성) → cleanup.
// 전제: dev 서버(:3000) + process v2/v3 스키마 + oranke 운영/테스트 팀 + experience 액트 시드.
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
const HUB = "experience", ORG = "oranke", TAG = "ZZ-expchk-guard";
const J = (o) => JSON.stringify(o);
const schedIso = new Date(Date.now() + 86_400_000).toISOString();

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

let actId = null;
async function cleanup() {
  if (actId) {
    await sb.from("process_check_logs").delete().eq("act_id", actId);
    await sb.from("process_check_statuses").delete().eq("act_id", actId);
  }
  const g = (await sb.from("process_line_groups").select("id").eq("hub", HUB).like("name", `${TAG}%`)).data ?? [];
  if (g.length) {
    const ids = g.map((x) => x.id);
    const acts = (await sb.from("process_acts").select("id").in("line_group_id", ids)).data ?? [];
    const aIds = acts.map((x) => x.id);
    if (aIds.length) {
      await sb.from("process_check_logs").delete().in("act_id", aIds);
      await sb.from("process_check_statuses").delete().in("act_id", aIds);
      await sb.from("process_acts").delete().in("id", aIds);
    }
    await sb.from("process_line_groups").delete().in("id", ids);
  }
}

const countStatus = async (teamId) =>
  (await sb.from("process_check_statuses").select("id", { count: "exact", head: true })
    .eq("act_id", actId).eq("team_id", teamId)).count ?? -1;

try {
  const probe = await sb.from("process_check_statuses").select("week_id").limit(1);
  if (probe.error) { console.log(`⚠ v2/v3 미적용(${probe.error.code}) — 적용 후 재실행`); process.exit(2); }

  const teams = ((await sb.from("cluster4_teams").select("id,team_name").eq("organization_slug", ORG).eq("is_active", true)).data ?? []);
  const T = new Set(["과일(T)", "음료(T)", "콘텐츠실험(T)"]);
  const opTeam = teams.find((t) => !T.has(t.team_name));   // 운영 팀
  const teTeam = teams.find((t) => T.has(t.team_name));    // 테스트 팀
  ck("[전제] oranke 운영 팀 + 테스트(T) 팀 존재", !!opTeam && !!teTeam, J({ op: opTeam?.team_name, te: teTeam?.team_name }));
  if (!opTeam || !teTeam) { console.log("⚠ 팀 부족 — 중단"); process.exit(2); }

  await cleanup();
  const cg = await api("/api/admin/processes/line-groups", { method: "POST", body: J({ hub: HUB, name: `${TAG} 라인급` }) });
  const groupId = cg.json.data?.id;
  const a1 = (await api("/api/admin/processes/acts", { method: "POST", body: J({
    line_group_id: groupId, hub: HUB, act_name: `${TAG} 대상1`, duration_minutes: 10,
    occur_week: "N", occur_dow: 2, occur_time: "06:30", check_week: "N", check_dow: 3, check_time: "21:00",
    point_check: 1, point_advantage: 0, point_penalty: 0, cafe: "occur", check_target: "check", act_type: "required",
    overview: null, remarks: null,
  }) })).json.data;
  actId = a1?.id ?? null;
  ck("[시드] 라인급 + experience 체크 액트", !!groupId && !!actId);

  const reqBody = (mode, teamId) => J({ hub: HUB, organization: ORG, act_id: actId, action: "request", team_id: teamId, mode, review_link: "https://cafe.naver.com/x/1", scheduled_check_at: schedIso });

  // ── 1. mode=test + 운영 팀 → 422 · write 0 ──
  const a = await api("/api/admin/processes/check", { method: "POST", body: reqBody("test", opTeam.id) });
  ck("[가드] test + 운영 팀 → 422", a.status === 422, `status=${a.status}`);
  ck("[가드] test + 운영 팀 → DB write 0", (await countStatus(opTeam.id)) === 0);

  // ── 2. mode=operating + 테스트(T) 팀 → 422 · write 0 ──
  const b = await api("/api/admin/processes/check", { method: "POST", body: reqBody("operating", teTeam.id) });
  ck("[가드] operating + 테스트(T) 팀 → 422", b.status === 422, `status=${b.status}`);
  ck("[가드] operating + 테스트(T) 팀 → DB write 0", (await countStatus(teTeam.id)) === 0);

  // ── 3. 매칭 쌍은 통과(200) — 비즈니스 로직 동일성 확인 ──
  const c = await api("/api/admin/processes/check", { method: "POST", body: reqBody("test", teTeam.id) });
  ck("[정상] test + 테스트(T) 팀 → 2xx (정상 동작)", c.status >= 200 && c.status < 300, `status=${c.status}`);
  ck("[정상] test + 테스트(T) 팀 → 상태행 생성", (await countStatus(teTeam.id)) === 1);

  const d = await api("/api/admin/processes/check", { method: "POST", body: reqBody("operating", opTeam.id) });
  ck("[정상] operating + 운영 팀 → 2xx (정상 동작)", d.status >= 200 && d.status < 300, `status=${d.status}`);
  ck("[정상] operating + 운영 팀 → 상태행 생성", (await countStatus(opTeam.id)) === 1);

  await cleanup();
  console.log(`\n결과: ${pass} pass / ${fail} fail (cleanup 완료)`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  await cleanup().catch(() => {});
  console.error("FATAL:", e?.stack ?? e);
  process.exit(1);
}

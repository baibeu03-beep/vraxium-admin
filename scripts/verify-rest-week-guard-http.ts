// 검증(HTTP) — 공식 휴식 주차 라인개설 서버 가드(422) + write 격리 + direct==HTTP.
//   사전: dev 서버(:3000). 실행: npx tsx --env-file=.env.local scripts/verify-rest-week-guard-http.ts

import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { getCurrentWeekStartMs, getOpenableWeekStartMs, describeWeekByStartMs } from "@/lib/cluster4WeekPolicy";
import { fetchActiveRestPeriods } from "@/lib/officialRestPeriodsData";
import { matchOfficialRestPeriods } from "@/lib/officialRestPeriodsTypes";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE);
const ORG = "oranke";
const DAY = 86_400_000;

let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function cookie(): Promise<string> {
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: ADMIN_EMAIL });
  const otp = link.properties?.email_otp; if (!otp) throw new Error("otp");
  const { data: v } = await browser.auth.verifyOtp({ email: ADMIN_EMAIL, token: otp, type: "magiclink" });
  const cap: Array<{ name: string; value: string }> = [];
  const srv = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session!.access_token, refresh_token: v.session!.refresh_token });
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function main() {
  const c = await cookie();
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/admin/cluster4/admin-org`, { headers: { cookie: c } })).status === 200) break; } catch {/*wait*/} await new Promise((r) => setTimeout(r, 2000)); }

  // 휴식/일반 주차 week_id 확보(UI 판정 미러).
  const todayIso = new Date().toISOString().slice(0, 10);
  const curMs = getCurrentWeekStartMs(todayIso)!;
  const restPeriods = await fetchActiveRestPeriods();
  let restWeekId: string | null = null, normalWeekId: string | null = null;
  for (let off = 0; off < 8 && (!restWeekId || !normalWeekId); off++) {
    const info = describeWeekByStartMs(curMs - off * 7 * DAY); if (!info) continue;
    const rest = info.isOfficialRest || matchOfficialRestPeriods({ startDate: info.weekStart, endDate: info.weekEnd }, restPeriods).length > 0;
    const { data } = await sb.from("weeks").select("id").eq("iso_year", info.isoYear).eq("iso_week", info.isoWeek).maybeSingle();
    const id = (data as { id: string } | null)?.id; if (!id) continue;
    if (rest && !restWeekId) restWeekId = id;
    if (!rest && !normalWeekId) normalWeekId = id;
  }
  const { data: tRow } = await sb.from("cluster4_teams").select("id").eq("organization_slug", ORG).eq("team_name", "과일(T)").maybeSingle();
  const teamId = (tRow as { id: string } | null)?.id;
  console.log(`restWeek=${restWeekId?.slice(0,8)} normalWeek=${normalWeekId?.slice(0,8)} team=${teamId?.slice(0,8)}\n`);

  const snap = async () => (await sb.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true })).count ?? 0;
  const snapBefore = await snap();

  const partPost = (body: any) => fetch(`${BASE}/api/admin/cluster4/experience/part-input`, { method: "POST", headers: { cookie: c, "content-type": "application/json" }, body: JSON.stringify(body) });
  const overallPost = (body: any) => fetch(`${BASE}/api/admin/cluster4/experience/team-overall`, { method: "POST", headers: { cookie: c, "content-type": "application/json" }, body: JSON.stringify(body) });
  const partHdr = async (weekId: string, part: string) => (await sb.from("cluster4_experience_part_submissions").select("id", { count: "exact", head: true }).eq("organization_slug", ORG).eq("week_id", weekId).eq("team_id", teamId!).eq("part_name", part)).count ?? 0;

  // ── 휴식 주차(W15) — part-input/team-overall POST 422, operating·test 둘 다, write 0 ──
  if (restWeekId && teamId) {
    const before = await partHdr(restWeekId, "젤리");
    for (const mode of ["operating", "test"] as const) {
      const r = await partPost({ organization: ORG, week_id: restWeekId, team_id: teamId, part: "젤리", mode, cells: [] });
      const j = await r.json();
      ck(`[HTTP part-input] 휴식(${mode}) → 422`, r.status === 422 && /공식 휴식 주차/.test(j?.error ?? ""), `status=${r.status} err=${(j?.error ?? "").slice(0,30)}`);
    }
    ck("[HTTP part-input] 휴식 거부 write 0", (await partHdr(restWeekId, "젤리")) === before);

    for (const mode of ["operating", "test"] as const) {
      const r = await overallPost({ action: "open", organization: ORG, week_id: restWeekId, team_id: teamId, team_name: "과일(T)", mode, leaderCells: [], outputs: [] });
      const j = await r.json();
      ck(`[HTTP team-overall open] 휴식(${mode}) → 422`, r.status === 422 && /공식 휴식 주차/.test(j?.error ?? ""), `status=${r.status}`);
    }
  }

  // ── 일반 주차(W13) — part-input POST 통과(201) → 정리 ──
  if (normalWeekId && teamId) {
    const before = await partHdr(normalWeekId, "젤리");
    const r = await partPost({ organization: ORG, week_id: normalWeekId, team_id: teamId, part: "젤리", mode: "test", cells: [] });
    ck("[HTTP part-input] 일반주차(W13) 통과 201", r.status === 201, `status=${r.status}`);
    if (before === 0) await sb.from("cluster4_experience_part_submissions").delete().eq("organization_slug", ORG).eq("week_id", normalWeekId).eq("team_id", teamId).eq("part_name", "젤리");
    ck("[HTTP part-input] 일반주차 정리 net-zero", (await partHdr(normalWeekId, "젤리")) === before);
  }

  const snapAfter = await snap();
  ck("[격리] snapshot count 불변", snapAfter === snapBefore, `${snapBefore}→${snapAfter}`);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

// 검증(HTTP, READ-ONLY) — Phase 3: 경험 라인개설 mode 스코프 direct==HTTP.
//   사전: dev 서버(:3000). 실행: npx tsx --env-file=.env.local scripts/verify-phase3-experience-scope-http.ts
// 유일한 write 시도(part-input POST mode=test+실사용자)는 가드 거부로 무영향.

import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { getExperienceLineManageSummary } from "@/lib/adminExperienceLineManage";
import { getTeamOverallBoard } from "@/lib/adminExperienceTeamOverall";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE);
const ORG = "oranke";

let pass = 0;
let fail = 0;
const ck = (l: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};

async function cookie(): Promise<string> {
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: ADMIN_EMAIL });
  const otp = link.properties?.email_otp;
  if (!otp) throw new Error("otp 없음");
  const { data: v } = await browser.auth.verifyOtp({ email: ADMIN_EMAIL, token: otp, type: "magiclink" });
  const cap: Array<{ name: string; value: string }> = [];
  const srv = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session!.access_token, refresh_token: v.session!.refresh_token });
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}
const getJson = async (url: string, c: string) => (await fetch(url, { headers: { cookie: c } })).json();

async function main() {
  const c = await cookie();
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/admin/cluster4/admin-org`, { headers: { cookie: c } })).status === 200) break;
    } catch {/* wait */}
    await new Promise((r) => setTimeout(r, 2000));
  }
  const testSet = await fetchTestUserMarkerIds();
  const snap = async () =>
    (await sb.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true })).count ?? 0;
  const snapBefore = await snap();

  // ── line-manage operating: direct==HTTP ──
  const lmBase = `${BASE}/api/admin/cluster4/experience/line-manage?organization=${ORG}`;
  const opDirect = await getExperienceLineManageSummary(ORG);
  const opHttp = (await getJson(lmBase, c)).data;
  ck("[operating] line-manage direct==HTTP", JSON.stringify(opDirect) === JSON.stringify(opHttp));
  ck(
    "[operating] HTTP (T) 팀 숨김",
    !(opHttp.teams as { teamName: string }[]).some((t) => /\(T\)$/.test(t.teamName)),
    `teams=${(opHttp.teams as { teamName: string }[]).map((t) => t.teamName).join(",")}`,
  );

  // ── line-manage test: direct==HTTP + 9/7/11 ──
  const tsDirect = await getExperienceLineManageSummary(ORG, null, "test");
  const tsHttp = (await getJson(`${lmBase}&mode=test`, c)).data;
  ck("[test] line-manage direct==HTTP", JSON.stringify(tsDirect) === JSON.stringify(tsHttp));
  const expect: Record<string, number> = { "과일(T)": 9, "음료(T)": 7, "콘텐츠실험(T)": 11 };
  for (const [team, n] of Object.entries(expect)) {
    const t = (tsHttp.teams as { teamName: string; headcount: { total: number } }[]).find((x) => x.teamName === team);
    ck(`[test] HTTP ${team} total=${n}`, t?.headcount.total === n, `total=${t?.headcount.total}`);
  }

  // ── team-overall test: 크루 전원 marker + direct==HTTP ──
  const { data: tr } = await sb
    .from("cluster4_teams").select("id").eq("organization_slug", ORG).eq("team_name", "과일(T)").maybeSingle();
  const teamId = (tr as { id: string } | null)?.id;
  const { data: wk } = await sb.from("weeks").select("id").order("start_date", { ascending: false }).limit(1).maybeSingle();
  const weekId = (wk as { id: string } | null)?.id;
  if (teamId && weekId) {
    const boDirect = await getTeamOverallBoard(ORG, weekId, teamId, "과일(T)", "test");
    const url = `${BASE}/api/admin/cluster4/experience/team-overall?organization=${ORG}&week_id=${weekId}&team_id=${teamId}&team_name=${encodeURIComponent("과일(T)")}&mode=test`;
    const boHttp = (await getJson(url, c)).data;
    ck("[test] team-overall direct==HTTP", JSON.stringify(boDirect) === JSON.stringify(boHttp));
    const ids = (boHttp.parts as { crews: { userId: string }[] }[]).flatMap((p) => p.crews.map((x) => x.userId));
    ck("[test] team-overall 크루 전원 marker", ids.length > 0 && ids.every((id) => testSet.has(id)), `crews=${ids.length}`);

    // ── 저장 가드(#5) HTTP: mode=test + 실사용자 → 422 ──
    const { data: rp } = await sb.from("user_profiles").select("user_id").eq("organization_slug", ORG).limit(400);
    const realId = ((rp ?? []) as { user_id: string }[]).map((r) => r.user_id).find((id) => !testSet.has(id));
    const part = (tsHttp.teams.find((t: { teamName: string }) => t.teamName === "과일(T)")?.parts ?? [])[0]?.partName
      ?? (boHttp.parts as { partName: string }[])[0]?.partName;
    if (realId && part) {
      const hdr = async () =>
        (await sb.from("cluster4_experience_part_submissions").select("id", { count: "exact", head: true })
          .eq("organization_slug", ORG).eq("week_id", weekId).eq("team_id", teamId).eq("part_name", part)).count ?? 0;
      const before = await hdr();
      const res = await fetch(`${BASE}/api/admin/cluster4/experience/part-input`, {
        method: "POST",
        headers: { cookie: c, "content-type": "application/json" },
        body: JSON.stringify({
          organization: ORG, week_id: weekId, team_id: teamId, part, mode: "test",
          cells: [{ crewUserId: realId, lineType: "derivation", checked: true, score: 5 }],
        }),
      });
      const json = await res.json();
      ck("[저장#5 HTTP] mode=test+실사용자 → 422 차단", res.status === 422 && json?.success === false, `status=${res.status}`);
      ck("[저장#5 HTTP] 헤더 미생성", (await hdr()) === before, `${before}`);
    }
  }

  const snapAfter = await snap();
  ck("[격리] snapshot count 불변", snapAfter === snapBefore, `${snapBefore}→${snapAfter}`);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

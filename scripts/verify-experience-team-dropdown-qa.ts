/**
 * 검증: 실무 경험 라인 개설 팀/파트 드롭다운 — QA 고정(QA_HIDE_REAL_USERS) 정합.
 *   npx tsx --env-file=.env.local scripts/verify-experience-team-dropdown-qa.ts   (dev :3000 필요)
 *
 * 계약(QA_HIDE_REAL_USERS=true 전제):
 *   · 운영 URL(mode 미부착)이라도 팀 드롭다운은 (T) 테스트 팀만 = 테스트 유저가 실제 소속한 팀.
 *   · 각 (T) 팀의 파트 드롭다운은 비어있지 않고, 크루는 전원 test_user_markers.
 *   · direct(listTeams/listTeamParts/listPartCrews) == HTTP(cluster4/teams·part-input).
 *   · 실제 개설 신청(part-input POST)까지 성공 → 즉시 DELETE 로 원복(DB 잔여 0).
 * read-only(마지막 open/cancel 1쌍 제외). snapshot 무접촉(part-input 은 snapshot write 없음).
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { listTeams } from "@/lib/adminExperienceLineData";
import { listTeamParts, listPartCrews } from "@/lib/adminExperiencePartInput";
import { isTestTeam } from "@/lib/cluster4ExperienceTestScope";
import { QA_HIDE_REAL_USERS } from "@/lib/qaFixedScope";

const BASE = "http://localhost:3000";
const EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const ORGS = ["encre", "oranke", "phalanx"];

const env = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
const ge = (k: string) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim() ?? "";
const URL_ = ge("NEXT_PUBLIC_SUPABASE_URL");
const ANON = ge("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = ge("SUPABASE_SERVICE_ROLE_KEY");

let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};
const setEq = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

async function sessionCookie(): Promise<string> {
  const sb = createClient(URL_, SERVICE);
  const brow = createClient(URL_, ANON);
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const { data: v } = await brow.auth.verifyOtp({
    email: EMAIL,
    token: (link as { properties: { email_otp: string } }).properties.email_otp,
    type: "magiclink",
  });
  const cap: Array<{ name: string; value: string }> = [];
  const srv = createServerClient(URL_, ANON, {
    cookies: { getAll: () => [], setAll: (i: typeof cap) => cap.push(...i) },
  });
  await srv.auth.setSession({
    access_token: v!.session!.access_token,
    refresh_token: v!.session!.refresh_token,
  });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function main() {
  console.log(`QA_HIDE_REAL_USERS = ${QA_HIDE_REAL_USERS}\n`);
  ck("QA_HIDE_REAL_USERS 켜짐(전제)", QA_HIDE_REAL_USERS === true);
  const testIds = await fetchTestUserMarkerIds();
  const cookie = await sessionCookie();
  const getJson = async (path: string) => {
    const res = await fetch(`${BASE}${path}`, { headers: { cookie }, cache: "no-store" });
    return res.json();
  };

  for (const org of ORGS) {
    console.log(`\n════════ ORG=${org} (운영 URL = mode 미부착) ════════`);

    // 테스트 유저 실제 소속 팀(현재 멤버십)
    const actualTestTeams = new Set<string>();
    {
      const orgTest: string[] = [];
      for (let i = 0; i < [...testIds].length; i += 800) {
        const part = [...testIds].slice(i, i + 800);
        const { data } = await supabaseAdmin
          .from("user_profiles").select("user_id").eq("organization_slug", org).in("user_id", part);
        for (const r of (data ?? []) as any[]) orgTest.push(r.user_id);
      }
      for (let i = 0; i < orgTest.length; i += 800) {
        const { data } = await supabaseAdmin
          .from("user_memberships").select("team_name").in("user_id", orgTest.slice(i, i + 800));
        for (const r of (data ?? []) as any[]) if (r.team_name) actualTestTeams.add(r.team_name);
      }
    }

    // A) direct listTeams(operating) — QA 강제로 (T) 팀만
    const dTeams = (await listTeams(org, "operating")).map((t) => t.teamName);
    ck(`[direct] listTeams(operating) 전원 (T) 팀 (${dTeams.length})`,
      dTeams.length > 0 && dTeams.every((n) => isTestTeam(org, n)), dTeams.join(", "));
    // 드롭다운 팀 ⊆ 테스트 유저 실제 소속 팀(빈 팀 노출 없음)
    ck(`[direct] 드롭다운 팀 전부 테스트 유저 실소속`,
      dTeams.every((n) => actualTestTeams.has(n)),
      `드롭다운=[${dTeams.join(",")}] 실소속=[${[...actualTestTeams].filter(n=>isTestTeam(org,n)).join(",")}]`);

    // B) HTTP cluster4/teams (operating, mode 미부착)
    const hTeamsJson = await getJson(`/api/admin/cluster4/teams?organization=${org}`);
    const hTeams = (hTeamsJson?.data ?? []).map((t: any) => t.teamName);
    ck(`[HTTP] cluster4/teams(operating) 전원 (T) (${hTeams.length})`,
      hTeams.length > 0 && hTeams.every((n: string) => isTestTeam(org, n)), hTeams.join(", "));
    ck(`[direct==HTTP] 팀 집합 일치`, setEq(dTeams, hTeams));

    // C) 각 팀 파트 + 크루(전원 test) — direct & HTTP
    let anyOpenable: { teamName: string; teamId: string; part: string; crewIds: string[] } | null = null;
    for (const teamName of dTeams) {
      const dParts = await listTeamParts(org, teamName, "operating");
      const teamRow = (await listTeams(org, "operating")).find((t) => t.teamName === teamName)!;
      // HTTP part-input (operating, mode 미부착)
      const hp = await getJson(
        `/api/admin/cluster4/experience/part-input?organization=${org}&team_id=${teamRow.id}&team_name=${encodeURIComponent(teamName)}`,
      );
      const hParts: string[] = hp?.data?.parts ?? [];
      ck(`  [${teamName}] 파트 비어있지 않음 (direct ${dParts.length}/HTTP ${hParts.length})`,
        dParts.length > 0 && hParts.length > 0);
      ck(`  [${teamName}] direct==HTTP 파트`, setEq(dParts, hParts), dParts.join(","));

      // 크루 전원 test (첫 파트)
      if (dParts.length > 0) {
        const crews = await listPartCrews(org, teamName, dParts[0], "operating");
        ck(`  [${teamName}/${dParts[0]}] 크루 전원 test_user (${crews.length})`,
          crews.length > 0 && crews.every((c) => testIds.has(c.userId)));
        if (!anyOpenable && crews.length > 0) {
          anyOpenable = { teamName, teamId: teamRow.id, part: dParts[0], crewIds: crews.map((c) => c.userId) };
        }
      }
    }

    // D) 실제 개설 신청 왕복(첫 개설가능 팀/파트) — 성공 후 즉시 DELETE 원복
    if (anyOpenable) {
      const st = await getJson(`/api/admin/cluster4/experience/opening-status?organization=${org}`);
      const weekId: string | null = st?.data?.targetWeekId ?? null;
      const canOpen = st?.data?.targetWeek ? !st.data.targetWeek.isOfficialRest : false;
      if (!weekId || !canOpen) {
        console.log(`  (개설 왕복 스킵: targetWeekId=${weekId} canOpen=${canOpen})`);
      } else {
        const cells = anyOpenable.crewIds.map((uid) => ({ crewUserId: uid, lineType: "derivation", checked: true, score: 7 }));
        const postRes = await fetch(`${BASE}/api/admin/cluster4/experience/part-input`, {
          method: "POST", headers: { cookie, "Content-Type": "application/json" },
          body: JSON.stringify({ organization: org, week_id: weekId, team_id: anyOpenable.teamId, team_name: anyOpenable.teamName, part: anyOpenable.part, cells, mode: "operating" }),
        });
        const postJson = await postRes.json();
        ck(`[OPEN] part-input POST 성공 (${anyOpenable.teamName}/${anyOpenable.part}, ${cells.length}명)`,
          postRes.status === 201 && postJson?.success === true, postJson?.error ?? `status=${postRes.status}`);
        // 원복
        const delRes = await fetch(
          `${BASE}/api/admin/cluster4/experience/part-input?organization=${org}&week_id=${weekId}&team_id=${anyOpenable.teamId}&part=${encodeURIComponent(anyOpenable.part)}`,
          { method: "DELETE", headers: { cookie } },
        );
        const delJson = await delRes.json();
        ck(`[OPEN] 원복 DELETE 성공(DB 잔여 0)`, delJson?.success === true);
      }
    }
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });

// 검증(HTTP): 실무 경험 테스트 팀/파트 스코프 안전장치 — direct==HTTP + 라우트 가드.
//   사전: dev 서버(:3000) 기동.
//   실행: npx tsx --env-file=.env.local scripts/verify-experience-test-scope-http.ts
//
// read-only 위주. 유일한 write 시도(part-input POST 실사용자 혼입)는 가드에서 거부되어 무영향.

import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import {
  getOpenableWeekStartMs,
  describeWeekByStartMs,
} from "@/lib/cluster4WeekPolicy";
import { getTeamOverallBoard } from "@/lib/adminExperienceTeamOverall";
import { listPartCrews, listTeamParts } from "@/lib/adminExperiencePartInput";
import { isTestTeam } from "@/lib/cluster4ExperienceTestScope";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE);

const ORG = "oranke";
const TEST_TEAM = "콘텐츠실험(T)";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

async function adminCookieHeader(): Promise<string> {
  const admin = createClient(SUPABASE_URL, SERVICE);
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: ADMIN_EMAIL,
  });
  if (linkErr) throw linkErr;
  const otp = linkData.properties?.email_otp;
  if (!otp) throw new Error("email_otp 없음");
  const { data: verifyData, error: vErr } = await browser.auth.verifyOtp({
    email: ADMIN_EMAIL,
    token: otp,
    type: "magiclink",
  });
  if (vErr) throw vErr;
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: verifyData.session!.access_token,
    refresh_token: verifyData.session!.refresh_token,
  });
  return captured.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function waitForServer(cookie: string) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/api/admin/cluster4/experience/part-input`, { headers: { cookie } });
      if (res.status === 200) return;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("dev server not ready after 120s");
}

async function teamIdOf(team: string): Promise<string> {
  const { data } = await sb
    .from("cluster4_teams")
    .select("id")
    .eq("organization_slug", ORG)
    .eq("team_name", team)
    .maybeSingle();
  const id = (data as { id: string } | null)?.id;
  if (!id) throw new Error(`teamId 없음: ${team}`);
  return id;
}

async function main() {
  const cookie = await adminCookieHeader();
  await waitForServer(cookie);
  const testIds = await fetchTestUserMarkerIds();

  // 대상 주차.
  const todayIso = new Date().toISOString().slice(0, 10);
  const openMs = getOpenableWeekStartMs(todayIso);
  const openInfo = openMs != null ? describeWeekByStartMs(openMs) : null;
  if (!openInfo) throw new Error("openable week 계산 실패");
  const { data: wk } = await sb
    .from("weeks")
    .select("id")
    .eq("iso_year", openInfo.isoYear)
    .eq("iso_week", openInfo.isoWeek)
    .maybeSingle();
  const weekId = (wk as { id: string } | null)?.id;
  if (!weekId) throw new Error("weeks.id 없음");

  const testTeamId = await teamIdOf(TEST_TEAM);
  console.log(`\n=== test team ${ORG}/${TEST_TEAM} (${testTeamId}) week=${weekId} ===\n`);

  // ── [A] team-overall: direct == HTTP, 테스트 팀 = 테스트 계정만 ──
  const directBoard = await getTeamOverallBoard(ORG, weekId, testTeamId, TEST_TEAM);
  const boardUrl = `${BASE}/api/admin/cluster4/experience/team-overall?organization=${ORG}&week_id=${weekId}&team_id=${testTeamId}&team_name=${encodeURIComponent(TEST_TEAM)}`;
  const boardRes = await fetch(boardUrl, { headers: { cookie } });
  const boardJson = await boardRes.json();
  check("[A] team-overall HTTP 200", boardRes.status === 200 && boardJson?.success, `status=${boardRes.status}`);
  check("[A] team-overall direct == HTTP (deep-equal)", JSON.stringify(directBoard) === JSON.stringify(boardJson.data));
  const boardCrewIds = directBoard.parts.flatMap((p) => p.crews.map((c) => c.userId));
  check(
    "[A] team-overall 테스트 팀 크루 = 전원 test_user_markers",
    boardCrewIds.length > 0 && boardCrewIds.every((id) => testIds.has(id)),
    `crews=${boardCrewIds.length} 비테스트=${boardCrewIds.filter((id) => !testIds.has(id)).length}`,
  );

  // ── [B] part-input: direct == HTTP, 테스트 팀 = 테스트 계정만 ──
  const parts = await listTeamParts(ORG, TEST_TEAM);
  const part = parts[0];
  check("[B] 테스트 팀 파트 존재", Boolean(part), `parts=${JSON.stringify(parts)}`);
  if (part) {
    const directCrews = await listPartCrews(ORG, TEST_TEAM, part);
    const piUrl = `${BASE}/api/admin/cluster4/experience/part-input?organization=${ORG}&week_id=${weekId}&team_id=${testTeamId}&team_name=${encodeURIComponent(TEST_TEAM)}&part=${encodeURIComponent(part)}`;
    const piRes = await fetch(piUrl, { headers: { cookie } });
    const piJson = await piRes.json();
    check("[B] part-input HTTP 200", piRes.status === 200 && piJson?.success, `status=${piRes.status}`);
    check(
      "[B] part-input crews direct == HTTP",
      JSON.stringify(directCrews) === JSON.stringify(piJson.data.crews),
    );
    const httpCrewIds = (piJson.data.crews as Array<{ userId: string }>).map((c) => c.userId);
    check(
      "[B] part-input 테스트 팀 크루 = 전원 test_user_markers",
      httpCrewIds.length > 0 && httpCrewIds.every((id) => testIds.has(id)),
      `crews=${httpCrewIds.length}`,
    );
  }

  // ── [C] 운영 팀: HTTP 목록에 테스트 계정 제외 ──
  const { data: teamRows } = await sb
    .from("cluster4_teams")
    .select("team_name")
    .eq("organization_slug", ORG)
    .eq("is_active", true)
    .order("team_name");
  const opTeam = ((teamRows ?? []) as Array<{ team_name: string }>)
    .map((r) => r.team_name)
    .find((name) => !isTestTeam(ORG, name));
  if (opTeam) {
    const opTeamId = await teamIdOf(opTeam);
    const opUrl = `${BASE}/api/admin/cluster4/experience/team-overall?organization=${ORG}&week_id=${weekId}&team_id=${opTeamId}&team_name=${encodeURIComponent(opTeam)}`;
    const opRes = await fetch(opUrl, { headers: { cookie } });
    const opJson = await opRes.json();
    const opCrewIds = (opJson.data?.parts ?? []).flatMap((p: any) => p.crews.map((c: any) => c.userId));
    check(
      `[C] 운영 팀(${opTeam}) HTTP 목록 = 테스트 계정 제외`,
      opCrewIds.every((id: string) => !testIds.has(id)),
      `crews=${opCrewIds.length} test혼입=${opCrewIds.filter((id: string) => testIds.has(id)).length}`,
    );
  }

  // ── [D] 라우트 가드: 테스트 팀에 실사용자 cell → part-input POST 거부 + write 없음 ──
  const { data: realProf } = await sb
    .from("user_profiles")
    .select("user_id")
    .eq("organization_slug", ORG)
    .limit(300);
  const realUserId =
    ((realProf ?? []) as Array<{ user_id: string }>)
      .map((r) => r.user_id)
      .find((id) => !testIds.has(id)) ?? null;
  if (part && realUserId) {
    const beforeCount = async () => {
      const { count } = await sb
        .from("cluster4_experience_part_submissions")
        .select("id", { count: "exact", head: true })
        .eq("organization_slug", ORG)
        .eq("week_id", weekId)
        .eq("team_id", testTeamId)
        .eq("part_name", part);
      return count ?? 0;
    };
    const before = await beforeCount();
    const postRes = await fetch(`${BASE}/api/admin/cluster4/experience/part-input`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        organization: ORG,
        week_id: weekId,
        team_id: testTeamId,
        part,
        cells: [{ crewUserId: realUserId, lineType: "derivation", checked: true, score: 5 }],
      }),
    });
    const postJson = await postRes.json();
    check(
      "[D] 테스트 팀 + 실사용자 cell POST 거부(success=false)",
      postJson?.success === false,
      `status=${postRes.status} err=${(postJson?.error ?? "").slice(0, 60)}`,
    );
    const after = await beforeCount();
    check("[D] 거부 시 헤더 미생성(write 없음)", before === after, `before=${before} after=${after}`);
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

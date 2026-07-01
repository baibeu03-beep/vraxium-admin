// 검증(direct + HTTP) — 팀 목록 스코프 중앙화(filterTeamsByScope) 정합.
//   npx tsx --env-file=.env.local scripts/verify-teams-scope.ts   (dev server :3000 필요)
// read-only. 모든 admin 팀 목록 산출 경로가 operating=(T)0 / test=(T)만 을 만족하는지,
// 그리고 cluster4/teams 는 direct(listTeams) == HTTP 인지 확인. DB write 없음.

import { listTeams } from "@/lib/adminExperienceLineData";
import { isTestTeam } from "@/lib/cluster4ExperienceTestScope";
import { QA_HIDE_REAL_USERS } from "@/lib/qaFixedScope";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const BASE = "http://localhost:3000";
const ORG = "encre";
const EMAIL = "vanuatu.golden@gmail.com";

const env = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
const ge = (k: string) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim() ?? "";
const URL_ = ge("NEXT_PUBLIC_SUPABASE_URL");
const ANON = ge("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = ge("SUPABASE_SERVICE_ROLE_KEY");

let pass = 0,
  fail = 0;
const ck = (l: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};

const names = (teams: Array<{ teamName: string }>) => teams.map((t) => t.teamName);
const hasTestTeam = (teams: Array<{ teamName: string }>) =>
  teams.filter((t) => isTestTeam(ORG, t.teamName)).length;
const allTestTeam = (teams: Array<{ teamName: string }>) =>
  teams.length > 0 && teams.every((t) => isTestTeam(ORG, t.teamName));
// QA 실사용자 숨김(QA_HIDE_REAL_USERS): QA 기간엔 operating 도 test 축 → (T) 팀만.
//   operating 기대: QA 중 = 전원 (T) / QA 종료 후 = (T) 0개.
const opOk = (teams: Array<{ teamName: string }>) =>
  QA_HIDE_REAL_USERS ? allTestTeam(teams) : hasTestTeam(teams) === 0;
const opLabel = QA_HIDE_REAL_USERS ? "전원 (T)(QA)" : "(T) 0개";

async function main() {
  // ── 세션 쿠키(magiclink) ──
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
  const cookie = cap.map((i) => `${i.name}=${i.value}`).join("; ");

  const httpTeams = async (path: string): Promise<Array<{ teamName: string }>> => {
    const res = await fetch(`${BASE}${path}`, { headers: { cookie }, cache: "no-store" });
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json?.error ?? `HTTP ${res.status}`);
    // cluster4/teams → data:[{teamName}], opening-status → data.teams:[{teamName}],
    // processes/check → data.teams:[{teamName}]
    const d = json.data;
    if (Array.isArray(d)) return d;
    return d.teams ?? [];
  };

  console.log("═══════════════════════════════════════");
  console.log(`  팀 목록 스코프 중앙화 검증 — org=${ORG}`);
  console.log("═══════════════════════════════════════");

  // ── 1) direct: listTeams ──
  const dOp = await listTeams(ORG, "operating");
  const dTest = await listTeams(ORG, "test");
  ck(`[direct] listTeams operating ${opLabel} (${dOp.length}팀)`, opOk(dOp), names(dOp).join(", "));
  ck(`[direct] listTeams test 전원 (T) (${dTest.length}팀)`, allTestTeam(dTest), names(dTest).join(", "));

  // ── 2) HTTP: cluster4/teams ──
  const hOp = await httpTeams(`/api/admin/cluster4/teams?organization=${ORG}`);
  const hTest = await httpTeams(`/api/admin/cluster4/teams?organization=${ORG}&mode=test`);
  ck(`[HTTP] cluster4/teams operating ${opLabel} (${hOp.length}팀)`, opOk(hOp), names(hOp).join(", "));
  ck(`[HTTP] cluster4/teams test 전원 (T) (${hTest.length}팀)`, allTestTeam(hTest), names(hTest).join(", "));

  // direct == HTTP (cluster4/teams 는 listTeams 와 동일 경로)
  const setEq = (a: string[], b: string[]) =>
    a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");
  ck("[direct==HTTP] operating 팀명 집합 일치", setEq(names(dOp), names(hOp)));
  ck("[direct==HTTP] test 팀명 집합 일치", setEq(names(dTest), names(hTest)));

  // ── 3) HTTP: opening-status (팀별 개설 현황 블록3) ──
  const osOp = await httpTeams(`/api/admin/cluster4/experience/opening-status?organization=${ORG}`);
  const osTest = await httpTeams(`/api/admin/cluster4/experience/opening-status?organization=${ORG}&mode=test`);
  ck(`[HTTP] opening-status operating ${opLabel} (${osOp.length}팀)`, opOk(osOp), names(osOp).join(", "));
  ck(`[HTTP] opening-status test 전원 (T) (${osTest.length}팀)`, allTestTeam(osTest), names(osTest).join(", "));

  // ── 4) HTTP: processes/check (experience 섹션.1 팀 탭) ──
  const pcOp = await httpTeams(`/api/admin/processes/check?hub=experience&org=${ORG}`);
  const pcTest = await httpTeams(`/api/admin/processes/check?hub=experience&org=${ORG}&mode=test`);
  ck(`[HTTP] processes/check operating ${opLabel} (${pcOp.length}팀)`, opOk(pcOp), names(pcOp).join(", "));
  ck(`[HTTP] processes/check test 전원 (T) (${pcTest.length}팀)`, allTestTeam(pcTest), names(pcTest).join(", "));

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

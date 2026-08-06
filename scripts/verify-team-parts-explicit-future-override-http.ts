/**
 * 추가 회귀 — "미래 주차에 이미 명시적 override 가 있는 상태에서 중간(과거/현재) 주차를 변경"할 때
 *   그 명시적 미래 값이 훼손되지 않는지 검증. (자동 생성 override 는 이 코드베이스에 존재하지 않음 —
 *   PATCH week-position 라우트는 요청된 그 주차 행만 upsert 한다. 실측: cluster4_team_week_position_
 *   overrides 전체를 뒤져도 "관리자가 그 주차를 열어 저장" 이외의 경로로 생성된 행은 없다.)
 * ⚠ week-summary(getTeamSelectedWeekSummary)는 미래 주차 조회 시 조용히 현재 주차로 폴백한다(기존
 *   문서화된 동작) — 여름7·8 검증은 매트릭스 API 또는 resolvePositionAtWeeksBulk 직접 호출로 한다.
 * 사전조건: dev :3000 + .env.local. 대상 = encre QA 팀 "사운드(T)". 종료 후 원복.
 * Usage: npx tsx --env-file=.env.local scripts/verify-team-parts-explicit-future-override-http.ts
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { resolvePositionAtWeeksBulk } from "@/lib/positionResolver";

const env = readFileSync(".env.local", "utf8");
const getEnv = (k: string) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim() ?? "";
const ADMIN = "http://localhost:3000";
const URL_ = getEnv("NEXT_PUBLIC_SUPABASE_URL");
const ANON = getEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const sb = createClient(URL_, getEnv("SUPABASE_SERVICE_ROLE_KEY"));
const brow = createClient(URL_, ANON);
const OVR = "cluster4_team_week_position_overrides";

let fail = 0;
let pass = 0;
const ck = (l: string, ok: boolean, d: unknown = "") => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${JSON.stringify(d)}` : ""}`);
};

async function cookieHeader(): Promise<string> {
  const { data: admins } = await sb.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = (admins as Array<{ email: string }> | null)?.[0]?.email;
  if (!email) throw new Error("admin 계정 없음");
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await brow.auth.verifyOtp({ email, token: link.properties.email_otp, type: "magiclink" });
  const cap: Array<{ name: string; value: string }> = [];
  const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session!.access_token, refresh_token: v.session!.refresh_token });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function main() {
  const cookie = await cookieHeader();
  const call = (path: string, init?: RequestInit) =>
    fetch(`${ADMIN}${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init?.headers ?? {}) }, cache: "no-store" }).then(
      async (r) => ({ status: r.status, j: await r.json().catch(() => null) }),
    );

  const ORG = "encre" as const;
  const MODE = "test";
  const TEAM = "사운드(T)";
  const { data: th } = await sb.from("cluster4_team_halves").select("id,team_name,half_key").eq("organization_slug", ORG).eq("team_name", TEAM).eq("half_key", "2026-H2").limit(1);
  const team = (th as Array<{ id: string; team_name: string; half_key: string }> | null)?.[0];
  if (!team) {
    console.log("대상 팀 없음 — abort");
    process.exit(1);
  }
  const WEEKS = {
    s5: { id: "954f56af-0c07-4246-ae7d-b476c5225b30", start: "2026-07-27", label: "여름5" },
    s6: { id: "2c359d24-2251-406d-aa40-c42917a52878", start: "2026-08-03", label: "여름6" },
    s7: { id: "1dc3bcec-7fff-43a0-ba84-e1a0565e3875", start: "2026-08-10", label: "여름7" },
    s8: { id: "fa11886e-e465-4b1e-accf-1ce6c13d146c", start: "2026-08-17", label: "여름8" },
  };
  const PART_A = "젤리검증";
  const PART_B = "마카롱검증";

  let createdPartIds: string[] = [];
  const cleanupUsers: string[] = [];
  try {
    for (const name of [PART_A, PART_B]) {
      const r = await call(`/api/admin/team-parts/info/team-detail/parts?mode=${MODE}`, {
        method: "POST",
        body: JSON.stringify({ organization: ORG, teamHalfId: team.id, name }),
      });
      ck(`파트 생성: ${name}`, r.status === 200 && r.j?.success, r.j);
    }
    const { data: parts } = await sb.from("cluster4_team_parts").select("id,part_name").eq("team_half_id", team.id);
    createdPartIds = ((parts ?? []) as Array<{ id: string; part_name: string }>)
      .filter((p) => p.part_name === PART_A || p.part_name === PART_B)
      .map((p) => p.id);

    const { data: mems } = await sb.from("user_memberships").select("user_id,part_name").eq("team_name", TEAM).eq("is_current", true);
    const memRows = (mems ?? []) as Array<{ user_id: string; part_name: string | null }>;
    const { data: profs } = await sb.from("user_profiles").select("user_id,role").in("user_id", memRows.map((m) => m.user_id));
    const { data: existingOvr } = await sb.from(OVR).select("user_id").eq("organization", ORG).eq("raw_team", TEAM);
    const dirty = new Set(((existingOvr ?? []) as Array<{ user_id: string }>).map((r) => r.user_id));
    const roleByUser = new Map(((profs ?? []) as Array<{ user_id: string; role: string | null }>).map((p) => [p.user_id, p.role]));
    const candidates = memRows.filter((m) => !dirty.has(m.user_id) && roleByUser.get(m.user_id) === "crew");
    ck("실험용 crew 2명 이상 확보(override 이력 없음)", candidates.length >= 2, candidates.length);
    const [userX, userY] = candidates;
    cleanupUsers.push(userX.user_id, userY.user_id);

    const partsAtWeek = async (weekStart: string): Promise<string[]> => {
      const r = await call(`/api/admin/team-parts/info?organization=${ORG}&half=${team.half_key}&mode=${MODE}`);
      const teamDto = r.j.data.teams.find((t: { teamName: string }) => t.teamName === TEAM);
      const cols = r.j.data.weekColumns as Array<{ weekStartDate: string }>;
      const ci = cols.findIndex((c) => c.weekStartDate === weekStart);
      return teamDto.partWeekMatrix.partNames.filter((_: string, pi: number) => teamDto.partWeekMatrix.present[pi][ci]);
    };
    const summaryAt = async (weekId: string) =>
      (await call(`/api/admin/team-parts/info/team-detail/week-summary?organization=${ORG}&teamHalfId=${team.id}&mode=${MODE}&weekId=${weekId}`)).j?.data;
    const patch = (weekId: string, rawTeam: string, changes: unknown[]) =>
      call(`/api/admin/team-parts/info/team-detail/week-position?mode=${MODE}`, {
        method: "PATCH",
        body: JSON.stringify({ organization: ORG, weekId, rawTeam, changes }),
      });

    console.log("\n=== 케이스 1: 여러 크루를 한 번에(배치) 이동 + 파트 0명↔1명 이상 전환 ===");
    {
      const r = await patch(WEEKS.s6.id, TEAM, [
        { userId: userX.user_id, rawPart: PART_A, positionCode: "regular" },
        { userId: userY.user_id, rawPart: PART_A, positionCode: "regular" },
      ]);
      ck("여름6: 2명 동시에 PART_A로 배치 저장", r.status === 200 && r.j?.success, r.j);
    }
    {
      const s6 = await summaryAt(WEEKS.s6.id);
      const partAcount = (s6.operatedParts ?? []).find((p: { partName: string }) => p.partName === PART_A)?.crewCount ?? 0;
      ck(`${WEEKS.s6.label}: ${PART_A} 운용(인원≥1)`, partAcount >= 2, partAcount);
    }
    for (const w of [WEEKS.s7, WEEKS.s8]) {
      const parts = await partsAtWeek(w.start);
      ck(`${w.label}: ${PART_A} 운용(매트릭스, 이월)`, parts.includes(PART_A), parts);
    }

    console.log("\n=== 케이스 2: 미래 주차(여름8)에 명시적 override 선(先)저장 → 이후 여름6 변경이 여름8을 훼손하지 않아야 함 ===");
    {
      const { error } = await sb.from(OVR).upsert(
        {
          user_id: userX.user_id,
          organization: ORG,
          week_id: WEEKS.s8.id,
          week_start_date: WEEKS.s8.start,
          raw_team: TEAM,
          raw_part: PART_B,
          position_code: "regular",
          created_by: "verify-script(explicit-future)",
          updated_by: "verify-script(explicit-future)",
        },
        { onConflict: "user_id,week_start_date,organization,raw_team" },
      );
      ck("여름8에 userX를 PART_B로 명시적 선(先)배정", !error, error?.message);
    }
    {
      const r = await patch(WEEKS.s6.id, TEAM, [{ userId: userX.user_id, rawPart: PART_B, positionCode: "regular" }]);
      ck("여름6: userX를 PART_B로 재저장", r.status === 200 && r.j?.success, r.j);
    }
    {
      const s6 = await summaryAt(WEEKS.s6.id);
      ck(
        "여름6: userX가 PART_B로 즉시 반영",
        s6.crewRows.find((r: { userId: string }) => r.userId === userX.user_id)?.rawPart === PART_B,
      );
      const parts7 = await partsAtWeek(WEEKS.s7.start);
      const parts8 = await partsAtWeek(WEEKS.s8.start);
      ck("여름7: PART_B 운용(여름6 변경 carry-forward, 매트릭스)", parts7.includes(PART_B), parts7);
      ck("여름8: PART_B 운용 유지(명시 선배정도 같은 값이라 무관하게 보존, 매트릭스)", parts8.includes(PART_B), parts8);
    }
    console.log("  (교차검증: 여름8 값을 PART_A로 다르게 선배정했을 때도 여름6 변경에 훼손되지 않는지 — resolver 직접 트레이스)");
    {
      const { error } = await sb.from(OVR).upsert(
        {
          user_id: userY.user_id,
          organization: ORG,
          week_id: WEEKS.s8.id,
          week_start_date: WEEKS.s8.start,
          raw_team: TEAM,
          raw_part: PART_A,
          position_code: "regular",
          created_by: "verify-script(explicit-future)",
          updated_by: "verify-script(explicit-future)",
        },
        { onConflict: "user_id,week_start_date,organization,raw_team" },
      );
      ck("여름8에 userY를 PART_A로 명시적 선(先)배정(여름6과 다른 값)", !error, error?.message);
      const rMid = await patch(WEEKS.s6.id, TEAM, [{ userId: userY.user_id, rawPart: PART_B, positionCode: "regular" }]);
      ck("여름6: userY를 PART_B로 저장(여름8과 다른 값)", rMid.status === 200 && rMid.j?.success);

      const pos = await resolvePositionAtWeeksBulk({
        userIds: [userY.user_id],
        weekStarts: [WEEKS.s6.start, WEEKS.s7.start, WEEKS.s8.start],
        organization: ORG,
      });
      const p6 = pos.get(WEEKS.s6.start)?.get(userY.user_id);
      const p7 = pos.get(WEEKS.s7.start)?.get(userY.user_id);
      const p8 = pos.get(WEEKS.s8.start)?.get(userY.user_id);
      ck("여름6: userY = PART_B(source=override)", p6?.rawPart === PART_B && p6?.source === "override", p6);
      ck("여름7: userY = PART_B(여름6 이월, source=override)", p7?.rawPart === PART_B && p7?.effectiveFromWeek === WEEKS.s6.start, p7);
      ck(
        "[핵심] 여름8: userY = PART_A(명시적 선배정 보존, source=override, effectiveFromWeek=여름8)",
        p8?.rawPart === PART_A && p8?.effectiveFromWeek === WEEKS.s8.start,
        p8,
      );
    }

    console.log(`\n=== RESULT: PASS ${pass} / FAIL ${fail} ===`);
  } finally {
    console.log("\n정리...");
    const { error: delOvrErr } = await sb.from(OVR).delete().eq("organization", ORG).eq("raw_team", TEAM).in("user_id", cleanupUsers);
    console.log("override 삭제:", delOvrErr?.message ?? "OK");
    if (createdPartIds.length) {
      const { error } = await sb.from("cluster4_team_parts").delete().in("id", createdPartIds);
      console.log("파트 삭제:", error?.message ?? "OK");
    }
  }
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

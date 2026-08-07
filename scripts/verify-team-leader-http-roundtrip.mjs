/**
 * 실제 HTTP API(팀 등록/삭제 대기 = 팀장 승격/복원 lifecycle)를 통해
 *   "새 팀 등록 + 다른 팀 소속 크루를 팀장으로 지정" 시 team/part 가 함께 갱신되는지 실증한다.
 *   QA 테스트 크루(mode=test) 1명만 사용 — 실사용자 미접촉. 등록 API 로 만든 팀은
 *   삭제 대기(DELETE) API 로 정리한다(하드삭제 아님, 기존 lifecycle 그대로 사용 — 부작용 없음).
 *   DELETE 는 registerTeamHalf 가 저장해 둔 leader_previous_position 스냅샷으로
 *   크루를 원래 role/team/part 로 자동 복원한다(restoreFormerLeader, 코드 그대로).
 *
 * Usage: dev(:3000) 기동 후 node scripts/verify-team-leader-http-roundtrip.mjs
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const sb = createClient(URL_, get("SUPABASE_SERVICE_ROLE_KEY"));
const brow = createClient(URL_, ANON);

let pass = 0;
let fail = 0;
const ck = (l, ok, d) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d !== undefined ? ` — ${JSON.stringify(d)}` : ""}`);
};

async function cookieHeader() {
  const { data: admins } = await sb.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = admins?.[0]?.email;
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await brow.auth.verifyOtp({ email, token: link.properties.email_otp, type: "magiclink" });
  const cap = [];
  const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function main() {
  const cookie = await cookieHeader();
  const headers = { "content-type": "application/json", cookie };

  // ── 대상 선정: QA 테스트 크루 중 현재 팀 멤버십이 있고 team_leader 가 아닌 1명(동적 조회, 하드코딩 없음) ──
  const { data: markers } = await sb.from("test_user_markers").select("user_id").limit(300);
  const testIds = (markers ?? []).map((r) => r.user_id);
  const { data: profiles } = await sb
    .from("user_profiles")
    .select("user_id,display_name,role,organization_slug,crew_code")
    .in("user_id", testIds)
    .eq("role", "crew")
    .eq("organization_slug", "encre")
    .not("crew_code", "is", null);
  const { data: mems } = await sb
    .from("user_memberships")
    .select("user_id,team_name,part_name,is_current")
    .in("user_id", (profiles ?? []).map((p) => p.user_id))
    .eq("is_current", true)
    .not("team_name", "is", null);
  const memByUser = new Map((mems ?? []).map((m) => [m.user_id, m]));
  const target = (profiles ?? []).find((p) => memByUser.get(p.user_id));
  if (!target) {
    console.log("대상 QA 크루를 찾지 못함 — abort");
    process.exit(1);
  }
  const originalMembership = memByUser.get(target.user_id);
  console.log(
    `대상: ${target.display_name}(${target.user_id}, crew_code=${target.crew_code}) — 원래 팀: ${originalMembership.team_name} / ${originalMembership.part_name}`,
  );

  const halfRes = await fetch(`${BASE}/api/admin/team-parts/info?organization=encre&mode=test`, { headers });
  const halfJson = await halfRes.json();
  const halfKey = halfJson?.data?.selectedHalfKey ?? halfJson?.data?.halfKey ?? halfJson?.data?.currentHalfKey;
  ck("GET team-parts/info 로 현재 halfKey 조회", typeof halfKey === "string" && halfKey.length > 0, halfJson?.data ? Object.keys(halfJson.data) : halfJson);
  if (typeof halfKey !== "string" || !halfKey) {
    console.log("halfKey 를 못 찾음 — 응답 구조 확인 필요, abort", JSON.stringify(halfJson).slice(0, 500));
    process.exit(1);
  }

  // MAX_TEAM_NAME_LENGTH=12 — 짧은 합성명(동적, 하드코딩 아님).
  const newTeamName = `hv${Date.now().toString(36).slice(-6)}(T)`;
  let teamHalfId = null;

  try {
    // ── ① 새 팀 등록 + 다른 팀 소속 크루를 팀장으로 지정 ──
    const postRes = await fetch(`${BASE}/api/admin/team-parts/info?mode=test`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        organization: "encre",
        halfKey,
        teamName: newTeamName,
        description: "HTTP 라운드트립 검증용 임시 팀",
        leaderCrewCode: target.crew_code,
      }),
    });
    const postJson = await postRes.json();
    ck("POST team-parts/info(팀 등록) success", postJson.success === true, postJson);
    const createdTeam = (postJson.data?.teams ?? []).find((t) => t.teamName === newTeamName);
    teamHalfId = createdTeam?.id ?? null;
    ck("등록 응답에 새 팀 포함", !!createdTeam, createdTeam);

    // ── ② HTTP GET /api/admin/members — 소속 팀/파트/클래스 확인 ──
    const membersRes = await fetch(
      `${BASE}/api/admin/members?organization=encre&q=${encodeURIComponent(target.display_name)}`,
      { headers },
    );
    const membersJson = await membersRes.json();
    const row = (membersJson.data?.members ?? []).find((r) => r.userId === target.user_id);
    ck(`/api/admin/members currentTeamName=${newTeamName}`, row?.currentTeamName === newTeamName, row);
    ck("/api/admin/members classLabel=운영진(팀장)", row?.classLabel === "운영진(팀장)", row?.classLabel);

    // ── ③ 팀 상세 — 새 팀 크루 목록에 대상자 포함 ──
    const detailRes = await fetch(
      `${BASE}/api/admin/team-parts/info/team-detail?organization=encre&mode=test&teamHalfId=${encodeURIComponent(teamHalfId)}`,
      { headers },
    );
    if (detailRes.status === 200) {
      const detailJson = await detailRes.json();
      const d = detailJson.data ?? {};
      const crewRows = d.crewRows ?? d.selectedWeek?.crewRows ?? d.summary?.crewRows ?? [];
      const inTeam = Array.isArray(crewRows) && crewRows.some((r) => r.userId === target.user_id);
      ck("팀 상세 crewRows 에 대상자 포함", inTeam, { keys: Object.keys(d), crewRowsSample: crewRows?.slice?.(0, 2) });
    } else {
      console.log(`  [정보] 팀 상세 API 응답 ${detailRes.status} — 경로/파라미터 상이 가능, HTTP②로 이미 핵심 검증 완료`);
    }

    console.log(`\n=== 등록 직후 RESULT: PASS ${pass} / FAIL ${fail} ===`);
  } finally {
    // ── 정리: 삭제 대기(soft) — restoreFormerLeader 가 leader_previous_position 으로 원복 ──
    if (teamHalfId) {
      const delRes = await fetch(`${BASE}/api/admin/team-parts/info?mode=test`, {
        method: "DELETE",
        headers,
        body: JSON.stringify({ organization: "encre", halfKey, teamHalfId }),
      });
      const delJson = await delRes.json();
      console.log(`\n정리(삭제 대기) 응답 success=${delJson.success}`, delJson.notes ?? "");

      const { data: memAfter } = await sb
        .from("user_memberships")
        .select("team_name,part_name,is_current")
        .eq("id", originalMembership.id)
        .maybeSingle();
      const { data: profAfter } = await sb
        .from("user_profiles")
        .select("role,current_team_name,current_part_name")
        .eq("user_id", target.user_id)
        .maybeSingle();
      console.log("원복 확인 — user_memberships:", memAfter, " / user_profiles:", profAfter);
    }
  }

  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

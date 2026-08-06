/**
 * 운용 파트 carry-forward 회귀 검증(2026-08) — 실제 HTTP.
 *
 * 시나리오 A: 파트 운용 종료 전파
 *   여름1(과거, PATCH) 쿠키파트 배정 → 여름1~8·가을1 전부 ● (기존 carry-forward, 무회귀 확인)
 *   여름6(오늘=현재주차, PATCH) 쿠키파트 크루를 다른 파트로 이동 → 여름6·7·8·가을1 전부 미운용,
 *   여름1~5 는 불변(●) 이어야 한다. 여름7·8·가을1 은 "미래 주차"(오늘=여름6 기준) — 이번에 고친
 *   드리프트 가드가 정확히 이 구간을 겨냥한다.
 *
 * 시나리오 B: 파트 운용 재개
 *   가을1 은 관리자 UI(PATCH)로 편집 불가한 미래 주차라 실제로는 "그 주차가 되면" 저장하는 것과
 *   동일하게 override 테이블에 직접 upsert 한다(운영 정책상 미래 주차 편집을 막아 놨을 뿐, 저장
 *   메커니즘 자체는 동일 — PATCH 라우트가 하는 일도 이 upsert 다). 이후 GET 은 전부 HTTP.
 *   가을1 에 쿠키파트로 명시 재배정 → 가을1 만 운용 재개, 여름6~8 은 불변(미운용 유지).
 *
 * 사전조건: dev :3000 기동. 대상 = encre QA 팀 "사운드(T)"(2026-H2). 종료 후 전부 원복(override 삭제·
 *   생성 파트 삭제).
 * Usage: node scripts/verify-team-parts-operated-carry-forward-http.mjs
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const ADMIN = "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const sb = createClient(URL_, get("SUPABASE_SERVICE_ROLE_KEY"));
const brow = createClient(URL_, ANON);
const OVR = "cluster4_team_week_position_overrides";

let fail = 0;
let pass = 0;
const ck = (l, ok, d = "") => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${JSON.stringify(d)}` : ""}`);
};

async function cookieHeader() {
  const { data: admins } = await sb
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  const email = admins?.[0]?.email;
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await brow.auth.verifyOtp({
    email,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  const cap = [];
  const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  console.log(`admin 세션: ${email}`);
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function main() {
  const cookie = await cookieHeader();
  const call = (path, init) =>
    fetch(`${ADMIN}${path}`, {
      ...init,
      headers: { cookie, "content-type": "application/json", ...(init?.headers ?? {}) },
      cache: "no-store",
    }).then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) }));

  const ORG = "encre";
  const MODE = "test";
  const TEAM = "사운드(T)";
  const { data: th } = await sb
    .from("cluster4_team_halves")
    .select("id,team_name,half_key")
    .eq("organization_slug", ORG)
    .eq("team_name", TEAM)
    .eq("half_key", "2026-H2")
    .eq("is_active", true)
    .limit(1);
  const team = th?.[0];
  if (!team) {
    console.log("대상 QA 팀 없음 — abort");
    process.exit(1);
  }
  console.log(`대상: ${ORG} / ${TEAM} (teamHalfId=${team.id})`);

  // 대상 테스트 크루 — 기존 override 이력이 없고, role=crew(팀 파트 배정 대상 3종 클래스)인 유저.
  const { data: existingOvr } = await sb.from(OVR).select("user_id").eq("organization", ORG).eq("raw_team", TEAM);
  const dirtyUserIds = new Set((existingOvr ?? []).map((r) => r.user_id));
  const { data: mems } = await sb
    .from("user_memberships")
    .select("user_id,part_name")
    .eq("team_name", TEAM)
    .eq("is_current", true);
  const memIds = (mems ?? []).map((m) => m.user_id);
  const { data: profs } = await sb.from("user_profiles").select("user_id,role").in("user_id", memIds);
  const roleByUser = new Map((profs ?? []).map((p) => [p.user_id, p.role]));
  const candidate = (mems ?? []).find((m) => !dirtyUserIds.has(m.user_id) && roleByUser.get(m.user_id) === "crew");
  if (!candidate) {
    console.log("override 이력 없는 crew 테스트 크루를 찾지 못함 — abort");
    process.exit(1);
  }
  const USER = candidate.user_id;
  const { data: uprof } = await sb.from("user_profiles").select("display_name").eq("user_id", USER).limit(1);
  console.log(`대상 크루: ${uprof?.[0]?.display_name} (${USER}), 라이브 멤버십 파트=${candidate.part_name}`);

  const WEEKS = {
    s1: { id: "496656d0-8d92-4738-b69b-e5e28aa1d57a", label: "여름1", start: "2026-06-29" },
    s5: { id: "954f56af-0c07-4246-ae7d-b476c5225b30", label: "여름5", start: "2026-07-27" },
    s6: { id: "2c359d24-2251-406d-aa40-c42917a52878", label: "여름6", start: "2026-08-03" },
    s7: { id: "1dc3bcec-7fff-43a0-ba84-e1a0565e3875", label: "여름7", start: "2026-08-10" },
    s8: { id: "fa11886e-e465-4b1e-accf-1ce6c13d146c", label: "여름8", start: "2026-08-17" },
    a1: { id: "dbf5d7e1-6de3-4960-b4ff-9f31fba276de", label: "가을1", start: "2026-08-31" },
  };
  const COOKIE_PART = "쿠키검증";
  const OTHER_PART = "마카롱검증";

  const createdOverrideCleanupWeeks = [];
  let createdPartIds = [];
  const originalLivePart = candidate.part_name;

  try {
    // ── 0) 테스트 전용 파트 2개 생성(기존 카탈로그 오염 방지 — 접미사로 식별) ──
    // 라이브 멤버십을 먼저 쿠키파트로 맞춘다 — 실제 버그 재현 조건("그 파트에 실제로 있던 크루")과
    //   같게 만들어야 한다. override 저장(PATCH week-position)은 user_memberships 를 건드리지 않으므로,
    //   라이브 멤버십과 override 값이 처음부터 다르면 드리프트 가드가 "사전" 단계부터 작동해 결과를
    //   오염시킨다(실제로 1차 실행에서 이 문제로 오탐 1건 발생 — 아래 [사전] 가을1 참고 주석).
    for (const name of [COOKIE_PART, OTHER_PART]) {
      const r = await call(`/api/admin/team-parts/info/team-detail/parts?mode=${MODE}`, {
        method: "POST",
        body: JSON.stringify({ organization: ORG, teamHalfId: team.id, name }),
      });
      ck(`파트 생성: ${name}`, r.status === 200 && r.j?.success, r.j);
    }
    const { data: parts } = await sb.from("cluster4_team_parts").select("id,part_name").eq("team_half_id", team.id);
    createdPartIds = (parts ?? []).filter((p) => p.part_name === COOKIE_PART || p.part_name === OTHER_PART).map((p) => p.id);

    // 라이브 멤버십을 쿠키파트로 정렬(드리프트 가드가 "사전" 단계에서 오탐하지 않도록).
    {
      const { error } = await sb
        .from("user_memberships")
        .update({ part_name: COOKIE_PART })
        .eq("user_id", USER)
        .eq("team_name", TEAM)
        .eq("is_current", true);
      ck("라이브 멤버십 쿠키파트로 정렬", !error, error?.message);
    }

    const matrixOf = async () => {
      const r = await call(`/api/admin/team-parts/info?organization=${ORG}&half=${team.half_key}&mode=${MODE}`);
      const teamDto = (r.j?.data?.teams ?? []).find((t) => t.teamName === TEAM);
      const cols = r.j?.data?.weekColumns ?? [];
      return { cols, matrix: teamDto?.partWeekMatrix ?? null };
    };
    const operatedAt = async (weekStart) => {
      const { cols, matrix } = await matrixOf();
      const ci = cols.findIndex((c) => c.weekStartDate === weekStart);
      if (ci < 0 || !matrix) return null;
      const pi = matrix.partNames.indexOf(COOKIE_PART);
      if (pi < 0) return false;
      return Boolean(matrix.present[pi][ci]);
    };
    const summaryAt = async (weekId) => {
      const r = await call(
        `/api/admin/team-parts/info/team-detail/week-summary?organization=${ORG}&teamHalfId=${team.id}&mode=${MODE}&weekId=${weekId}`,
      );
      return r.j?.data;
    };

    console.log("\n=== 시나리오 A: 파트 운용 종료 전파 ===");

    // ── 1) 여름1(과거, editable) — 쿠키파트로 명시 배정. carry-forward 로 5·6·7·8·가을1 까지 이어져야
    //      "정상 carry-forward"가 무회귀임을 먼저 확인한다.
    {
      const r = await call(`/api/admin/team-parts/info/team-detail/week-position?mode=${MODE}`, {
        method: "PATCH",
        body: JSON.stringify({
          organization: ORG,
          weekId: WEEKS.s1.id,
          rawTeam: TEAM,
          changes: [{ userId: USER, rawPart: COOKIE_PART, positionCode: "regular" }],
        }),
      });
      ck("여름1 PATCH(쿠키 배정) 200", r.status === 200 && r.j?.success, r.j);
      createdOverrideCleanupWeeks.push(WEEKS.s1.start);
    }
    for (const w of [WEEKS.s1, WEEKS.s5, WEEKS.s6, WEEKS.s7, WEEKS.s8, WEEKS.a1]) {
      const op = await operatedAt(w.start);
      ck(`[사전] ${w.label} 쿠키 운용 = true(기존 carry-forward 무회귀)`, op === true, { week: w.start, op });
    }

    // ── 2) 여름6(오늘=현재주차, editable) — 쿠키파트 크루를 다른 파트로 이동("모두 제거"에 해당) ──
    {
      const r = await call(`/api/admin/team-parts/info/team-detail/week-position?mode=${MODE}`, {
        method: "PATCH",
        body: JSON.stringify({
          organization: ORG,
          weekId: WEEKS.s6.id,
          rawTeam: TEAM,
          changes: [{ userId: USER, rawPart: OTHER_PART, positionCode: "regular" }],
        }),
      });
      ck("여름6 PATCH(다른 파트로 이동) 200", r.status === 200 && r.j?.success, r.j);
      createdOverrideCleanupWeeks.push(WEEKS.s6.start);
    }

    for (const w of [WEEKS.s1, WEEKS.s5]) {
      const op = await operatedAt(w.start);
      ck(`[불변] ${w.label} 쿠키 운용 = true(과거 불변)`, op === true, { week: w.start, op });
    }
    for (const w of [WEEKS.s6, WEEKS.s7, WEEKS.s8, WEEKS.a1]) {
      const op = await operatedAt(w.start);
      ck(`[핵심] ${w.label} 쿠키 운용 = false(미운용 carry-forward, 시즌경계 포함)`, op === false, {
        week: w.start,
        op,
      });
    }
    // [A] 선택 주차 요약(week-summary) 으로도 동일하게 교차 검증 — 매트릭스와 같은 SoT 라 값이 같아야 한다.
    for (const w of [WEEKS.s6, WEEKS.s7]) {
      const s = await summaryAt(w.id);
      const hasCookie = (s?.operatedParts ?? []).some((p) => p.partName === COOKIE_PART);
      ck(`[A] ${w.label} operatedParts 에 쿠키 없음`, hasCookie === false, s?.operatedParts);
    }

    console.log("\n=== 시나리오 B: 파트 운용 재개(가을1 명시 재배정) ===");
    // 가을1 은 관리자 UI 로는 편집 불가한 미래 주차(관리 정책) — PATCH 라우트가 하는 것과 동일한
    //   upsert 를 직접 실행해 "그 주차가 실제로 되면 저장한다"를 시뮬레이션한다.
    {
      const { error } = await sb.from(OVR).upsert(
        {
          user_id: USER,
          organization: ORG,
          week_id: WEEKS.a1.id,
          week_start_date: WEEKS.a1.start,
          raw_team: TEAM,
          raw_part: COOKIE_PART,
          position_code: "regular",
          created_by: "verify-script",
          updated_by: "verify-script",
        },
        { onConflict: "user_id,week_start_date,organization,raw_team" },
      );
      ck("가을1 override 직접 upsert(재배정) 성공", !error, error?.message);
    }
    for (const w of [WEEKS.s6, WEEKS.s7, WEEKS.s8]) {
      const op = await operatedAt(w.start);
      ck(`[불변] ${w.label} 쿠키 운용 = false(재배정 이전 주차는 영향 없음)`, op === false, { week: w.start, op });
    }
    {
      const op = await operatedAt(WEEKS.a1.start);
      ck("[핵심] 가을1 쿠키 운용 = true(명시 재배정으로 재개)", op === true, { op });
    }

    console.log(`\n=== RESULT: PASS ${pass} / FAIL ${fail} ===`);
  } finally {
    // ── 정리 — 이번에 만든 override 행/파트/라이브 멤버십 변경만 원복(대상 1명·이 팀 한정). ──
    console.log("\n정리 중...");
    const { error: restoreErr } = await sb
      .from("user_memberships")
      .update({ part_name: originalLivePart })
      .eq("user_id", USER)
      .eq("team_name", TEAM)
      .eq("is_current", true);
    console.log("라이브 멤버십 원복:", restoreErr?.message ?? `OK(${originalLivePart})`);
    const { error: delOvrErr } = await sb
      .from(OVR)
      .delete()
      .eq("organization", ORG)
      .eq("raw_team", TEAM)
      .eq("user_id", USER)
      .in("week_start_date", [...new Set(createdOverrideCleanupWeeks), WEEKS.a1.start]);
    console.log("override 삭제:", delOvrErr?.message ?? "OK");
    if (createdPartIds.length) {
      const { error: delPartErr } = await sb.from("cluster4_team_parts").delete().in("id", createdPartIds);
      console.log("파트 삭제:", delPartErr?.message ?? "OK");
    }
    const { data: remain } = await sb.from(OVR).select("id").eq("organization", ORG).eq("raw_team", TEAM).eq("user_id", USER);
    console.log("잔여 override 행(그 유저·그 팀):", remain?.length ?? "?");
  }

  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

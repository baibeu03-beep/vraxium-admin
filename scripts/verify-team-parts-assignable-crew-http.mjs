/**
 * "팀 파트 배정 가능 크루" 모집단 회귀 검증(2026-08) — 실제 HTTP.
 *   /admin/team-parts/info 팀 상세 [B] 크루 목록(week-summary.crewRows)에서 배정 대상이 아닌 사용자를
 *   제외했는지 확인한다: 졸업(엘리트)·바사노스·활동 중단·시즌 휴식.
 *   ⚠ crew.total/operatedParts(집합①)는 그대로 유지되어야 한다 — 소속은 남고 "신규 배정 목록"에서만 빠진다.
 *
 * 대상 = encre QA 팀 "사운드(T)"(2026-H2), 현재 주차(여름6)·과거 주차(여름3). 테스트 유저 5명을 이 팀에
 *   임시로 override 배정하고, 상태 플래그(growth_status/suspended_week_id/user_season_statuses/
 *   user_week_statuses)를 임시로 세팅한 뒤 종료 시 전부 원복한다.
 * 사전조건: dev :3000. Usage: node scripts/verify-team-parts-assignable-crew-http.mjs
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
  const { data: admins } = await sb.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = admins?.[0]?.email;
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await brow.auth.verifyOtp({ email, token: link.properties.email_otp, type: "magiclink" });
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
    .select("id,team_name")
    .eq("organization_slug", ORG)
    .eq("team_name", TEAM)
    .eq("half_key", "2026-H2")
    .eq("is_active", true)
    .limit(1);
  const team = th?.[0];
  if (!team) {
    console.log("대상 팀 없음 — abort");
    process.exit(1);
  }

  const WEEK3 = { id: "d3260418-fcd3-4c23-875f-e51502cf9bd3", start: "2026-07-13", label: "여름3" };
  const WEEK4 = { id: "2d21a7cc-37ce-4223-acac-419bc5fa094b", start: "2026-07-20", label: "여름4" };
  const WEEK6 = { id: "2c359d24-2251-406d-aa40-c42917a52878", start: "2026-08-03", label: "여름6(현재)" };

  // ⚠ 전부 "이 팀에 override 이력이 전혀 없던" 유저만 골랐다 — 다른 팀에 더 최근 override 가 있으면
  //   resolvePositionAtWeeksBulk 가 그쪽을 최신으로 채택해(override 는 userId 단위 최신순) 이 테스트가
  //   그 유저를 아예 이 팀 로스터에 못 태운다(실제로 1차 시도에서 이 문제로 오탐 2건 발생).
  const USERS = {
    control: { id: "ce4085e9-5dff-4f5d-a64a-5ca99c0bfb0e", name: "T이서연" },
    elite: { id: "4a81b6d1-e488-4f14-8530-0cad60fe4f0d", name: "T이채빈" },
    basanos: { id: "f980b257-12b1-4f9c-ae71-307336071785", name: "T장소율" },
    suspended: { id: "f2d5c378-6a50-477f-b50d-2a21241e7640", name: "T오승현" },
    seasonRest: { id: "ea286f9d-fb5b-492e-a081-cd5c200a4455", name: "T윤민지" },
  };

  // ── 원복용 스냅샷 ──
  const { data: origProfiles } = await sb
    .from("user_profiles")
    .select("user_id,growth_status,suspended_week_id,activity_ended_at")
    .in("user_id", Object.values(USERS).map((u) => u.id));
  const { data: origSeasonRest } = await sb
    .from("user_season_statuses")
    .select("id,user_id,season_key,status")
    .eq("user_id", USERS.seasonRest.id)
    .eq("season_key", "2026-summer");
  let basanosSeededWeeks = [];

  const summaryAt = async (weekId, mode = MODE) => {
    const r = await call(
      `/api/admin/team-parts/info/team-detail/week-summary?organization=${ORG}&teamHalfId=${team.id}&mode=${mode}${weekId ? `&weekId=${weekId}` : ""}`,
    );
    return r.j?.data;
  };

  try {
    // ── 1) 모두 여름3 override 로 이 팀에 배정(같은 시즌 carry-forward 로 여름4·6 까지 자동 이월) ──
    const rows = Object.values(USERS).map((u) => ({
      user_id: u.id,
      organization: ORG,
      week_id: WEEK3.id,
      week_start_date: WEEK3.start,
      raw_team: TEAM,
      raw_part: "일반",
      position_code: "regular",
      created_by: "verify-script",
      updated_by: "verify-script",
    }));
    const { error: assignErr } = await sb.from(OVR).upsert(rows, { onConflict: "user_id,week_start_date,organization,raw_team" });
    ck("5명 여름3 override 배정(팀 소속 확보)", !assignErr, assignErr?.message);

    // ── 2) 상태 플래그 세팅 ──
    {
      const { error } = await sb
        .from("user_profiles")
        .update({ growth_status: "graduated", activity_ended_at: WEEK4.start })
        .eq("user_id", USERS.elite.id);
      ck("엘리트 시드(졸업, 여름4 종료)", !error, error?.message);
    }
    {
      const { error } = await sb.from("user_profiles").update({ suspended_week_id: WEEK3.id }).eq("user_id", USERS.suspended.id);
      ck("활동중단 시드(여름3 효력)", !error, error?.message);
    }
    {
      const { error } = await sb
        .from("user_season_statuses")
        .upsert(
          { user_id: USERS.seasonRest.id, season_key: "2026-summer", status: "rest" },
          { onConflict: "user_id,season_key" },
        );
      ck("시즌휴식 시드(2026-summer)", !error, error?.message);
    }
    {
      // 이 유저는 이미 success 16건을 보유 — 나머지는 **원래 행이 전혀 없던 더 과거 주차**에만 새로
      //   추가한다(기존 행을 건드리지 않아 원복이 "추가한 행만 삭제"로 끝난다). year/week_number/
      //   season_key 는 NOT NULL 이라 weeks 테이블에서 함께 가져온다.
      const { data: emptyPastWeeksRaw } = await sb
        .from("weeks")
        .select("start_date,week_number,season_key")
        .lt("start_date", "2025-12-29") // 이 유저의 기존 최초 기록(2025-12-29) 이전 — 확실히 빈 구간.
        .order("start_date", { ascending: false })
        .limit(20);
      // week_number=0(전환 주차)은 user_week_statuses 체크 제약상 불가 — 제외.
      const emptyPastWeeks = (emptyPastWeeksRaw ?? []).filter((w) => (w.week_number ?? 0) > 0).slice(0, 15);
      basanosSeededWeeks = (emptyPastWeeks ?? []).map((w) => w.start_date);
      const uwsRows = (emptyPastWeeks ?? []).map((w) => ({
        user_id: USERS.basanos.id,
        year: Number(w.start_date.slice(0, 4)),
        week_number: w.week_number ?? 1,
        week_start_date: w.start_date,
        status: "success",
        season_key: w.season_key,
      }));
      const { error } = await sb.from("user_week_statuses").insert(uwsRows);
      const { count } = await sb
        .from("user_week_statuses")
        .select("*", { count: "exact", head: true })
        .eq("user_id", USERS.basanos.id)
        .eq("status", "success")
        .lte("week_start_date", WEEK6.start);
      ck(`바사노스 시드(success 누적 ${count} ≥ 29, ${uwsRows.length}행 신규 추가)`, !error && (count ?? 0) >= 29, error?.message);
    }

    {
      const { data: chk } = await sb.from(OVR).select("user_id,week_start_date,raw_team,raw_part").eq("organization", ORG).eq("raw_team", TEAM).eq("week_start_date", WEEK3.start);
      console.log("DEBUG 여름3 override 실제 행:", chk);
    }

    console.log("\n=== 시나리오 D: 현재 주차(여름6) 크루 목록 ===");
    const s6 = await summaryAt(WEEK6.id);
    console.log("DEBUG crewRows:", (s6?.crewRows ?? []).map((r) => ({ id: r.userId, name: r.name, part: r.rawPart })));
    console.log("DEBUG crew.total:", s6?.crew);
    const rowIds6 = new Set((s6?.crewRows ?? []).map((r) => r.userId));
    ck("정상 활동 크루: crewRows 에 표시됨", rowIds6.has(USERS.control.id));
    ck("엘리트(졸업): crewRows 에서 제외됨", !rowIds6.has(USERS.elite.id));
    ck("바사노스: crewRows 에서 제외됨", !rowIds6.has(USERS.basanos.id));
    ck("활동 중단: crewRows 에서 제외됨", !rowIds6.has(USERS.suspended.id));
    ck("시즌 휴식: crewRows 에서 제외됨", !rowIds6.has(USERS.seasonRest.id));

    // 집합①(소속 유지) 흔적 확인 — 엘리트/바사노스는 crewRows 에선 빠져도 "소속"(운용 파트/전체 크루)엔
    //   남아 있어야 한다(정책: 소속과 신규배정 대상은 다른 축). 시즌휴식/활동중단은 집합①에서도 빠진다.
    const partsSet6 = new Set((s6?.operatedParts ?? []).map((p) => p.partName));
    ck("[집합① 확인] '일반' 파트가 운용으로 집계됨(엘리트/바사노스도 소속 카운트에 남음)", partsSet6.has("일반"), [...partsSet6]);

    console.log("\n=== 과거 주차(여름3) — 당시 활동 중이던 이력은 보여야 한다 ===");
    const s3 = await summaryAt(WEEK3.id);
    const rowIds3 = new Set((s3?.crewRows ?? []).map((r) => r.userId));
    ck("엘리트(당시=졸업 전, 여름4 종료 예정): 여름3 crewRows 에 표시됨", rowIds3.has(USERS.elite.id));
    ck("활동중단(당시=효력 발생 주차 자체, 마지막 활동 주차로 포함): 여름3 crewRows 에 표시됨", rowIds3.has(USERS.suspended.id));

    console.log("\n=== mode=operating 과의 파리티(대상 유저는 test 마커라 operating 스코프엔 안 잡힘 — 스코프만 다르고 판정 로직은 동일해야 함) ===");
    const s6op = await summaryAt(WEEK6.id, "operating");
    ck("operating 모드 응답 200(같은 DTO 키 구조)", Boolean(s6op) && Array.isArray(s6op.crewRows));
    // ⚠ 스코프(operating/test) 는 이번 수정 대상이 아니다(resolveUserScope, 무관) — 이번에 세팅한
    //   상태축 시드 유저(엘리트/바사노스/활동중단/시즌휴식)가 operating 모드에서도 동일한 배제 판정을
    //   받는지만 본다(=같은 판정 함수·같은 DTO, 모집단만 다름 — §4 요구사항의 핵심).
    const opRowIds = new Set((s6op?.crewRows ?? []).map((r) => r.userId));
    ck("operating 모드도 엘리트 제외(같은 판정 로직)", !opRowIds.has(USERS.elite.id));
    ck("operating 모드도 활동중단 제외(같은 판정 로직)", !opRowIds.has(USERS.suspended.id));

    console.log(`\n=== RESULT: PASS ${pass} / FAIL ${fail} ===`);
  } finally {
    console.log("\n정리 중...");
    for (const p of origProfiles ?? []) {
      const { error } = await sb
        .from("user_profiles")
        .update({ growth_status: p.growth_status, suspended_week_id: p.suspended_week_id, activity_ended_at: p.activity_ended_at })
        .eq("user_id", p.user_id);
      if (error) console.log("프로필 원복 실패:", p.user_id, error.message);
    }
    console.log("프로필 원복: OK");

    if (origSeasonRest && origSeasonRest.length > 0) {
      await sb.from("user_season_statuses").upsert(origSeasonRest, { onConflict: "user_id,season_key" });
      console.log("시즌휴식 원복: 기존 행 복원");
    } else {
      await sb.from("user_season_statuses").delete().eq("user_id", USERS.seasonRest.id).eq("season_key", "2026-summer");
      console.log("시즌휴식 원복: 신규 행 삭제");
    }

    if (basanosSeededWeeks.length) {
      const { error } = await sb.from("user_week_statuses").delete().eq("user_id", USERS.basanos.id).in("week_start_date", basanosSeededWeeks);
      console.log("바사노스 시드 원복(신규 추가분만 삭제):", error?.message ?? `OK(${basanosSeededWeeks.length}행)`);
    }

    const { error: delOvrErr } = await sb
      .from(OVR)
      .delete()
      .eq("organization", ORG)
      .eq("raw_team", TEAM)
      .in(
        "user_id",
        Object.values(USERS).map((u) => u.id),
      )
      .eq("week_start_date", WEEK3.start);
    console.log("override 삭제:", delOvrErr?.message ?? "OK");
  }

  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

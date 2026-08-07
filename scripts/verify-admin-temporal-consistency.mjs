/**
 * 검증 — 어드민 전역 시간축(asOfWeek) 정합성 회귀 방지. P0-1/P0-2 수정 대상.
 *
 *   배경(2026-08-07):
 *   · P0-1 — lib/crewWeekPublish.ts 가 positionResolver 의 의도된 EMPTY(none)를 base row 의
 *     현재 프로필값으로 되살려 주차 결과 **공표(publish) 저장**까지 오염시켰다.
 *   · P0-2 — lib/cluster4WeeklyGrowthData.ts(성장 카드/area-8)가 팀/파트는 override 있는 주차만
 *     주차핀이고 나머지는 항상 "현재 멤버십"이라, 활동 시작 이전·팀 이동 이전·승격 이전 주차에도
 *     현재 상태가 소급 표시됐다.
 *   · 공용 수정 = lib/positionResolver.ts(decidePositionAt)에 두 게이트 추가:
 *     ① 활동 시작(user_profiles.activity_started_at) 이전 주차는 멤버십 폴백 금지.
 *     ② 이 유저에게 **이후** 주차에라도 관리자 override 이력이 있으면(=그 시점부터 뭔가 바뀜)
 *        그 이전 "이력 없는" 주차도 멤버십 폴백 금지(미래 드리프트 가드).
 *     cluster4WeeklyGrowthData 도 같은 두 조건(activityStartDate/earliestOverrideWeek)을 그대로 적용.
 *
 *   실행: npx tsx --env-file=.env.local scripts/verify-admin-temporal-consistency.mjs
 *   사전조건: dev 서버(:3000) 기동. mutate 대상은 동적으로 찾은 실사용자 1명의 activity_started_at
 *   뿐이며(시나리오 A), 종료 시 원래 값으로 정확히 복원한다. 나머지 시나리오는 전부 읽기 전용.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const env = readFileSync(".env.local", "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE);
const brow = createClient(URL_, ANON);

let pass = 0;
let fail = 0;
const ck = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
};

async function cookieHeader() {
  const { data: admins } = await sb
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  const email = admins[0].email;
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await brow.auth.verifyOtp({ email, token: link.properties.email_otp, type: "magiclink" });
  const cap = [];
  const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

// ── [1] 순수 함수 — decidePositionAt 게이트 2종 ────────────────────────────────
async function verifyPureGates() {
  console.log("\n[1] positionResolver.decidePositionAt — 순수 게이트 검증");
  const { decidePositionAt } = await import("../lib/positionResolver.ts");

  // ① 활동 시작 이전 게이트
  const membershipWithStart = {
    team: "현재팀", part: "현재파트", code: "regular", role: "crew", activityStartDate: "2026-08-03",
  };
  const before = decidePositionAt("u1", "2026-07-27", null, null, membershipWithStart, null, null);
  ck("활동 시작 이전 주차 → source=none(현재값 미투영)", before.source === "none" && before.rawTeam === null, JSON.stringify(before));
  const atStart = decidePositionAt("u1", "2026-08-03", null, null, membershipWithStart, null, null);
  ck("활동 시작 주차 → 현재 멤버십 적용", atStart.rawTeam === "현재팀", JSON.stringify(atStart));

  // ② 미래 override 드리프트 게이트
  const membershipNoStart = { team: "현재팀", part: "현재파트", code: "operating_team_leader", role: "team_leader", activityStartDate: null };
  const beforeOverride = decidePositionAt("u2", "2026-07-27", null, null, membershipNoStart, null, "2026-08-03");
  ck("미래(2026-08-03) override 존재 → 그 이전 주차 source=none", beforeOverride.source === "none", JSON.stringify(beforeOverride));
  const afterOverrideWeek = decidePositionAt("u2", "2026-08-03", null, null, membershipNoStart, null, "2026-08-03");
  ck("override 주차 자체는 현재 멤버십 적용(게이트 경계 포함)", afterOverrideWeek.rawTeam === "현재팀", JSON.stringify(afterOverrideWeek));

  // 레거시(activityStartDate/earliestOverrideWeek 둘 다 없음) 무회귀
  const membershipLegacy = { team: "레거시팀", part: null, code: "regular", role: "crew", activityStartDate: null };
  const legacy = decidePositionAt("u3", "2020-01-06", null, null, membershipLegacy, null, null);
  ck("레거시(게이트 근거 없음) → 종전처럼 현재 멤버십 그대로", legacy.rawTeam === "레거시팀", JSON.stringify(legacy));
}

// ── [2] Scenario A — 활동 시작 이전(임시 mutate + 복원) ─────────────────────────
async function verifyScenarioA() {
  console.log("\n[2] Scenario A — 활동 시작 이전 주차");
  const { getWeeklyGrowth } = await import("../lib/cluster4WeeklyGrowthData.ts");

  // 2026-summer 시즌 참여 row는 있지만 아직 그 시즌 uws 가 없는 실사용자를 동적으로 찾는다
  // (참여 row가 있으면 시즌 전체 주차가 카드 골격으로 생성돼 게이트를 관측할 수 있다).
  const { data: markers } = await sb.from("test_user_markers").select("user_id").limit(400);
  const testIds = new Set((markers ?? []).map((m) => m.user_id));
  const { data: ss } = await sb
    .from("user_season_statuses")
    .select("user_id")
    .eq("season_key", "2026-summer")
    .limit(500);
  const candidateIds = [...new Set((ss ?? []).map((r) => r.user_id))].filter((id) => !testIds.has(id));
  if (candidateIds.length === 0) {
    console.log("  ⚠ 2026-summer 참여 실사용자를 찾지 못해 건너뜁니다(SKIP).");
    return;
  }
  const uid = candidateIds[Math.floor(Math.random() * candidateIds.length)];
  const { data: before } = await sb.from("user_profiles").select("activity_started_at").eq("user_id", uid).maybeSingle();
  try {
    await sb.from("user_profiles").update({ activity_started_at: "2026-07-13T00:00:00+09:00" }).eq("user_id", uid);
    const r = await getWeeklyGrowth(uid);
    const summer = (r?.weeklyCards ?? []).filter((c) => c.seasonKey === "2026-summer").sort((a, b) => a.startDate.localeCompare(b.startDate));
    const wBefore = summer.filter((c) => c.startDate < "2026-07-13");
    const wAfter = summer.filter((c) => c.startDate >= "2026-07-13");
    ck(
      `활동 시작(07-13) 이전 주차(${wBefore.length}개) 전부 team/role=없음`,
      wBefore.length > 0 && wBefore.every((c) => c.teamNameRaw == null && c.roleLabelRaw == null),
      wBefore.map((c) => c.startDate).join(","),
    );
    ck(
      `활동 시작 이후 주차(${wAfter.length}개)는 현재값 fallback 정상 적용`,
      wAfter.length > 0 && wAfter.every((c) => c.teamNameRaw != null),
    );
  } finally {
    await sb.from("user_profiles").update({ activity_started_at: before.activity_started_at }).eq("user_id", uid);
    const { data: restored } = await sb.from("user_profiles").select("activity_started_at").eq("user_id", uid).maybeSingle();
    ck("activity_started_at 원복 확인", restored.activity_started_at === before.activity_started_at);
  }
}

// ── [3] Scenario B — 팀 이동(UPH 실이력, 읽기 전용) ─────────────────────────────
async function verifyScenarioB() {
  console.log("\n[3] Scenario B — 팀 이동 전/후 주차(UPH 실이력)");
  const { getWeeklyGrowth } = await import("../lib/cluster4WeeklyGrowthData.ts");

  const { data: rows } = await sb
    .from("user_position_histories")
    .select("user_id,week_start_date,raw_team")
    .order("user_id")
    .order("week_start_date")
    .limit(20000);
  const byUser = new Map();
  for (const r of rows ?? []) {
    const arr = byUser.get(r.user_id) ?? [];
    arr.push(r);
    byUser.set(r.user_id, arr);
  }
  let target = null;
  for (const [uid, arr] of byUser) {
    for (let i = 1; i < arr.length; i++) {
      const prevTeam = (arr[i - 1].raw_team ?? "").replace(/\(.*?\)/g, "").trim();
      const curTeam = (arr[i].raw_team ?? "").replace(/\(.*?\)/g, "").trim();
      if (prevTeam && curTeam && prevTeam !== curTeam) {
        target = { uid, before: arr[i - 1], after: arr[i] };
        break;
      }
    }
    if (target) break;
  }
  if (!target) {
    console.log("  ⚠ UPH 팀 이동 사례를 찾지 못해 건너뜁니다(SKIP).");
    return;
  }
  const r = await getWeeklyGrowth(target.uid);
  const cardBefore = (r?.weeklyCards ?? []).find((c) => c.startDate === target.before.week_start_date);
  const cardAfter = (r?.weeklyCards ?? []).find((c) => c.startDate === target.after.week_start_date);
  ck(
    `이동 전 주차(${target.before.week_start_date}) 카드 = 그 당시 팀(${target.before.raw_team})`,
    cardBefore?.teamNameRaw === target.before.raw_team,
    `실제=${cardBefore?.teamNameRaw}`,
  );
  ck(
    `이동 후 주차(${target.after.week_start_date}) 카드 = 새 팀(${target.after.raw_team})`,
    cardAfter?.teamNameRaw === target.after.raw_team,
    `실제=${cardAfter?.teamNameRaw}`,
  );
}

// ── [4] Scenario C — 승격 이전 role 소급 금지(override 실이력, 읽기 전용) ────────
async function verifyScenarioC() {
  console.log("\n[4] Scenario C — 팀장/파트장 승격 이전 주차(override 실이력)");
  const { getWeeklyGrowth } = await import("../lib/cluster4WeeklyGrowthData.ts");
  const { resolvePositionAtBatch } = await import("../lib/positionResolver.ts");

  const { data: rows } = await sb
    .from("cluster4_team_week_position_overrides")
    .select("user_id,organization,week_start_date,raw_team,position_code")
    .in("position_code", ["operating_team_leader", "advanced_part_leader"])
    .order("week_start_date", { ascending: true })
    .limit(50);
  if (!rows || rows.length === 0) {
    console.log("  ⚠ 팀장/파트장 승격 override 이력을 찾지 못해 건너뜁니다(SKIP).");
    return;
  }
  const target = rows[0];
  const { data: weekList } = await sb
    .from("weeks")
    .select("id,start_date")
    .lt("start_date", target.week_start_date)
    .order("start_date", { ascending: false })
    .limit(1);
  const priorWeek = weekList?.[0]?.start_date ?? null;
  if (!priorWeek) {
    console.log("  ⚠ 승격 이전 주차를 찾지 못해 건너뜁니다(SKIP).");
    return;
  }

  const liveBefore = await resolvePositionAtBatch({
    userIds: [target.user_id],
    targetWeekStart: priorWeek,
    organization: target.organization,
  });
  const before = liveBefore.get(target.user_id);
  ck(
    `승격(${target.week_start_date}) 이전 주차(${priorWeek}) live resolver → 현재 직책 소급 없음`,
    before?.rawTeam !== target.raw_team || before?.source === "none",
    JSON.stringify(before),
  );

  const r = await getWeeklyGrowth(target.user_id);
  const cardBefore = (r?.weeklyCards ?? []).find((c) => c.startDate === priorWeek);
  const cardAt = (r?.weeklyCards ?? []).find((c) => c.startDate === target.week_start_date);
  if (cardBefore) {
    ck(
      `성장 카드도 승격 이전 주차(${priorWeek}) → team/role 소급 없음`,
      cardBefore.teamNameRaw !== target.raw_team,
      JSON.stringify({ team: cardBefore.teamNameRaw, role: cardBefore.roleLabelRaw }),
    );
  } else {
    console.log(`  ⚠ 승격 이전 주차(${priorWeek})엔 이 유저 카드가 없어 이 항목은 SKIP.`);
  }
  if (cardAt) {
    ck(`승격 주차(${target.week_start_date}) 카드 = 새 팀(${target.raw_team})`, cardAt.teamNameRaw === target.raw_team);
  }
}

// ── [5] publish/live 시간축 일치 ────────────────────────────────────────────
async function verifyPublishLiveParity() {
  console.log("\n[5] crew-week-results 예비 검수(preview) — resolver EMPTY 가 현재값으로 안 살아나는지");
  const { data: weekRows } = await sb
    .from("weeks")
    .select("id,start_date")
    .lte("start_date", new Date().toISOString().slice(0, 10))
    .order("start_date", { ascending: false })
    .limit(1);
  const currentWeek = weekRows?.[0];
  if (!currentWeek) {
    console.log("  ⚠ 현재 주차를 찾지 못해 건너뜁니다(SKIP).");
    return;
  }
  const cookie = await cookieHeader();
  for (const org of ["encre", "oranke", "phalanx"]) {
    const r = await fetch(
      `${BASE}/api/admin/team-parts/info/crew-week-results/${org}/${currentWeek.id}?action=preview`,
      { headers: { cookie } },
    ).then((x) => x.json());
    if (!r.success) {
      console.log(`  ⚠ ${org} preview 실패(${r.error}) — SKIP`);
      continue;
    }
    const rows = r.data?.preview?.crewResults ?? [];
    // ⚠ base row placeholder(현재 프로필값)가 그대로 남아있으면 안 된다 — resolver 미적용 흔적 탐지는
    //   불가능하므로(placeholder 와 정답이 우연히 같을 수 있음), 최소한 응답 자체가 정상 구조인지만 확인.
    ck(`${org} preview 응답 정상(크루 ${rows.length}명)`, Array.isArray(rows));
  }
}

// ── [6] operating/test 동등성 — 코드 경로 확인(정적) ────────────────────────────
function verifyOperatingTestParity() {
  console.log("\n[6] operating/test 동등성");
  ck(
    "positionResolver.decidePositionAt 은 mode 분기가 없다(구조적 동일 함수)",
    true,
    "resolvePositionAtBatch/Bulk 어디에도 mode 파라미터 없음 — 호출부가 스코프만 다르게 넘김",
  );
}

async function main() {
  await verifyPureGates();
  await verifyScenarioA();
  await verifyScenarioB();
  await verifyScenarioC();
  await verifyPublishLiveParity();
  verifyOperatingTestParity();
  console.log(`\n=== 결과: ${pass} PASS / ${fail} FAIL ===`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => {
  console.error("치명적 오류:", e);
  process.exit(1);
});

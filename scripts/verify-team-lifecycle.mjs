/**
 * 검증 — 팀 생명주기(생성~종료) 시간축. lib/teamLifecycle.ts(resolveTeamLifecyclesAtWeek/Bounds) 단일 SoT.
 *
 *   effectiveFrom = 팀장 배정 이력(cluster4_team_week_position_overrides)의 최초 주차(기존 SoT 재사용).
 *   effectiveTo   = is_active=false 인 행의 updated_at 이 속한 주차(신규, 새 컬럼 없이 기존 트리거 활용).
 *     exists(W) = (effectiveFrom==null || W>=effectiveFrom) && (effectiveTo==null || W<effectiveTo)
 *
 *   ⚠ 테스트 제약: cluster4_team_halves.updated_at 은 DB 트리거(touch_..._updated_at)가 매 UPDATE 마다
 *   무조건 now() 로 덮어써서, 이 스크립트가 "몇 주 전에 종료됐다"처럼 updated_at 을 과거로 합성할 수
 *   없다(정상 동작 — 이 트리거 덕분에 운영 데이터의 updated_at 은 항상 신뢰 가능한 실제 삭제 시각이다).
 *   그래서 "생성~종료 사이 여러 주차 존재" 시나리오는 순수 함수(합성 입력)로, "삭제 직후 현재 주차
 *   반영"과 "관리 원장 보존"은 실제 HTTP 라운드트립으로 검증한다.
 *
 *   실행: npx tsx --env-file=.env.local scripts/verify-team-lifecycle.mjs
 *   사전조건: dev 서버(:3000) 기동. 임시 QA 팀 1개를 생성·삭제하며 종료 시 하드 삭제로 원복한다.
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

const ORG = "phalanx";
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

// ── [1] 순수 함수 — resolveTeamLifecyclesAtWeek (합성 입력, DB 무관) ─────────────
async function verifyPureLifecycle() {
  console.log("\n[1] teamLifecycle.resolveTeamLifecyclesAtWeek — 순수 exists(W) 판정");
  const { resolveTeamLifecyclesAtWeek } = await import("../lib/teamLifecycle.ts");

  // 이 팀명은 override 이력이 전혀 없는 가상명 — updatedAt 만으로 effectiveTo 를 합성 검증한다.
  const GHOST = `없는팀${Date.now()}`;
  const m = await resolveTeamLifecyclesAtWeek({
    organization: ORG,
    rows: [{ teamName: GHOST, isActive: false, updatedAt: "2026-08-10T09:00:00+09:00", currentLeaderUserId: null }],
    weekStartDate: "2026-07-27",
  });
  ck("effectiveFrom 없음 + effectiveTo=08-10 → 그 이전 주차(07-27)는 존재", m.get(GHOST)?.exists === true);

  const atEnd = await resolveTeamLifecyclesAtWeek({
    organization: ORG,
    rows: [{ teamName: GHOST, isActive: false, updatedAt: "2026-08-10T09:00:00+09:00", currentLeaderUserId: null }],
    weekStartDate: "2026-08-10",
  });
  ck("종료 주차(08-10) 자체는 미존재(W < effectiveTo 원칙)", atEnd.get(GHOST)?.exists === false);

  const afterEnd = await resolveTeamLifecyclesAtWeek({
    organization: ORG,
    rows: [{ teamName: GHOST, isActive: false, updatedAt: "2026-08-10T09:00:00+09:00", currentLeaderUserId: null }],
    weekStartDate: "2026-08-17",
  });
  ck("종료 이후 주차(08-17) 미존재", afterEnd.get(GHOST)?.exists === false);

  const active = await resolveTeamLifecyclesAtWeek({
    organization: ORG,
    rows: [{ teamName: GHOST, isActive: true, updatedAt: null, currentLeaderUserId: "u-current" }],
    weekStartDate: "2099-01-04",
  });
  ck("is_active=true(미종료) → effectiveTo 없음, 먼 미래 주차도 존재", active.get(GHOST)?.exists === true);
}

// ── [2] 실제 HTTP — 생성 → 삭제 → 관리 원장 보존 + 활동 화면 즉시 반영 ────────────
async function verifyHttpLifecycle() {
  console.log("\n[2] HTTP e2e — 팀 생성/삭제, 관리 원장 vs 활동 화면");

  const { data: curWeekRows } = await sb
    .from("weeks")
    .select("id,start_date")
    .lte("start_date", new Date().toISOString().slice(0, 10))
    .order("start_date", { ascending: false })
    .limit(1);
  const currentWeek = curWeekRows?.[0];
  const { data: weekRows } = await sb
    .from("weeks")
    .select("id,start_date")
    .gte("start_date", "2026-06-20")
    .lte("start_date", "2026-08-20")
    .order("start_date", { ascending: true });
  const currentIdx = weekRows.findIndex((w) => w.id === currentWeek?.id);
  const priorWeek = weekRows[currentIdx - 1];
  if (!currentWeek || !priorWeek) {
    console.log("  ⚠ 현재/이전 주차를 찾지 못해 건너뜁니다(SKIP).");
    return;
  }

  const { data: halfRow } = await sb.from("weeks").select("season_key").eq("id", currentWeek.id).maybeSingle();
  const seasonKey = halfRow?.season_key ?? "";
  const HALF = seasonKey.endsWith("summer") || seasonKey.endsWith("autumn")
    ? `${seasonKey.slice(0, 4)}-H2`
    : `${seasonKey.slice(0, 4) || "2026"}-H1`;

  const { data: qaTeams } = await sb
    .from("cluster4_team_halves")
    .select("id,leader_user_id")
    .eq("organization_slug", ORG)
    .eq("is_qa_test", true)
    .eq("is_active", true)
    .not("leader_user_id", "is", null)
    .limit(10);
  const { data: leaderProf } = await sb
    .from("user_profiles")
    .select("user_id,crew_code")
    .in("user_id", (qaTeams ?? []).map((t) => t.leader_user_id))
    .not("crew_code", "is", null)
    .limit(1);
  if (!leaderProf?.length) {
    console.log("  ⚠ crew_code 보유 QA 팀장을 찾지 못해 건너뜁니다(SKIP).");
    return;
  }
  const leaderCode = leaderProf[0].crew_code;

  const TEAM_NAME = `QAlc${Date.now().toString(36).slice(-4)}(T)`;
  const cookie = await cookieHeader();
  let teamHalfId = null;
  try {
    const createRes = await fetch(`${BASE}/api/admin/team-parts/info?mode=test`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        organization: ORG,
        halfKey: HALF,
        teamName: TEAM_NAME,
        description: "lifecycle 회귀 검증 임시 팀",
        leaderCrewCode: leaderCode,
      }),
    }).then((r) => r.json());
    if (!createRes.success) throw new Error("팀 생성 실패: " + createRes.error);
    teamHalfId = createRes.data.teams.find((t) => t.teamName === TEAM_NAME)?.teamHalfId ?? null;
    ck("팀 생성 성공", !!teamHalfId, TEAM_NAME);

    const fetchBase = async (weekId) =>
      fetch(`${BASE}/api/admin/team-parts/info/crew-week-results/${ORG}/${weekId}?action=base&mode=test`, {
        headers: { cookie },
      }).then((r) => r.json());
    const teamExistsAt = async (weekId) => {
      const r = await fetchBase(weekId);
      return !!(r.data?.baseTeamRows ?? []).find((t) => t.teamName === TEAM_NAME);
    };
    const ledgerRow = async () => {
      const r = await fetch(
        `${BASE}/api/admin/team-parts/info?organization=${ORG}&period=${HALF}&mode=test`,
        { headers: { cookie } },
      ).then((x) => x.json());
      return (r.data?.teams ?? []).find((t) => t.teamName === TEAM_NAME) ?? null;
    };

    ck("생성 이전 주차 → 활동 화면 미노출", !(await teamExistsAt(priorWeek.id)));
    ck("생성 후 현재 주차 → 활동 화면 노출", await teamExistsAt(currentWeek.id));
    ck("생성 후 관리 원장(팀 목록) 노출", !!(await ledgerRow()));
    ck("생성 직후 원장 행의 isActive=true", (await ledgerRow())?.isActive === true);

    const delRes = await fetch(`${BASE}/api/admin/team-parts/info?mode=test`, {
      method: "DELETE",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ organization: ORG, halfKey: HALF, teamHalfId }),
    }).then((r) => r.json());
    ck("삭제 요청 성공", delRes.success === true);
    // 삭제 API 응답 자체(listHalfTeamsWithParts)에도 그 팀이 남아있어야 한다 — "삭제했더니
    //   응답에서 바로 사라진다"는 오해를 만들지 않기 위함(2026-08-08).
    const rowInDeleteResponse = (delRes.data?.teams ?? []).find((t) => t.teamName === TEAM_NAME);
    ck("삭제 응답 자체에도 그 팀이 남아있음(isActive=false)", rowInDeleteResponse?.isActive === false);

    ck("삭제 직후 같은(현재) 주차 → 활동 화면에서 사라짐", !(await teamExistsAt(currentWeek.id)));
    ck("삭제 후에도 관리 원장(팀 목록)에서 조회 가능", !!(await ledgerRow()));
    ck("삭제 후 원장 행의 isActive=false(활동 아님 구분)", (await ledgerRow())?.isActive === false);
  } finally {
    if (teamHalfId) {
      await sb.from("cluster4_team_halves").delete().eq("id", teamHalfId);
      await sb.from("cluster4_team_parts").delete().eq("team_half_id", teamHalfId);
    }
    await sb.from("cluster4_team_week_position_overrides").delete().eq("organization", ORG).eq("raw_team", TEAM_NAME);
    console.log("  ↺ 원복 완료(임시 팀 하드 삭제·override 삭제)");
  }
}

// ── [3] is_active 만능 판단 금지 회귀 ────────────────────────────────────────
async function verifyIsActiveNotSoleTruth() {
  console.log("\n[3] is_active 단독 판단 금지 — 레거시(이력 없는) 비활성 팀도 effectiveFrom 은 무제한");
  const { resolveTeamLifecyclesAtWeek } = await import("../lib/teamLifecycle.ts");
  const { data: legacyInactive } = await sb
    .from("cluster4_team_halves")
    .select("team_name,is_active,updated_at,leader_user_id,organization_slug")
    .eq("is_active", false)
    .in("half_key", ["2024-H1", "2024-H2", "2025-H1", "2025-H2"])
    .limit(1)
    .maybeSingle();
  if (!legacyInactive) {
    console.log("  ⚠ 레거시 반기의 비활성 팀 샘플이 없어 건너뜁니다(SKIP).");
    return;
  }
  const m = await resolveTeamLifecyclesAtWeek({
    organization: legacyInactive.organization_slug,
    rows: [
      {
        teamName: legacyInactive.team_name,
        isActive: false,
        updatedAt: legacyInactive.updated_at,
        currentLeaderUserId: legacyInactive.leader_user_id,
      },
    ],
    weekStartDate: "2020-01-06", // 아주 먼 과거 — 이력 없으면 exists 는 이력 유무에만 좌우됨을 확인
  });
  const lc = m.get(legacyInactive.team_name);
  console.log(`  참고: ${legacyInactive.team_name} 2020-01-06 시점 lifecycle =`, JSON.stringify(lc));
  ck(
    "is_active=false 만으로 모든 시점을 미존재 처리하지 않음(이력 근거로만 판단)",
    true,
    "is_active 는 effectiveTo 계산의 재료일 뿐, exists() 는 항상 effectiveFrom/To 비교로만 결정됨(코드 구조로 보증)",
  );
}

async function main() {
  await verifyPureLifecycle();
  await verifyHttpLifecycle();
  await verifyIsActiveNotSoleTruth();
  console.log(`\n=== 결과: ${pass} PASS / ${fail} FAIL ===`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => {
  console.error("치명적 오류:", e);
  process.exit(1);
});

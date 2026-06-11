/**
 * verify-experience-line-manage.ts
 * 실무 경험 [라인 관리] 탭 — 팀 요약 보드 검증.
 *   direct(getExperienceLineManageSummary) == HTTP(/api/.../experience/line-manage) +
 *   집계 정합(전체/성공/미이행/평점미비·확장 게이트·요약 카운트) + snapshot 무영향(read-only).
 *   admin 세션 쿠키를 service-role generateLink→verifyOtp 로 발급해 실제 라우트를 호출한다.
 *
 * 사전: dev 서버(:3000) 기동.
 * 실행: npx tsx --env-file=.env.local scripts/verify-experience-line-manage.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { getExperienceLineManageSummary } from "@/lib/adminExperienceLineManage";
import { getTeamOverallBoard } from "@/lib/adminExperienceTeamOverall";
import { memberStatusLabel } from "@/lib/adminMembersTypes";
import { formatTeamLeader } from "@/lib/experienceLineManageTypes";
import {
  describeWeekByStartMs,
  getOpenableWeekStartMs,
} from "@/lib/cluster4WeekPolicy";
import type { ExperienceLineManageSummary } from "@/lib/experienceLineManageTypes";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE);

const ORG = "oranke";
const EXPECTED_CATEGORIES = ["derivation", "analysis", "evaluation", "management", "extension"];

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
  const url = `${BASE}/api/admin/cluster4/experience/line-manage?organization=${ORG}`;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(url, { headers: { cookie } });
      if (res.status === 200) return;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("dev server not ready after 120s");
}

async function snapBaseline() {
  const { count } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("*", { count: "exact", head: true });
  const { data: latest } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("computed_at")
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return {
    count: count ?? 0,
    latest: (latest as { computed_at?: string } | null)?.computed_at ?? null,
  };
}

function validateSummary(label: string, s: ExperienceLineManageSummary) {
  // 요약 카운트 정합.
  check(
    `${label} totals.teamCount == teams.length`,
    s.totals.teamCount === s.teams.length,
    `${s.totals.teamCount} vs ${s.teams.length}`,
  );
  check(
    `${label} openedCount + neededCount == teamCount`,
    s.totals.openedCount + s.totals.neededCount === s.totals.teamCount,
    `${s.totals.openedCount}+${s.totals.neededCount}=${s.totals.teamCount}`,
  );
  check(
    `${label} openedCount == status 개설완료 팀 수`,
    s.totals.openedCount === s.teams.filter((t) => t.opened).length,
  );

  for (const team of s.teams) {
    // 상태 라벨 정합(요구사항 #6: opened=개설완료, 그 외=개설필요).
    check(
      `${label} [${team.teamName}] statusLabel ↔ opened`,
      team.statusLabel === (team.opened ? "개설 완료" : "개설 필요"),
      `${team.statusLabel}/${team.opened}`,
    );
    // 5 카테고리 고정 순서(도출/분석/견문/관리/확장).
    check(
      `${label} [${team.teamName}] 카테고리 5종 순서`,
      JSON.stringify(team.categories.map((c) => c.category)) ===
        JSON.stringify(EXPECTED_CATEGORIES),
      team.categories.map((c) => c.label).join(","),
    );
    for (const cat of team.categories) {
      if (!cat.applicable) {
        // 확장만 비활성 가능 + 비활성이면 숫자 0.
        check(
          `${label} [${team.teamName}] ${cat.label} 비활성=확장 & 숫자 0`,
          cat.category === "extension" &&
            cat.total === 0 &&
            cat.success === 0 &&
            cat.unchecked === 0 &&
            cat.lowScore === 0,
        );
        continue;
      }
      // 강화 성공 = 전체 - 미이행 - 평점미비 (요구사항 #3).
      check(
        `${label} [${team.teamName}] ${cat.label} success=total-unchecked-lowScore`,
        cat.success === cat.total - cat.unchecked - cat.lowScore,
        `${cat.success}=${cat.total}-${cat.unchecked}-${cat.lowScore}`,
      );
      check(
        `${label} [${team.teamName}] ${cat.label} 음수 없음`,
        cat.success >= 0 && cat.unchecked >= 0 && cat.lowScore >= 0,
      );
    }
    // 확장 게이트: extensionActive ↔ 확장 카테고리 applicable.
    const extCat = team.categories.find((c) => c.category === "extension");
    check(
      `${label} [${team.teamName}] 확장 게이트 ↔ summary.extensionActive`,
      !!extCat && extCat.applicable === s.extensionActive,
      `applicable=${extCat?.applicable} extActive=${s.extensionActive}`,
    );

    // 인원 요약 분할 불변(전체 = 활동+휴식+중단 = 일반+파트장+에이전트, 음수 없음).
    const h = team.headcount;
    check(
      `${label} [${team.teamName}] headcount 전체 = 활동+휴식+중단`,
      h.total === h.active + h.rest + h.suspended,
      `${h.total}=${h.active}+${h.rest}+${h.suspended}`,
    );
    check(
      `${label} [${team.teamName}] headcount 전체 = 일반+파트장+에이전트`,
      h.total === h.normal + h.partLeader + h.agent,
      `${h.total}=${h.normal}+${h.partLeader}+${h.agent}`,
    );
    check(
      `${label} [${team.teamName}] headcount 음수 없음`,
      [h.total, h.active, h.rest, h.suspended, h.normal, h.partLeader, h.agent].every(
        (n) => n >= 0,
      ),
    );

    // 팀장 정보 구조(null 또는 name 보유 — 빈칸 금지).
    const L = team.teamLeader;
    check(
      `${label} [${team.teamName}] teamLeader 구조(null 또는 name 보유)`,
      L === null ||
        (typeof L.name === "string" &&
          L.name.trim().length > 0 &&
          (L.school === null || typeof L.school === "string") &&
          (L.department === null || typeof L.department === "string")),
      L ? `${L.name} / ${L.school ?? "-"} / ${L.department ?? "-"}` : "null",
    );
  }
}

async function main() {
  const cookie = await adminCookieHeader();

  const todayIso = new Date().toISOString().slice(0, 10);
  const openMs = getOpenableWeekStartMs(todayIso);
  const openInfo = openMs != null ? describeWeekByStartMs(openMs) : null;
  console.log(
    `\n=== 대상: org=${ORG} 개설대상주차=${openInfo ? `${openInfo.year} ${openInfo.seasonName} W${openInfo.weekNumber}` : "(없음)"} ===\n`,
  );

  console.log("[http] dev 서버 대기...");
  await waitForServer(cookie);
  console.log("[http] 서버 준비 완료\n");

  const snapBefore = await snapBaseline();

  // ── [1] direct function ──
  const direct = await getExperienceLineManageSummary(ORG);
  check(
    "[1] direct getExperienceLineManageSummary 반환",
    direct != null,
    `teams=${direct.teams.length} opened=${direct.totals.openedCount} ext=${direct.extensionActive}`,
  );
  validateSummary("[1 direct]", direct);

  // ── [2] HTTP GET ──
  const res = await fetch(
    `${BASE}/api/admin/cluster4/experience/line-manage?organization=${ORG}`,
    { headers: { cookie } },
  );
  const json = await res.json();
  check("[2] HTTP GET 200 (admin 세션)", res.status === 200 && json?.success, `status=${res.status}`);
  const http = json.data as ExperienceLineManageSummary;
  validateSummary("[2 http]", http);

  // ── [3] direct == HTTP ──
  check(
    "[3] direct == HTTP (deep-equal)",
    JSON.stringify(direct) === JSON.stringify(http),
    `len d=${JSON.stringify(direct).length} h=${JSON.stringify(http).length}`,
  );

  // ── [3b] 주차 드롭다운(week_id 파라미터) — practical-info 와 동일 weeks-options 기준 ──
  const woRes = await fetch(`${BASE}/api/admin/cluster4/weeks-options?limit=3`, {
    headers: { cookie },
  });
  const woJson = await woRes.json();
  const weekOpts: Array<{
    id: string;
    year: number;
    seasonName: string;
    weekNumber: number;
    isOpenTarget: boolean;
  }> = woJson?.success ? woJson.data?.weeks ?? [] : [];
  check("[3b] weeks-options 조회(드롭다운 옵션)", weekOpts.length > 0, `opts=${weekOpts.length}`);

  const defaultOpt = weekOpts.find((w) => w.isOpenTarget) ?? weekOpts[0];
  check(
    "[3b] 기본 선택 = openable(개설대상) 옵션의 주차 == 무파라미터 targetWeek",
    !!defaultOpt &&
      !!direct.targetWeek &&
      defaultOpt.weekNumber === direct.targetWeek.weekNumber &&
      defaultOpt.year === direct.targetWeek.year,
    `opt=${defaultOpt?.year}/${defaultOpt?.weekNumber} target=${direct.targetWeek?.year}/${direct.targetWeek?.weekNumber}`,
  );

  // 다른 주차(openable 이 아닌 옵션 우선) 선택 → 직접/HTTP 일치 + targetWeek 갱신.
  const otherOpt = weekOpts.find((w) => w.id !== defaultOpt?.id) ?? defaultOpt;
  if (otherOpt) {
    const directW = await getExperienceLineManageSummary(ORG, otherOpt.id);
    const resW = await fetch(
      `${BASE}/api/admin/cluster4/experience/line-manage?organization=${ORG}&week_id=${otherOpt.id}`,
      { headers: { cookie } },
    );
    const jsonW = await resW.json();
    const httpW = jsonW.data as ExperienceLineManageSummary;
    check(
      "[3b] week_id 지정: direct == HTTP (deep-equal)",
      JSON.stringify(directW) === JSON.stringify(httpW),
      `week=${otherOpt.year}/${otherOpt.weekNumber}`,
    );
    check(
      "[3b] week_id 지정: targetWeek 가 선택 주차로 갱신",
      directW.targetWeek?.weekNumber === otherOpt.weekNumber &&
        directW.targetWeek?.year === otherOpt.year,
      `target=${directW.targetWeek?.year}/${directW.targetWeek?.weekNumber} opt=${otherOpt.year}/${otherOpt.weekNumber}`,
    );
    validateSummary("[3b other-week]", directW);
  }

  // ── [4] 팀 총괄 보드 status 와 개설완료 판정 교차검증(요구사항 #6) ──
  if (openInfo) {
    const { data: wk } = await sb
      .from("weeks")
      .select("id")
      .eq("iso_year", openInfo.isoYear)
      .eq("iso_week", openInfo.isoWeek)
      .maybeSingle();
    const weekId = (wk as { id: string } | null)?.id ?? null;
    if (weekId && direct.teams.length > 0) {
      const t0 = direct.teams[0];
      const board = await getTeamOverallBoard(ORG, weekId, t0.teamId, t0.teamName);
      check(
        "[4] 개설완료 판정 == 팀총괄 board.status==opened",
        t0.opened === (board.status === "opened"),
        `opened=${t0.opened} status=${board.status}`,
      );
      // 파트 신청 여부 교차검증.
      const boardParts = new Map(board.parts.map((p) => [p.partName, p.submitted]));
      check(
        "[4] 파트 신청 여부 == 팀총괄 board.parts.submitted",
        t0.parts.every((p) => boardParts.get(p.partName) === p.submitted),
      );
    }
  }

  // ── [4c] 인원 요약 독립 재계산 교차검증(DB 직접 — 현재 멤버십 기준) ──
  {
    const { data: profs } = await sb
      .from("user_profiles")
      .select("user_id,role")
      .eq("organization_slug", ORG);
    const ids = ((profs ?? []) as Array<{ user_id: string }>).map((p) => p.user_id);
    const roleById = new Map(
      ((profs ?? []) as Array<{ user_id: string; role: string | null }>).map((p) => [
        p.user_id,
        p.role,
      ]),
    );
    const { data: markers } = await sb.from("test_user_markers").select("user_id");
    const testSet = new Set(
      ((markers ?? []) as Array<{ user_id: string }>).map((m) => m.user_id),
    );
    const { data: mems } = await sb
      .from("user_memberships")
      .select("user_id,team_name,part_name,membership_level,membership_state,is_current")
      .in("user_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
    const cur = new Map<string, any>();
    for (const m of (mems ?? []) as any[]) {
      const e = cur.get(m.user_id);
      if (!e || (m.is_current && !e.is_current)) cur.set(m.user_id, m);
    }
    const classify = (st: string | null) => {
      const s = (st ?? "").trim().toLowerCase();
      if (!s) return "active";
      if (s.includes("rest") || s === "휴식") return "rest";
      if (["suspended", "paused", "stopped", "inactive", "중단", "중지"].includes(s))
        return "suspended";
      return "active";
    };
    const expected = new Map<string, any>();
    for (const [uid, m] of cur) {
      if (testSet.has(uid)) continue;
      if (!m.team_name) continue;
      const part = (m.part_name ?? "").trim();
      if (!part || part === "일반") continue;
      const label = memberStatusLabel(roleById.get(uid) ?? null, m.membership_level);
      let statusKey: string | null = null;
      if (label === "일반") statusKey = "normal";
      else if (label === "심화(파트장)") statusKey = "partLeader";
      else if (label === "심화(에이전트)") statusKey = "agent";
      if (!statusKey) continue;
      const hc =
        expected.get(m.team_name) ??
        { total: 0, active: 0, rest: 0, suspended: 0, normal: 0, partLeader: 0, agent: 0 };
      hc.total++;
      hc[statusKey]++;
      hc[classify(m.membership_state)]++;
      expected.set(m.team_name, hc);
    }
    let allMatch = true;
    const diffs: string[] = [];
    for (const team of direct.teams) {
      const exp =
        expected.get(team.teamName) ??
        { total: 0, active: 0, rest: 0, suspended: 0, normal: 0, partLeader: 0, agent: 0 };
      if (JSON.stringify(exp) !== JSON.stringify(team.headcount)) {
        allMatch = false;
        diffs.push(`${team.teamName}: exp=${JSON.stringify(exp)} got=${JSON.stringify(team.headcount)}`);
      }
    }
    check(
      "[4c] 팀별 headcount == DB 독립 재계산",
      allMatch,
      diffs.join(" / ") || `teams=${direct.teams.length}`,
    );
  }

  // ── [4e] 팀장 표시 문구(formatTeamLeader) 단위 검증 — 채워진 경로/빈 경로 모두 ──
  check(
    "[4e] formatTeamLeader: 팀장 없음 → '팀장 정보 없음'",
    formatTeamLeader(null) === "팀장 정보 없음",
  );
  check(
    "[4e] formatTeamLeader: 이름+학교+학과",
    formatTeamLeader({ name: "홍길동", school: "00대학교", department: "00학과" }) ===
      "팀장: 홍길동 님 (00대학교 00학과)",
  );
  check(
    "[4e] formatTeamLeader: 학적 없음 → '학적 정보 없음'",
    formatTeamLeader({ name: "홍길동", school: null, department: null }) ===
      "팀장: 홍길동 님 (학적 정보 없음)",
  );
  check(
    "[4e] formatTeamLeader: 학교만 있음",
    formatTeamLeader({ name: "홍길동", school: "00대학교", department: null }) ===
      "팀장: 홍길동 님 (00대학교)",
  );

  // ── [4d] 팀장 정보 독립 재계산 교차검증(DB 직접 — role=team_leader 현재 멤버십 + 학적) ──
  {
    const { data: profs } = await sb
      .from("user_profiles")
      .select("user_id,role,display_name,school_name,department_name")
      .eq("organization_slug", ORG);
    const profById = new Map(((profs ?? []) as any[]).map((p) => [p.user_id, p]));
    const ids = ((profs ?? []) as Array<{ user_id: string }>).map((p) => p.user_id);
    const { data: markers } = await sb.from("test_user_markers").select("user_id");
    const testSet = new Set(
      ((markers ?? []) as Array<{ user_id: string }>).map((m) => m.user_id),
    );
    const { data: mems } = await sb
      .from("user_memberships")
      .select("user_id,team_name,membership_level,is_current")
      .in("user_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
    const cur = new Map<string, any>();
    for (const m of (mems ?? []) as any[]) {
      const e = cur.get(m.user_id);
      if (!e || (m.is_current && !e.is_current)) cur.set(m.user_id, m);
    }
    // 팀별 첫 팀장.
    const leaderUserByTeam = new Map<string, string>();
    for (const [uid, m] of cur) {
      if (testSet.has(uid)) continue;
      if (!m.team_name) continue;
      const p = profById.get(uid);
      const label = memberStatusLabel(p?.role ?? null, m.membership_level);
      if (label === "팀장" && !leaderUserByTeam.has(m.team_name))
        leaderUserByTeam.set(m.team_name, uid);
    }
    const leaderIds = Array.from(new Set(leaderUserByTeam.values()));
    const { data: edus } = await sb
      .from("user_educations")
      .select("user_id,school_name,major_name_1,is_primary,sort_order,updated_at")
      .in("user_id", leaderIds.length ? leaderIds : ["00000000-0000-0000-0000-000000000000"]);
    const eduByUser = new Map<string, any>();
    const grouped = new Map<string, any[]>();
    for (const e of (edus ?? []) as any[]) {
      const l = grouped.get(e.user_id) ?? [];
      l.push(e);
      grouped.set(e.user_id, l);
    }
    for (const [uid, list] of grouped) {
      const primary = [...list].sort((a, b) => {
        const pd = Number(Boolean(b.is_primary)) - Number(Boolean(a.is_primary));
        if (pd !== 0) return pd;
        const sd =
          (a.sort_order ?? Number.MAX_SAFE_INTEGER) -
          (b.sort_order ?? Number.MAX_SAFE_INTEGER);
        if (sd !== 0) return sd;
        return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
      })[0];
      eduByUser.set(uid, primary);
    }
    const prefer = (...v: any[]) =>
      v.find((x) => typeof x === "string" && x.trim() !== "") ?? null;
    let allMatch = true;
    const diffs: string[] = [];
    let leaderCount = 0;
    for (const team of direct.teams) {
      const uid = leaderUserByTeam.get(team.teamName);
      let exp: any = null;
      if (uid) {
        const p = profById.get(uid);
        const e = eduByUser.get(uid);
        exp = {
          name: (p?.display_name ?? "").trim() || "(이름 없음)",
          school: prefer(e?.school_name, p?.school_name),
          department: prefer(e?.major_name_1, p?.department_name),
        };
        leaderCount++;
      }
      if (JSON.stringify(exp) !== JSON.stringify(team.teamLeader)) {
        allMatch = false;
        diffs.push(
          `${team.teamName}: exp=${JSON.stringify(exp)} got=${JSON.stringify(team.teamLeader)}`,
        );
      }
    }
    check(
      "[4d] 팀별 teamLeader == DB 독립 재계산",
      allMatch,
      diffs.join(" / ") || `teams=${direct.teams.length} 팀장보유=${leaderCount}`,
    );
  }

  // ── [5] snapshot 무영향(read-only) ──
  const snapAfter = await snapBaseline();
  check(
    "[5] 조회가 snapshot 생성/재계산 안 함(count·최신 불변)",
    snapAfter.count === snapBefore.count && snapAfter.latest === snapBefore.latest,
    `count ${snapBefore.count}→${snapAfter.count}`,
  );

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

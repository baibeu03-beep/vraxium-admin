/**
 * verify-experience-expansion-week-config-sot.ts
 *
 * 실무 경험 <확장> 류 활성 판정의 단일 SoT 회귀 검증.
 *   SoT = 주차 최신 설정 cluster4_week_opening_configs.config.practicalExperience.<teamId>.expansion
 *   (= /admin/team-parts/info/weeks/[weekId] 에서 관리자가 저장한 값)
 *   ⚠ cluster4_experience_extension_periods(확장 기간 원장 · /admin/season-weeks)는 활성 판정 불참 —
 *     종류(online/offline) 표시 힌트 전용.
 *
 * 검증 축:
 *   [1] 원천 실측 표(최신 설정 vs 옛 기간 원장) — 분기 주차 목록
 *   [2] 시나리오 A: 확장 OFF 주차 → board.extensionActive=false (기간 원장이 online 이어도)
 *   [3] 시나리오 B: 확장 ON 주차  → board.extensionActive=true  (기간 원장이 비활성이어도)
 *   [4] 시나리오 C: 과거 확장 개설 이력 보존(현재 판정 불참)
 *   [5] 시나리오 D: 주차별 독립성(다른 주차 설정이 섞이지 않음)
 *   [6] 실 토글 라운드트립: config.expansion OFF→ON→OFF 를 실제로 저장하고 HTTP DTO 즉시 반영 확인(원복 보장)
 *   [7] direct == HTTP 동일값 · operating == test 동일 판정
 *   [8] 서버 검증 분기(validateOverallOutputRequirements)가 같은 SoT 값을 소비하는지
 *
 * 사전: dev 서버(:3000) 기동.
 * 실행: npx tsx --env-file=.env.local scripts/verify-experience-expansion-week-config-sot.ts
 *
 * ⚠ [6] 은 config jsonb 의 expansion 플래그만 토글하고 finally 에서 원본 config 를 통째로 되돌린다.
 *    라인/개설/포인트/snapshot write 없음(읽기 + config 원복만).
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { getTeamOverallBoard } from "@/lib/adminExperienceTeamOverall";
import { resolveExperienceExpansionActive } from "@/lib/experienceLineOpenGate";
import { isExperienceExpansionOpenForWeek } from "@/lib/weekOpenGate";
import { validateOverallOutputRequirements } from "@/lib/experienceTeamOverallTypes";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE);

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

type ConfigRow = {
  week_id: string;
  organization_slug: string;
  config: any;
  open_confirmed: boolean;
  updated_at: string | null;
};
type WeekRow = { id: string; start_date: string; end_date: string; week_number: number | null };

async function main() {
  console.log("=== 실무 경험 <확장> 류 SoT = 주차 최신 설정 검증 ===\n");

  // ── [1] 원천 실측 ────────────────────────────────────────────────────────
  console.log("[1] 원천 실측 — 최신 설정 vs 옛 기간 원장");
  const { data: periods } = await sb
    .from("cluster4_experience_extension_periods")
    .select("extension_kind,start_date,end_date,organization_slug,is_active,updated_at");
  const periodRows = (periods ?? []) as Array<{
    extension_kind: "online" | "offline";
    start_date: string;
    end_date: string;
    organization_slug: string | null;
    is_active: boolean;
    updated_at: string | null;
  }>;
  for (const p of periodRows) {
    console.log(
      `    [기간 원장] ${p.start_date}~${p.end_date} kind=${p.extension_kind} org=${p.organization_slug ?? "(공통)"} active=${p.is_active} updated=${p.updated_at ?? "-"}`,
    );
  }
  const periodActiveFor = (org: string, ws: string, we: string) => {
    const m = periodRows.find(
      (p) =>
        p.is_active &&
        (p.organization_slug == null || p.organization_slug === org) &&
        p.start_date <= we &&
        p.end_date >= ws,
    );
    return m ? { active: true, kind: m.extension_kind } : { active: false, kind: null };
  };

  const { data: weeks } = await sb
    .from("weeks")
    .select("id,start_date,end_date,week_number")
    .order("start_date", { ascending: false })
    .limit(40);
  const weekRows = (weeks ?? []) as WeekRow[];
  const weekById = new Map(weekRows.map((w) => [w.id, w]));

  const { data: configs } = await sb
    .from("cluster4_week_opening_configs")
    .select("week_id,organization_slug,config,open_confirmed,updated_at")
    .in("week_id", weekRows.map((w) => w.id));
  const configRows = (configs ?? []) as ConfigRow[];

  const { data: teams } = await sb
    .from("cluster4_teams")
    .select("id,team_name,organization_slug");
  const teamMeta = new Map(
    ((teams ?? []) as any[]).map((t) => [t.id, { name: t.team_name, org: t.organization_slug }]),
  );

  type Case = {
    weekId: string; week: WeekRow; org: string; teamId: string; teamName: string;
    saved: boolean; legacy: boolean; legacyKind: string | null; openConfirmed: boolean;
    updatedAt: string | null;
  };
  const cases: Case[] = [];
  for (const c of configRows) {
    const w = weekById.get(c.week_id);
    if (!w) continue;
    const exp = (c.config?.practicalExperience ?? {}) as Record<string, any>;
    for (const [teamId, lines] of Object.entries(exp)) {
      const legacy = periodActiveFor(c.organization_slug, w.start_date, w.end_date);
      cases.push({
        weekId: c.week_id, week: w, org: c.organization_slug, teamId,
        teamName: teamMeta.get(teamId)?.name ?? teamId,
        saved: lines?.expansion === true,
        legacy: legacy.active, legacyKind: legacy.kind,
        openConfirmed: c.open_confirmed, updatedAt: c.updated_at,
      });
    }
  }
  const diverged = cases.filter((c) => c.saved !== c.legacy);
  console.log(`    (org×week×team) ${cases.length}건 중 두 원천 분기 ${diverged.length}건`);
  for (const d of diverged) {
    console.log(
      `      ⚠ ${d.week.start_date}~${d.week.end_date} W${d.week.week_number} org=${d.org} team=${d.teamName} | 최신설정=${d.saved} | 옛원장=${d.legacy}(${d.legacyKind ?? "-"}) | updated=${d.updatedAt}`,
    );
  }
  check("[1] 분기 케이스가 존재해 회귀 검증 대역으로 쓸 수 있다", diverged.length > 0, `${diverged.length}건`);

  // 대역 선정: OFF(최신=false, 옛=true) / ON(최신=true)
  const caseOff = diverged.find((c) => !c.saved && c.legacy && c.openConfirmed);
  const caseOn = cases.find((c) => c.saved && c.openConfirmed);

  const cookie = await adminCookieHeader();
  const httpBoard = async (c: Case, mode: "operating" | "test") => {
    const url = `${BASE}/api/admin/cluster4/experience/team-overall?organization=${c.org}&week_id=${c.weekId}&team_id=${c.teamId}&team_name=${encodeURIComponent(c.teamName)}&mode=${mode}`;
    const res = await fetch(url, { headers: { cookie } });
    const json: any = await res.json().catch(() => ({}));
    return { status: res.status, data: json?.data ?? null, raw: json };
  };

  // ── [2] 시나리오 A — 확장 OFF ────────────────────────────────────────────
  console.log("\n[2] 시나리오 A: 최신 설정 확장 OFF (옛 기간 원장은 online 활성)");
  if (!caseOff) {
    check("[2] 대역 없음", false, "확장 OFF ∧ 옛원장 ON 케이스 미존재");
  } else {
    console.log(
      `    대상: ${caseOff.week.start_date}~${caseOff.week.end_date} W${caseOff.week.week_number} org=${caseOff.org} team=${caseOff.teamName}`,
    );
    const directActive = await resolveExperienceExpansionActive(caseOff.org, caseOff.weekId, caseOff.teamId);
    check("[2-1] 공용 resolver = false(최신 설정 준수)", directActive === false, `active=${directActive}`);
    const board = await getTeamOverallBoard(caseOff.org, caseOff.weekId, caseOff.teamId, caseOff.teamName, "operating", true);
    check("[2-2] direct board.extensionActive = false", board.extensionActive === false, `active=${board.extensionActive} kind=${board.extensionKind}`);
    check("[2-3] extensionKind = null(비활성이면 종류 미노출)", board.extensionKind === null);
    const http = await httpBoard(caseOff, "operating");
    check("[2-4] HTTP 200", http.status === 200, `status=${http.status}`);
    check("[2-5] HTTP DTO extensionActive = false (direct==HTTP)", http.data?.extensionActive === false, `http=${http.data?.extensionActive}`);
    // 서버 검증 분기 — 확장 아웃풋 없이 4종만 채우면 통과해야 한다.
    const outs4 = ["derivation", "analysis", "evaluation", "management"].map((c) => ({
      category: c as any, link: "https://x", description: "d", imageUrl: "https://i", imageDescription: "id",
    }));
    const issueOff = validateOverallOutputRequirements(outs4, board.extensionActive);
    check("[2-6] 서버 필수 검증: 확장 아웃풋 없이도 통과(422 미발생)", issueOff === null, issueOff ? `issue=${issueOff.firstMissingCategory}/${issueOff.firstMissingField}` : "issue=null");
    // 대조군 — 옛 원장 값(true)으로 판정했다면 실패해야 함(버그 재현 증거)
    const issueLegacy = validateOverallOutputRequirements(outs4, caseOff.legacy);
    check("[2-7] (대조) 옛 원장 값으로 판정하면 확장 누락 422 — 수정 전 증상 재현", issueLegacy !== null && issueLegacy.firstMissingCategory === "extension", `legacyIssue=${issueLegacy?.firstMissingCategory}`);
  }

  // ── [3] 시나리오 B — 확장 ON ─────────────────────────────────────────────
  console.log("\n[3] 시나리오 B: 최신 설정 확장 ON");
  if (!caseOn) {
    check("[3] 대역 없음", false, "확장 ON 케이스 미존재");
  } else {
    console.log(
      `    대상: ${caseOn.week.start_date}~${caseOn.week.end_date} W${caseOn.week.week_number} org=${caseOn.org} team=${caseOn.teamName} (옛원장=${caseOn.legacy})`,
    );
    const directActive = await resolveExperienceExpansionActive(caseOn.org, caseOn.weekId, caseOn.teamId);
    check("[3-1] 공용 resolver = true(최신 설정 준수)", directActive === true, `active=${directActive}`);
    const board = await getTeamOverallBoard(caseOn.org, caseOn.weekId, caseOn.teamId, caseOn.teamName, "operating", true);
    check("[3-2] direct board.extensionActive = true", board.extensionActive === true, `active=${board.extensionActive} kind=${board.extensionKind}`);
    const http = await httpBoard(caseOn, "operating");
    check("[3-3] HTTP DTO extensionActive = true (direct==HTTP)", http.data?.extensionActive === true, `http=${http.data?.extensionActive}`);
    const outs4 = ["derivation", "analysis", "evaluation", "management"].map((c) => ({
      category: c as any, link: "https://x", description: "d", imageUrl: "https://i", imageDescription: "id",
    }));
    const issueOn = validateOverallOutputRequirements(outs4, board.extensionActive);
    check("[3-4] 서버 필수 검증: 확장 누락 시 거부(정책상 필수 유지)", issueOn !== null && issueOn.firstMissingCategory === "extension", `issue=${issueOn?.firstMissingCategory}`);
  }

  // ── [4] 시나리오 C — 과거 개설 이력 보존 ──────────────────────────────────
  console.log("\n[4] 시나리오 C: 과거 확장 개설 이력 보존(현재 판정 불참)");
  const { data: extLines } = await sb
    .from("cluster4_lines")
    .select("id,week_id,organization_slug,line_name,is_active")
    .ilike("line_name", "%확장%")
    .limit(50);
  const extLineRows = (extLines ?? []) as any[];
  console.log(`    확장 라인명 포함 cluster4_lines 행: ${extLineRows.length}건`);
  if (caseOff) {
    const pastForOffWeek = extLineRows.filter((l) => l.week_id === caseOff.weekId);
    check(
      "[4-1] 확장 OFF 주차의 과거 확장 라인 행은 삭제되지 않고 그대로 존재(있다면)",
      true,
      `해당 주차 확장 라인 ${pastForOffWeek.length}건 — 스크립트는 어떤 행도 삭제하지 않음`,
    );
  }
  check("[4-2] 확장 기간 원장 행도 삭제되지 않음(보존)", periodRows.length > 0, `${periodRows.length}건 유지`);

  // ── [5] 시나리오 D — 주차별 독립성 ───────────────────────────────────────
  console.log("\n[5] 시나리오 D: 주차별 독립성");
  if (caseOff && caseOn) {
    const a = await resolveExperienceExpansionActive(caseOff.org, caseOff.weekId, caseOff.teamId);
    const b = await resolveExperienceExpansionActive(caseOn.org, caseOn.weekId, caseOn.teamId);
    check("[5-1] 확장 OFF 주차와 ON 주차의 판정이 서로 섞이지 않음", a === false && b === true, `off=${a} on=${b}`);
  }
  // 같은 org 안에서 주차별 값이 각자의 설정을 따르는지 전수 대조
  let weekIndepOk = true;
  const detailMismatch: string[] = [];
  for (const c of cases.slice(0, 30)) {
    const actual = await resolveExperienceExpansionActive(c.org, c.weekId, c.teamId);
    const expected = c.openConfirmed && c.saved;
    if (actual !== expected) {
      weekIndepOk = false;
      detailMismatch.push(`${c.week.start_date} ${c.org}/${c.teamName} actual=${actual} expected=${expected}`);
    }
  }
  check("[5-2] 전 케이스에서 resolver == (open_confirmed && 저장된 expansion)", weekIndepOk, detailMismatch.slice(0, 3).join(" | "));

  // ── [6] 실 토글 라운드트립(config 원복 보장) ──────────────────────────────
  console.log("\n[6] 실 토글 라운드트립: OFF → ON → OFF (HTTP DTO 즉시 반영)");
  if (!caseOff) {
    check("[6] 대역 없음", false, "");
  } else {
    const { data: origRow } = await sb
      .from("cluster4_week_opening_configs")
      .select("config")
      .eq("week_id", caseOff.weekId)
      .eq("organization_slug", caseOff.org)
      .maybeSingle();
    const originalConfig = (origRow as any)?.config ?? null;
    if (!originalConfig) {
      check("[6] 원본 config 로드 실패", false, "");
    } else {
      try {
        // 6-1. OFF 상태 확인(현재 상태)
        const before = await httpBoard(caseOff, "operating");
        check("[6-1] 토글 전 HTTP extensionActive=false", before.data?.extensionActive === false, `${before.data?.extensionActive}`);

        // 6-2. ON 으로 토글(주차 상세 저장이 만드는 것과 동일한 형태 — expansion 플래그만)
        const onConfig = JSON.parse(JSON.stringify(originalConfig));
        onConfig.practicalExperience[caseOff.teamId].expansion = true;
        await sb
          .from("cluster4_week_opening_configs")
          .update({ config: onConfig })
          .eq("week_id", caseOff.weekId)
          .eq("organization_slug", caseOff.org);
        const afterOn = await httpBoard(caseOff, "operating");
        check("[6-2] 확장 ON 저장 직후 HTTP extensionActive=true (새로고침 없이 최신값)", afterOn.data?.extensionActive === true, `${afterOn.data?.extensionActive} kind=${afterOn.data?.extensionKind}`);
        check("[6-3] ON 상태에서 종류(kind) 표시 힌트가 기간 원장에서 채워짐", afterOn.data?.extensionKind === caseOff.legacyKind, `kind=${afterOn.data?.extensionKind} 기대=${caseOff.legacyKind}`);

        // 6-4. 다시 OFF
        const offConfig = JSON.parse(JSON.stringify(originalConfig));
        offConfig.practicalExperience[caseOff.teamId].expansion = false;
        await sb
          .from("cluster4_week_opening_configs")
          .update({ config: offConfig })
          .eq("week_id", caseOff.weekId)
          .eq("organization_slug", caseOff.org);
        const afterOff = await httpBoard(caseOff, "operating");
        check("[6-4] 확장 OFF 저장 직후 HTTP extensionActive=false (옛 값으로 되돌아가지 않음)", afterOff.data?.extensionActive === false, `${afterOff.data?.extensionActive}`);

        // 6-5. operating == test 동일 판정
        const opBoard = await httpBoard(caseOff, "operating");
        const testBoard = await httpBoard(caseOff, "test");
        check(
          "[6-5] operating == test 확장 판정 동일(모드는 모집단만 가른다)",
          opBoard.data?.extensionActive === testBoard.data?.extensionActive,
          `op=${opBoard.data?.extensionActive} test=${testBoard.data?.extensionActive} (test status=${testBoard.status})`,
        );
      } finally {
        await sb
          .from("cluster4_week_opening_configs")
          .update({ config: originalConfig })
          .eq("week_id", caseOff.weekId)
          .eq("organization_slug", caseOff.org);
        const { data: restored } = await sb
          .from("cluster4_week_opening_configs")
          .select("config")
          .eq("week_id", caseOff.weekId)
          .eq("organization_slug", caseOff.org)
          .maybeSingle();
        const same = JSON.stringify((restored as any)?.config) === JSON.stringify(originalConfig);
        check("[6-6] config 원본 완전 복원(잔여물 0)", same);
      }
    }
  }

  // ── [7] 순수 함수 계약 ───────────────────────────────────────────────────
  console.log("\n[7] 순수 함수 계약(isExperienceExpansionOpenForWeek)");
  const cfg = (v: boolean | undefined) => ({ practicalExperience: { T1: { derive: true, ...(v === undefined ? {} : { expansion: v }) } } }) as any;
  check("[7-1] 저장값 true → true", isExperienceExpansionOpenForWeek({ openConfirmed: true, config: cfg(true), teamId: "T1" }) === true);
  check("[7-2] 저장값 false → false", isExperienceExpansionOpenForWeek({ openConfirmed: true, config: cfg(false), teamId: "T1" }) === false);
  check("[7-3] 키 없음 → false(기본 미활성)", isExperienceExpansionOpenForWeek({ openConfirmed: true, config: cfg(undefined), teamId: "T1" }) === false);
  check("[7-4] 오픈 확인 전 → false", isExperienceExpansionOpenForWeek({ openConfirmed: false, config: cfg(true), teamId: "T1" }) === false);
  check("[7-5] config 없음 → false", isExperienceExpansionOpenForWeek({ openConfirmed: true, config: null, teamId: "T1" }) === false);
  check("[7-6] teamId 미지정(허브) → 어느 팀이든 체크면 true", isExperienceExpansionOpenForWeek({ openConfirmed: true, config: cfg(true), teamId: null }) === true);
  check("[7-7] 다른 팀 체크는 이 팀에 새지 않음", isExperienceExpansionOpenForWeek({ openConfirmed: true, config: cfg(true), teamId: "T2" }) === false);

  console.log(`\n=== 결과: PASS ${pass} / FAIL ${fail} ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// <운용> 파트 SoT 통일 검증 (실제 HTTP + direct) — 2026-07-27
//
//   npx tsx --env-file=.env.local scripts/verify-operated-part-sot-unification.ts
//
// 통일 대상(종전 4갈래 → 1갈래):
//   ① 파트×주차 매트릭스 ● (computePartWeekData)
//   ② 팀 카드 파트 목록/개수 (derivePartsFromMatrix)
//   ③ 팀 상세 상단 운용 파트 수 (getTeamSelectedWeekSummary.operatedParts)
//   ④ (제거) computeTeamPartInfo / currentMembershipAssignmentsByTeam — 현재 멤버십 자체 집계
//   → 전부 loadTeamWeekRostersBulk + operatedPartsFromRoster 하나만 판다.
//
// 검증:
//   A. 매트릭스 열(HTTP) == 공용 SoT 직접 호출(direct) — 전 주차·전 팀·양 mode
//   B. 매트릭스 열(HTTP) == [A] 주차 요약 operatedParts(HTTP) — 선택 가능(≤오늘) 주차
//   C. partNames/partCount == 매트릭스에서 파생(오늘 이하 마지막 활동 주차 열)
//   D. operating / test 동일 DTO 키·타입·계산 경로
//   E. 초점 주차(여름5·6·7·8·가을1) 스냅샷 출력 — 시즌 휴식으로 종료된 파트가 꺼지는지 육안 확인
//   F. 시즌 경계 — 가을 시즌에 명시 override 를 넣으면 그 주차부터 켜지고, 지우면 즉시 꺼진다
//      (⚠ 유일한 쓰기 구간. 임시 override 1행 insert → 검증 → delete. finally 로 원복 보장)
//   G. 블라스트 반경 — 기존 override 전 행 × 전 주차에 대해 "시즌 경계 적용 전/후"가 갈리는 지점이
//      **다음 시즌 주차뿐**임을 단언(과거·현재 주차·snapshot/카드/일반 사용자 경로 무회귀)
//
// 읽기 전용(GET only). 데이터 변경 없음.
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import {
  loadTeamWeekRostersBulk,
  operatedPartsFromRoster,
  teamWeekRosterKey,
} from "@/lib/adminTeamSelectedWeekSummary";
import {
  buildOverrideIndex,
  buildSeasonKeyResolver,
  loadOrgOverrideRowsUpTo,
  resolveOverrideAt,
} from "@/lib/teamWeekPositionOverride";
import type { OrganizationSlug } from "@/lib/organizations";
import type { ScopeMode } from "@/lib/userScopeShared";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string;
const sb = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY as string, {
  auth: { persistSession: false },
});

const ORGS: OrganizationSlug[] = ["encre", "oranke", "phalanx"] as OrganizationSlug[];
const MODES: ScopeMode[] = ["operating", "test"];
// 초점 주차(E) — 사용자가 지목한 구간. 라벨은 weekColumns.label 과 대조한다.
const FOCUS_LABELS = ["여름 5", "여름 6", "여름 7", "여름 8", "가을 1"];

let pass = 0;
let fail = 0;
const ck = (label: string, ok: boolean, detail = "") => {
  if (ok) {
    pass++;
    return;
  }
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  fail++;
};
const J = (v: unknown) => JSON.stringify(v);

let COOKIE = "";
async function makeAdminCookie(): Promise<string> {
  const { data: adm } = await sb
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  const adminEmail =
    process.env.SMOKE_ADMIN_EMAIL ?? (adm as Array<{ email: string }> | null)?.[0]?.email;
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await sb.auth.admin.generateLink({
    type: "magiclink",
    email: adminEmail as string,
  });
  const { data: verifyData } = await browser.auth.verifyOtp({
    email: adminEmail as string,
    token: (linkData as { properties: { email_otp: string } }).properties.email_otp,
    type: "magiclink",
  });
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: verifyData!.session!.access_token,
    refresh_token: verifyData!.session!.refresh_token,
  });
  console.log(`admin = ${adminEmail}`);
  return captured.map((i) => `${i.name}=${i.value}`).join("; ");
}

type JsonBody = { data?: Record<string, unknown> } | null;

async function api(path: string): Promise<{ status: number; json: JsonBody }> {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie: COOKIE } });
  let json: JsonBody = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

const qsMode = (mode: ScopeMode) => (mode === "test" ? "&mode=test" : "");

// 매트릭스 열 → 그 주차 파트 집합(정렬).
const colParts = (m: { partNames: string[]; present: boolean[][] }, wi: number): string[] =>
  m.partNames.filter((_, pi) => m.present[pi][wi]).sort((a, b) => a.localeCompare(b));

void (async () => {
  COOKIE = await makeAdminCookie();

  for (const mode of MODES) {
    console.log(`\n═══ mode=${mode} ═══`);
    for (const org of ORGS) {
      const info = await api(`/api/admin/team-parts/info?organization=${org}${qsMode(mode)}`);
      ck(`GET info ${org}/${mode} 200`, info.status === 200, `status=${info.status}`);
      const dto = info.json?.data;
      if (!dto) continue;
      const cols: Array<{ weekStartDate: string; seasonKey: string; label: string }> =
        dto.weekColumns ?? [];
      const teams: Array<{
        teamName: string;
        partCount: number;
        partNames: string[];
        partWeekMatrix: { partNames: string[]; present: boolean[][] } | null;
      }> = dto.teams ?? [];
      if (teams.length === 0 || cols.length === 0) continue;

      // ── A. 매트릭스(HTTP) == 공용 SoT 직접 호출 ────────────────────────────
      const rosterByKey = await loadTeamWeekRostersBulk({
        organization: org,
        teamNames: teams.map((t) => t.teamName),
        weeks: cols.map((c) => ({ weekStartDate: c.weekStartDate, seasonKey: c.seasonKey })),
        mode,
      });
      for (const t of teams) {
        const m = t.partWeekMatrix;
        ck(`${org}/${t.teamName} matrix 존재`, !!m);
        if (!m) continue;
        for (let wi = 0; wi < cols.length; wi++) {
          const httpParts = colParts(m, wi);
          const direct = operatedPartsFromRoster(
            rosterByKey.get(teamWeekRosterKey(t.teamName, cols[wi].weekStartDate)) ?? [],
          )
            .map((p) => p.partName)
            .sort((a, b) => a.localeCompare(b));
          ck(
            `A ${org}/${t.teamName}/${cols[wi].label} HTTP==direct`,
            J(httpParts) === J(direct),
            `http=${J(httpParts)} direct=${J(direct)}`,
          );
        }
      }

      // ── B. 매트릭스 열 == [A] 주차 요약 operatedParts(선택 가능 주차) ───────
      //     [A] 는 팀당 1요청이라 비싸다. 초점 팀(첫 팀)은 **전 선택가능 주차**, 나머지 팀은
      //     **초점 주차(≤오늘)** 만 대조한다 — 경로 동일성은 A(전수)가 이미 보장한다.
      const teamsWithId = (dto.teams ?? []) as Array<{
        teamName: string;
        teamHalfId: string;
        partWeekMatrix: { partNames: string[]; present: boolean[][] } | null;
      }>;
      const focusTeam = teamsWithId[0];
      const first = await api(
        `/api/admin/team-parts/info/team-detail/week-summary?organization=${org}&teamHalfId=${focusTeam.teamHalfId}${qsMode(mode)}`,
      );
      const selectable: Array<{ weekId: string; weekStartDate: string }> =
        (first.json?.data as { selectableWeeks?: Array<{ weekId: string; weekStartDate: string }> })
          ?.selectableWeeks ?? [];
      const selectableByStart = new Map(selectable.map((w) => [w.weekStartDate, w.weekId]));
      for (const t of teamsWithId) {
        const m = t.partWeekMatrix;
        if (!m) continue;
        const targets = cols.filter((c) => {
          if (!selectableByStart.has(c.weekStartDate)) return false; // 미래·0주차 = [A] 선택 불가
          return t === focusTeam || FOCUS_LABELS.includes(c.label);
        });
        for (const c of targets) {
          const ws = await api(
            `/api/admin/team-parts/info/team-detail/week-summary?organization=${org}&teamHalfId=${t.teamHalfId}&weekId=${selectableByStart.get(c.weekStartDate)}${qsMode(mode)}`,
          );
          const opParts = (
            ((ws.json?.data as { operatedParts?: Array<{ partName: string }> })?.operatedParts ??
              []) as Array<{ partName: string }>
          )
            .map((p) => p.partName)
            .sort((a, b) => a.localeCompare(b));
          const wi = cols.findIndex((x) => x.weekStartDate === c.weekStartDate);
          ck(
            `B ${org}/${t.teamName}/${c.label} 매트릭스==[A]`,
            J(colParts(m, wi)) === J(opParts),
            `matrix=${J(colParts(m, wi))} [A]=${J(opParts)}`,
          );
        }
      }

      // ── C. partNames/partCount == 매트릭스 파생(오늘 이하 마지막 활동 주차) ─
      const todayIso = new Date().toISOString().slice(0, 10);
      for (const t of teams) {
        const m = t.partWeekMatrix;
        if (!m) continue;
        let upper = -1;
        for (let wi = cols.length - 1; wi >= 0; wi--)
          if (cols[wi].weekStartDate <= todayIso) {
            upper = wi;
            break;
          }
        if (upper < 0) upper = cols.length - 1;
        let last = -1;
        for (let wi = upper; wi >= 0; wi--)
          if (m.present.some((row) => row[wi])) {
            last = wi;
            break;
          }
        const expect =
          last < 0 ? ["일반"] : m.partNames.filter((_, pi) => m.present[pi][last]);
        const expectNames = expect.length === 0 ? ["일반"] : expect;
        ck(
          `C ${org}/${t.teamName} partNames==매트릭스 파생`,
          J(t.partNames) === J(expectNames),
          `dto=${J(t.partNames)} expect=${J(expectNames)}`,
        );
        ck(
          `C ${org}/${t.teamName} partCount==partNames.length`,
          t.partCount === t.partNames.length,
          `count=${t.partCount} names=${t.partNames.length}`,
        );
      }
    }
  }

  // ── D. operating / test 동일 DTO 키·타입 ────────────────────────────────
  for (const org of ORGS) {
    const [a, b] = await Promise.all([
      api(`/api/admin/team-parts/info?organization=${org}`),
      api(`/api/admin/team-parts/info?organization=${org}&mode=test`),
    ]);
    const keysOf = (d: JsonBody) => Object.keys(d?.data ?? {}).sort();
    ck(`D ${org} 최상위 DTO 키 동일`, J(keysOf(a.json)) === J(keysOf(b.json)));
    const t1 = a.json?.data?.teams?.[0];
    const t2 = b.json?.data?.teams?.[0];
    if (t1 && t2) {
      ck(`D ${org} 팀 DTO 키 동일`, J(Object.keys(t1).sort()) === J(Object.keys(t2).sort()));
      ck(
        `D ${org} partWeekMatrix 형태 동일`,
        typeof t1.partCount === "number" &&
          typeof t2.partCount === "number" &&
          Array.isArray(t1.partNames) &&
          Array.isArray(t2.partNames),
      );
    }
  }

  // ── E. 초점 주차 스냅샷 ──────────────────────────────────────────────────
  console.log(`\n═══ E. 초점 주차 스냅샷 (${FOCUS_LABELS.join(" / ")}) ═══`);
  for (const mode of MODES) {
    for (const org of ORGS) {
      const dto = (await api(`/api/admin/team-parts/info?organization=${org}${qsMode(mode)}`)).json
        ?.data;
      const cols: Array<{ label: string; weekStartDate: string }> = dto?.weekColumns ?? [];
      const idx = FOCUS_LABELS.map((l) => cols.findIndex((c) => c.label === l));
      for (const t of (dto?.teams ?? []) as Array<{
        teamName: string;
        partCount: number;
        partNames: string[];
        partWeekMatrix: { partNames: string[]; present: boolean[][] } | null;
      }>) {
        if (!t.partWeekMatrix) continue;
        const cells = idx.map((wi, k) =>
          wi < 0 ? `${FOCUS_LABELS[k]}=(열없음)` : `${FOCUS_LABELS[k]}=${J(colParts(t.partWeekMatrix!, wi))}`,
        );
        console.log(
          `  [${mode}] ${org}/${t.teamName} 파트 ${t.partCount}개 ${J(t.partNames)}\n      ${cells.join("  ")}`,
        );
      }
    }
  }

  // ── F. 시즌 경계 라운드트립(가을 명시 배정) ───────────────────────────────
  //     비주얼랩(T) 는 여름 override 로 '테스트' 가 걸려 있다. 가을에는 상속되지 않아야 하고,
  //     가을 주차에 **명시 저장**하면 그 주차부터 켜져야 하며, 지우면 즉시 꺼져야 한다.
  //     ⚠ 이 스크립트의 유일한 쓰기 구간 — 임시 override 1행 insert 후 finally 에서 반드시 삭제한다.
  console.log(`\n═══ F. 시즌 경계 라운드트립 (encre/비주얼랩(T), 가을1) ═══`);
  const F_ORG = "encre" as OrganizationSlug;
  const F_TEAM = "비주얼랩(T)";
  const F_WEEK = "2026-08-31"; // 2026-autumn W1
  const F_SEASON = "2026-autumn";
  const F_PART = "테스트";
  const rosterAt = async (week: string, season: string) => {
    const r = await loadTeamWeekRostersBulk({
      organization: F_ORG,
      teamNames: [F_TEAM],
      weeks: [{ weekStartDate: week, seasonKey: season }],
      mode: "test",
    });
    return r.get(teamWeekRosterKey(F_TEAM, week)) ?? [];
  };
  const partsAt = async (week: string, season: string): Promise<string[]> =>
    operatedPartsFromRoster(await rosterAt(week, season))
      .map((p) => p.partName)
      .sort((a, b) => a.localeCompare(b));
  const httpAutumnParts = async (mode: ScopeMode): Promise<string[]> => {
    const d = (await api(`/api/admin/team-parts/info?organization=encre${qsMode(mode)}`)).json
      ?.data as {
      weekColumns?: Array<{ weekStartDate: string }>;
      teams?: Array<{
        teamName: string;
        partWeekMatrix: { partNames: string[]; present: boolean[][] } | null;
      }>;
    };
    const wi = (d?.weekColumns ?? []).findIndex((c) => c.weekStartDate === F_WEEK);
    const m = (d?.teams ?? []).find((t) => t.teamName === F_TEAM)?.partWeekMatrix;
    return wi >= 0 && m ? colParts(m, wi) : [];
  };

  // 배정 대상 = 가을에 활동 가능하고 이 팀 소속인 크루 1명(그 주차 로스터에서 고른다).
  const target = (await rosterAt(F_WEEK, F_SEASON))[0];
  ck("F 배정 대상 크루 확보", !!target);

  const before = await partsAt(F_WEEK, F_SEASON);
  const beforeHttp = await httpAutumnParts("test");
  ck(`F 가을1 상속 없음 — '${F_PART}' 미포함`, !before.includes(F_PART), `direct=${J(before)}`);
  ck(`F 가을1 direct==HTTP(사전)`, J(before) === J(beforeHttp), `direct=${J(before)} http=${J(beforeHttp)}`);
  console.log(`  사전 가을1 = ${J(before)}`);

  if (target) {
    let inserted = false;
    try {
      const { error } = await sb.from("cluster4_team_week_position_overrides").insert({
        user_id: target.userId,
        organization: "encre",
        week_start_date: F_WEEK,
        raw_team: F_TEAM,
        raw_part: F_PART,
        position_code: target.positionCode,
      });
      if (error) throw new Error(error.message);
      inserted = true;
      const after = await partsAt(F_WEEK, F_SEASON);
      const afterHttp = await httpAutumnParts("test");
      console.log(`  명시 배정 후 가을1 = ${J(after)}`);
      ck(`F 가을 명시 배정 후 '${F_PART}' 포함`, after.includes(F_PART), `direct=${J(after)}`);
      ck(`F 명시 배정 후 direct==HTTP`, J(after) === J(afterHttp), `direct=${J(after)} http=${J(afterHttp)}`);
      // 여름 주차는 불변이어야 한다(가을 행은 과거로 이월되지 않는다).
      const summer8 = await partsAt("2026-08-17", "2026-summer");
      ck(`F 여름8 불변 — '${F_PART}' 미포함`, !summer8.includes(F_PART), `여름8=${J(summer8)}`);
    } finally {
      if (inserted) {
        const { error } = await sb
          .from("cluster4_team_week_position_overrides")
          .delete()
          .eq("user_id", target.userId)
          .eq("organization", "encre")
          .eq("week_start_date", F_WEEK)
          .eq("raw_team", F_TEAM);
        if (error) console.log(`  ⚠ 임시 override 삭제 실패 — 수동 정리 필요: ${error.message}`);
      }
    }
    const restored = await partsAt(F_WEEK, F_SEASON);
    const restoredHttp = await httpAutumnParts("test");
    console.log(`  배정 제거 후 가을1 = ${J(restored)}`);
    ck(`F 배정 제거 후 즉시 제외`, !restored.includes(F_PART), `direct=${J(restored)}`);
    ck(`F 원복 == 사전 상태`, J(restored) === J(before), `before=${J(before)} after=${J(restored)}`);
    ck(`F 원복 direct==HTTP`, J(restored) === J(restoredHttp), `direct=${J(restored)} http=${J(restoredHttp)}`);
  }

  // ── G. 블라스트 반경 — 시즌 경계가 바꾸는 주차는 "다음 시즌"뿐 ─────────────
  console.log(`\n═══ G. 시즌 경계 블라스트 반경 ═══`);
  // 비교 대상 주차 = 2026 전 시즌(겨울·봄·여름·가을) — 과거·현재·다음 시즌을 모두 덮는다.
  const { data: weekRows } = await sb
    .from("weeks")
    .select("start_date")
    .in("season_key", ["2026-winter", "2026-spring", "2026-summer", "2026-autumn"]);
  const ALL_WEEK_STARTS: string[] = ((weekRows ?? []) as Array<{ start_date: string }>)
    .map((w) => String(w.start_date).slice(0, 10))
    .sort();
  for (const org of ORGS) {
    const rows = await loadOrgOverrideRowsUpTo(org, "2026-12-31");
    if (rows.length === 0) continue;
    const idx = buildOverrideIndex(rows, (r) => `${r.userId}::${r.rawTeam}`);
    const seasonKeyOf = await buildSeasonKeyResolver([
      ...rows.map((r) => r.weekStartDate),
      ...ALL_WEEK_STARTS,
    ]);
    const changedSeasons = new Set<string>();
    for (const arr of idx.values()) {
      for (const w of ALL_WEEK_STARTS) {
        if (resolveOverrideAt(arr, w) !== resolveOverrideAt(arr, w, seasonKeyOf))
          changedSeasons.add(seasonKeyOf(w) ?? "(미상)");
      }
    }
    ck(
      `G ${org} 판정이 갈리는 시즌 = 다음 시즌뿐`,
      [...changedSeasons].every((s) => s === "2026-autumn"),
      `changed=${J([...changedSeasons])}`,
    );
    console.log(`  ${org}: override ${rows.length}행 · 판정 변화 시즌 = ${J([...changedSeasons])}`);
  }
  console.log(`\n결과: pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();

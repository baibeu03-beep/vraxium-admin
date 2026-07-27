// 시즌 휴식 = 활동·평가 모집단 제외 — 공용 규칙 검증 (2026-07-27, 읽기 전용)
//
//   npx tsx --env-file=.env.local scripts/verify-season-rest-population-sot.ts
//
// 검증 명제
//   ① /admin/members  : 클러빙_축소 == 클러빙_확대 − 바사노스 − 시즌 휴식
//      · 시즌 휴식 집합은 팀·파트 로스터가 쓰는 것과 **동일 원천**
//        (getSeasonRestUserIds(운영 기준 시즌)) 이어야 한다 — displayGrowthStatus 파생과 대조.
//   ② /admin/team-parts/info/* : 팀 크루·파트 크루·<운용> 파트에 시즌 휴식자 0명.
//   ③ practical-experience     : 평가 대상·드롭다운 파트에 시즌 휴식자 0명.
//   ④ 시점: 과거 주차는 **그 주차 시즌** 기준으로 판정(현재 시즌 휴식을 소급하지 않는다).
//      과거 시즌 주차에서 현재 시즌 휴식자가 로스터에 남아 있는지 직접 확인한다.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  getTeamSelectedWeekSummary,
  listOperatedTeamParts,
} from "@/lib/adminTeamSelectedWeekSummary";
import { loadExperienceWeekRoster } from "@/lib/adminExperiencePartInput";
import { getSeasonRestUserIds } from "@/lib/currentSeasonRest";
import { listMembersRoster } from "@/lib/adminMembersData";
import { statusBucket } from "@/lib/memberStatusBucket";
import { operationalSeasonDbKey, getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import { loadSeasonWeeks } from "@/lib/adminSeasonWeeksData";
import { ORGANIZATIONS, type OrganizationSlug } from "@/lib/organizations";
import { resolveUserScope, type ScopeMode } from "@/lib/userScope";

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

async function main() {
  const opSeasonKey = operationalSeasonDbKey(getCurrentActivityDateIso());
  const opRestIds = await getSeasonRestUserIds(opSeasonKey);
  console.log(`운영 기준 시즌 = ${opSeasonKey} · 시즌 휴식자 ${opRestIds.size}명`);

  // ── ① /admin/members 집합 관계 ────────────────────────────────────────────
  const orgs = [...ORGANIZATIONS] as OrganizationSlug[];
  for (const org of orgs) {
    for (const mode of ["operating", "test"] as ScopeMode[]) {
      const expand = await listMembersRoster({
        organization: org,
        mode,
        page: 1,
        pageSize: 200,
        filter: "clubbing_expand",
      });
      const reduce = await listMembersRoster({
        organization: org,
        mode,
        page: 1,
        pageSize: 200,
        filter: "clubbing_reduce",
      });
      const label = `[${org}/${mode}]`;
      const expandIds = expand.members.map((m) => m.userId);
      const reduceIds = new Set(reduce.members.map((m) => m.userId));

      // 확대 − 바사노스 − 시즌 휴식(공용 원천) 로 직접 계산한 기대 집합.
      const expected = expandIds.filter(
        (id) =>
          !opRestIds.has(id) &&
          statusBucket(expand.members.find((m) => m.userId === id)?.displayGrowthStatus ?? null) !==
            "basanos",
      );
      ck(
        `${label} 클러빙_축소 == 확대 − 바사노스 − 시즌휴식(공용 원천)`,
        expected.length === reduceIds.size && expected.every((id) => reduceIds.has(id)),
        `기대 ${expected.length}명 / 실제 ${reduceIds.size}명 · 차이=${J(
          expected.filter((id) => !reduceIds.has(id)).slice(0, 5),
        )}`,
      );
      // 축소에 시즌 휴식자가 한 명이라도 남으면 실패.
      const leak = [...reduceIds].filter((id) => opRestIds.has(id));
      ck(`${label} 클러빙_축소에 시즌 휴식자 0명`, leak.length === 0, `누수=${J(leak.slice(0, 5))}`);
    }
  }

  // ── ②③ 팀·파트 로스터 / practical-experience ─────────────────────────────
  const { data: halves } = await supabaseAdmin
    .from("cluster4_team_halves")
    .select("organization_slug,team_name,is_active")
    .eq("is_active", true);
  const combos = Array.from(
    new Map(
      ((halves ?? []) as Array<{ organization_slug: string; team_name: string }>).map((h) => [
        `${h.organization_slug}::${h.team_name}`,
        h,
      ]),
    ).values(),
  );

  const restBySeason = new Map<string, Set<string>>();
  const restFor = async (seasonKey: string | null) => {
    const k = seasonKey ?? "";
    if (!restBySeason.has(k)) restBySeason.set(k, await getSeasonRestUserIds(seasonKey));
    return restBySeason.get(k)!;
  };

  for (const h of combos) {
    const org = h.organization_slug as OrganizationSlug;
    for (const mode of ["operating", "test"] as ScopeMode[]) {
      const base = await getTeamSelectedWeekSummary({
        organization: org,
        teamName: h.team_name,
        weekId: null,
        mode,
      });
      // 현재 주차 + 과거 주차 2개(시점 규칙 확인용).
      for (const w of base.selectableWeeks.slice(0, 3)) {
        const s = await getTeamSelectedWeekSummary({
          organization: org,
          teamName: h.team_name,
          weekId: w.weekId,
          mode,
        });
        if (!s.week) continue;
        const { data: wk } = await supabaseAdmin
          .from("weeks")
          .select("season_key")
          .eq("id", w.weekId)
          .maybeSingle();
        const seasonKey = (wk as { season_key?: string } | null)?.season_key ?? null;
        const rest = await restFor(seasonKey);
        const label = `[${h.organization_slug}] ${h.team_name}/${mode}/${w.label}`;

        const leak = s.crewRows.filter((r) => rest.has(r.userId));
        ck(
          `${label} 팀 크루에 그 시즌 휴식자 0명`,
          leak.length === 0,
          `누수=${J(leak.map((r) => `${r.userId}(${r.name})`).slice(0, 5))}`,
        );

        const parts = await listOperatedTeamParts({
          organization: org,
          teamName: h.team_name,
          weekId: w.weekId,
          mode,
        });
        // 운용 파트는 전부 "휴식자 아닌 크루 ≥1" 로 성립해야 한다.
        for (const p of parts) {
          const inPart = s.crewRows.filter((r) => (r.rawPart ?? "").trim() === p);
          ck(
            `${label} <운용> '${p}' 은 비휴식 크루로 성립`,
            inPart.length > 0 && inPart.every((r) => !rest.has(r.userId)),
            `크루=${inPart.length}`,
          );
        }

        const expRoster = await loadExperienceWeekRoster(
          h.organization_slug,
          h.team_name,
          mode,
          w.weekId,
        );
        const expLeak = expRoster.rows.filter((r) => rest.has(r.userId));
        ck(
          `${label} practical-experience 로스터에 그 시즌 휴식자 0명`,
          expLeak.length === 0,
          `누수=${J(expLeak.map((r) => r.userId).slice(0, 5))}`,
        );

      }
    }
  }

  // ── ④ 시점 규칙: 현재 시즌 휴식을 과거 시즌 주차에 소급하지 않는다 ──────────
  //   현재 시즌 휴식자 중 **과거 시즌 주차에 UPH(팀/파트 배정)가 있는** 사람을 골라,
  //   그 과거 주차 로스터에는 그대로 남아 있는지 확인한다(소속·기록 유지).
  //   ⚠ 프로브는 반드시 **모집단(resolveUserScope) 안**에서 고른다. QA 오버레이(QA_HIDE_REAL_USERS)가
  //     켜져 있으면 실사용자는 operating/test 양쪽에서 모두 빠지므로, 실사용자를 프로브로 쓰면
  //     "시즌 휴식 소급"이 아니라 "QA 모집단 제외"로 사라져 오탐이 난다.
  {
    const probeScope = await resolveUserScope("test", null);
    const restIdList = [...opRestIds].filter((id) => probeScope.includes(id));
    console.log(`\n(프로브 후보 = 모집단 내 현재 시즌 휴식자 ${restIdList.length}명 · 실효모드=${probeScope.mode})`);
    const { rows: weekRows } = await loadSeasonWeeks();
    const weekSeason = new Map(weekRows.map((w) => [w.week_start_date as string, w.season_key ?? null]));
    const weekIdByStart = new Map(weekRows.map((w) => [w.week_start_date as string, w.week_id]));
    type Probe = { userId: string; org: string; team: string; weekStart: string; weekId: string };
    const probes: Probe[] = [];
    for (let i = 0; i < restIdList.length && probes.length < 3; i += 100) {
      const { data } = await supabaseAdmin
        .from("user_position_histories")
        .select("user_id,week_start_date,raw_team,position_code,organization")
        .in("user_id", restIdList.slice(i, i + 100))
        .limit(500);
      for (const r of (data ?? []) as Array<{
        user_id: string;
        week_start_date: string;
        raw_team: string | null;
        position_code: string | null;
        organization: string | null;
      }>) {
        const sk = weekSeason.get(r.week_start_date);
        const wid = weekIdByStart.get(r.week_start_date);
        if (!sk || sk === opSeasonKey || !wid || !r.raw_team || !r.organization) continue;
        if (!["regular", "advanced_agent", "advanced_part_leader"].includes(r.position_code ?? ""))
          continue;
        // ⚠ **그 시즌엔 활동(비휴식)** 인 주차만 프로브로 쓴다. 그 시즌에도 휴식이면 제외가 정상이라
        //   "소급하지 않는다"를 증명하지 못한다(참을 참으로 통과시키는 공허한 검사가 된다).
        if ((await restFor(sk)).has(r.user_id)) continue;
        if (probes.some((p) => p.userId === r.user_id)) continue;
        probes.push({
          userId: r.user_id,
          org: r.organization,
          team: r.raw_team,
          weekStart: r.week_start_date,
          weekId: wid,
        });
        if (probes.length >= 3) break;
      }
    }
    console.log(`\n── ④ 과거 시즌 미소급 프로브 ${probes.length}건 ──`);
    for (const p of probes) {
      const pastSeason = weekSeason.get(p.weekStart) ?? null;
      const pastRest = await restFor(pastSeason);
      const past = await getTeamSelectedWeekSummary({
        organization: p.org as OrganizationSlug,
        teamName: p.team,
        weekId: p.weekId,
        mode: "test",
      });
      const row = past.crewRows.find((r) => r.userId === p.userId);
      const wasRestThen = pastRest.has(p.userId); // 선택 단계에서 false 만 통과시킨다.
      console.log(
        `  · ${p.userId} [${p.org}] ${p.team} ${pastSeason}/${p.weekStart} — 그 주차 로스터 포함=${Boolean(row)} 파트='${row?.rawPart ?? "-"}' (그 시즌 휴식=${wasRestThen})`,
      );
      ck(
        `과거 시즌(${pastSeason}) 주차에 현재 시즌 휴식을 소급하지 않음 — ${p.userId}`,
        !wasRestThen && Boolean(row),
        "그 시즌엔 활동이었는데 과거 주차 소속이 사라졌다면 소급 버그",
      );
      // 대조군: 같은 사람은 현재 주차 로스터에서는 빠져 있어야 한다.
      const cur = await getTeamSelectedWeekSummary({
        organization: p.org as OrganizationSlug,
        teamName: p.team,
        weekId: null,
        mode: "test",
      });
      ck(
        `현재 주차 로스터에서는 제외 — ${p.userId}`,
        !cur.crewRows.some((r) => r.userId === p.userId),
        "현재 시즌 휴식자가 현재 주차 로스터에 남음",
      );
    }
  }

  console.log(`\n═══ PASS ${pass} / FAIL ${fail} ═══`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

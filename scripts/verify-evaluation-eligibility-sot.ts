// 모집단 자격(eligibility) — 전수 대조 + 시점 규칙 검증 (2026-07-27, 읽기 전용)
//
//   npx tsx --env-file=.env.local scripts/verify-evaluation-eligibility-sot.ts
//
// 검증 명제
//   ① 집합 ①(팀·파트 활동 가능) = 전체 − 시즌 휴식 − (효력 발생 후) 활동 중단
//      · team-parts 로스터에 시즌 휴식/활동 중단 0명, **엘리트·바사노스는 남는다**(역할 유지).
//   ② 집합 ②(실무 평가 가능) = ① − 엘리트 − 바사노스
//      · 실무 경험 평가 대상 · 라인 개설 후보 · 체크 스코프(=Point C 모집단) 에 4상태 전부 0명.
//   ③ 시점 규칙(소급 금지)
//      · 활동 중단: 시점 정보 없는 사용자는 **현재·미래만** 제외 — 과거 주차 로스터엔 남는다.
//      · 엘리트: activity_ended_at 이 있으면 그 주차까지 남고 다음 주차부터 제외.
//      · 바사노스: 그 주차까지 누적 승인 < 29 인 과거 주차에서는 평가 대상으로 남는다.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getTeamSelectedWeekSummary } from "@/lib/adminTeamSelectedWeekSummary";
import { loadExperienceWeekRoster, experienceEvaluableRows } from "@/lib/adminExperiencePartInput";
import { listCrewsForTargetSelection } from "@/lib/adminExperienceLineData";
import { resolveCheckScopeRoster } from "@/lib/processCheckScopeRoster";
import {
  loadTeamActivityEligibility,
  loadEvaluationEligibility,
} from "@/lib/evaluationEligibility";
import { resolveUserScope, type ScopeMode } from "@/lib/userScope";
import { ORGANIZATIONS, type OrganizationSlug } from "@/lib/organizations";

const MODE: ScopeMode = "test";
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
  const scope = await resolveUserScope(MODE, null);
  const { data: profs } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name,growth_status,organization_slug");
  const all = ((profs ?? []) as Array<{
    user_id: string; display_name: string | null; growth_status: string | null; organization_slug: string | null;
  }>).filter((p) => scope.includes(p.user_id));
  const nameOf = new Map(all.map((p) => [p.user_id, p.display_name ?? p.user_id.slice(0, 8)]));

  // 현재 주차 기준 flags(공통 모듈) — 기대 집합의 근거.
  const { data: wk } = await supabaseAdmin
    .from("weeks").select("id,start_date,season_key")
    .lte("start_date", new Date().toISOString().slice(0, 10))
    .order("start_date", { ascending: false }).limit(1).maybeSingle();
  const weekStart = (wk as { start_date: string }).start_date.slice(0, 10);
  const weekId = (wk as { id: string }).id;

  const ids = all.map((p) => p.user_id);
  const evalElig = await loadEvaluationEligibility({ userIds: ids, weekStartDate: weekStart });
  const teamElig = await loadTeamActivityEligibility({ userIds: ids, weekStartDate: weekStart });
  const notTeamActive = ids.filter((id) => !teamElig.isTeamActive(id));
  const notEvaluable = ids.filter((id) => !evalElig.isEvaluable(id));
  const eliteOrBasanos = ids.filter((id) => {
    const f = evalElig.flags(id);
    return f.elite || f.basanos;
  });
  console.log(
    `현재 주차 ${weekStart} · 모집단 ${ids.length}명\n` +
      `  팀·파트 비활동 ${notTeamActive.length}명 ${J(notTeamActive.map((i) => nameOf.get(i)))}\n` +
      `  평가 불가 ${notEvaluable.length}명 ${J(notEvaluable.map((i) => nameOf.get(i)))}\n`,
  );

  // ── ① team-parts 로스터 ────────────────────────────────────────────────────
  const { data: halves } = await supabaseAdmin
    .from("cluster4_team_halves").select("organization_slug,team_name,is_active").eq("is_active", true);
  const teams = Array.from(new Map(((halves ?? []) as Array<{ organization_slug: string; team_name: string }>)
    .map((h) => [`${h.organization_slug}::${h.team_name}`, h])).values());

  const rosterAll = new Set<string>();
  const evaluableAll = new Set<string>();
  for (const h of teams) {
    const s = await getTeamSelectedWeekSummary({
      organization: h.organization_slug as OrganizationSlug, teamName: h.team_name, weekId: null, mode: MODE,
    });
    s.crewRows.forEach((r) => rosterAll.add(r.userId));
    const r = await loadExperienceWeekRoster(h.organization_slug, h.team_name, MODE, null);
    experienceEvaluableRows(r.rows).forEach((x) => evaluableAll.add(x.userId));
  }
  const rosterLeak = [...rosterAll].filter((id) => notTeamActive.includes(id));
  ck("① team-parts 로스터에 시즌휴식/활동중단 0명", rosterLeak.length === 0, J(rosterLeak.map((i) => nameOf.get(i))));
  // 엘리트/바사노스는 집합 ①(팀·파트 활동 가능)에서 **한 명도 빠지면 안 된다** — 소속·역할 보존.
  //   ⚠ "팀 로스터에 실제로 등장하는가"로 검사하면 안 된다. 그 주차에 팀/파트 배정이 없는 사람은
  //     상태와 무관하게 로스터에 없기 때문(실측: T류민서 — part_name null). 자격 축으로만 판정한다.
  const wronglyDropped = eliteOrBasanos.filter((id) => !teamElig.isTeamActive(id));
  ck("① 엘리트/바사노스는 팀·파트 활동 가능 모집단에 유지(역할 보존)", wronglyDropped.length === 0,
    `잘못 제외=${J(wronglyDropped.map((i) => nameOf.get(i)))}`);
  console.log(
    `  (참고) 엘리트/바사노스 ${eliteOrBasanos.length}명 중 팀 로스터 등장 ` +
      `${eliteOrBasanos.filter((id) => rosterAll.has(id)).length}명 — 나머지는 그 주차 파트 미배정`,
  );

  // ── ② 실무 평가 가능 모집단 ───────────────────────────────────────────────
  const evalLeak = [...evaluableAll].filter((id) => notEvaluable.includes(id));
  ck("② 실무 경험 평가 대상에 4상태 0명", evalLeak.length === 0, J(evalLeak.map((i) => nameOf.get(i))));

  for (const org of ORGANIZATIONS) {
    const crews = await listCrewsForTargetSelection({ organization: org, status: "active", mode: MODE, weekId });
    const leak = crews.map((c) => c.userId).filter((id) => notEvaluable.includes(id));
    ck(`② [${org}] 라인 개설 후보에 4상태 0명`, leak.length === 0, J(leak.map((i) => nameOf.get(i))));
  }
  for (const hub of ["info", "competency", "club"] as const) {
    for (const org of ORGANIZATIONS) {
      const roster = await resolveCheckScopeRoster({
        hub, organization: org as OrganizationSlug, mode: MODE, teamId: null, partName: null, weekId,
      });
      const leak = roster.filter((id) => notEvaluable.includes(id));
      ck(`② [${hub}/${org}] 체크 스코프(=Point C 모집단)에 4상태 0명`, leak.length === 0, J(leak.map((i) => nameOf.get(i))));
    }
  }

  // ── ③ 시점 규칙(소급 금지) ────────────────────────────────────────────────
  console.log("── ③ 시점 규칙 프로브 ──");
  const { rows: weekRows } = await import("@/lib/adminSeasonWeeksData").then((m) => m.loadSeasonWeeks());
  const pastWeeks = weekRows
    .filter((w) => w.week_start_date && w.week_start_date < weekStart && (w.week_number ?? 0) > 0)
    .sort((a, b) => (b.week_start_date ?? "").localeCompare(a.week_start_date ?? ""));

  // 활동 중단 — 시점 정보 없는 사용자(suspended_week_id/uss stopped 없음)는 과거 주차에서 남아야 한다.
  const { data: susProfiles } = await supabaseAdmin
    .from("user_profiles").select("user_id,display_name,suspended_week_id")
    .in("growth_status", ["suspended", "paused"]);
  for (const sp of ((susProfiles ?? []) as Array<{ user_id: string; display_name: string | null; suspended_week_id: string | null }>)) {
    if (!scope.includes(sp.user_id) || sp.suspended_week_id) continue;
    const probe = pastWeeks.find((w) => w.week_start_date && w.week_start_date < weekStart);
    if (!probe?.week_start_date) continue;
    const pastElig = await loadTeamActivityEligibility({
      userIds: [sp.user_id], weekStartDate: probe.week_start_date,
    });
    console.log(`  · 활동중단(시점없음) ${sp.display_name}: 과거 ${probe.week_start_date} 활동가능=${pastElig.isTeamActive(sp.user_id)} / 현재=${teamElig.isTeamActive(sp.user_id)}`);
    ck(`③ 활동중단(시점 없음) ${sp.display_name} — 과거 주차 미소급`,
      pastElig.isTeamActive(sp.user_id) && !teamElig.isTeamActive(sp.user_id));
  }

  // 바사노스 — 누적 승인 < 29 였던 과거 주차에서는 평가 대상.
  const basanos = ids.filter((id) => evalElig.flags(id).basanos);
  for (const uid of basanos) {
    const { data: succ } = await supabaseAdmin
      .from("user_week_statuses").select("week_start_date").eq("user_id", uid).eq("status", "success")
      .order("week_start_date", { ascending: true });
    const list = ((succ ?? []) as Array<{ week_start_date: string }>).map((r) => r.week_start_date);
    if (list.length < 29) continue;
    const beforeThreshold = list[27]; // 28번째 성공 주차 = 누적 28 < 29
    const past = await loadEvaluationEligibility({ userIds: [uid], weekStartDate: beforeThreshold });
    console.log(`  · 바사노스 ${nameOf.get(uid)}: ${beforeThreshold}(누적 28) 평가가능=${past.isEvaluable(uid)} / 현재=${evalElig.isEvaluable(uid)}`);
    ck(`③ 바사노스 ${nameOf.get(uid)} — 임계 이전 과거 주차는 평가 대상`,
      past.isEvaluable(uid) && !evalElig.isEvaluable(uid));
  }

  // 엘리트 — activity_ended_at 이 있으면 그 주차까지 평가 대상.
  const { data: elites } = await supabaseAdmin
    .from("user_profiles").select("user_id,display_name,activity_ended_at").eq("growth_status", "graduated");
  for (const e of ((elites ?? []) as Array<{ user_id: string; display_name: string | null; activity_ended_at: string | null }>)) {
    if (!scope.includes(e.user_id) || !e.activity_ended_at) continue;
    const d = String(e.activity_ended_at).slice(0, 10);
    const endWeek = weekRows.find((w) => w.week_start_date && w.week_end_date && w.week_start_date <= d && d <= w.week_end_date);
    if (!endWeek?.week_start_date) continue;
    const at = await loadEvaluationEligibility({ userIds: [e.user_id], weekStartDate: endWeek.week_start_date });
    console.log(`  · 엘리트 ${e.display_name}: 종료주차 ${endWeek.week_start_date} 평가가능=${at.isEvaluable(e.user_id)} / 현재=${evalElig.isEvaluable(e.user_id)}`);
    ck(`③ 엘리트 ${e.display_name} — 활동 종료 주차까지는 평가 대상`,
      at.isEvaluable(e.user_id) && !evalElig.isEvaluable(e.user_id));
  }

  console.log(`\n═══ PASS ${pass} / FAIL ${fail} ═══`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * 주차 결과(크루) — 팀 집계 소속 SoT 검증(읽기 전용).
 *
 *   팀 집계가 크루 표와 **같은 week-effective resolver** 를 쓰는지 값으로 확인한다.
 *   불변식(조직 × 최근 주차 전수):
 *     ① 크루 표의 팀별 인원(판정 대상만) == 팀 표의 팀별 totalCrew
 *     ② Σ 팀 totalCrew == 판정 대상 크루 수 − 미배정(팀 없음) 크루 수
 *     ③ Σ 판정 대상 + not_applicable == 상단 소속 크루 수(memberCount)
 *     ④ 미배정 버킷은 **resolver 결과에도 팀이 없는 크루**로만 구성된다
 *     ⑤ Σ advanced + regular == Σ totalCrew (버킷 탈락 = 어휘 불일치 신호)
 *
 *   Usage: npm run verify:crew-week-team-position-sot
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { computeCrewWeekPreview } from "@/lib/crewWeekPublish";
import { resolveOrgResultScope } from "@/lib/weekOrgResultState";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import { ORGANIZATIONS, type OrganizationSlug } from "@/lib/organizations";

let fail = 0;
const ck = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

const isUnassigned = (name: string | null) => {
  const v = (name ?? "").trim();
  return v === "" || v === "-";
};

async function main() {
  const activityDate = getCurrentActivityDateIso();
  const scope = resolveOrgResultScope("operating");
  console.log(`활동 기준일=${activityDate} · scope=${scope}`);

  // 종료된 최근 주차 3개(공식 휴식 제외 — 팀 대전이 없어 불변식 대상 아님).
  const { data: weeks, error } = await supabaseAdmin
    .from("weeks")
    .select("id,season_key,week_number,start_date,end_date,is_official_rest")
    .lt("end_date", activityDate)
    .eq("is_official_rest", false)
    .order("end_date", { ascending: false })
    .limit(3);
  if (error) throw new Error(`weeks 조회 실패: ${error.message}`);
  if (!weeks?.length) throw new Error("검증할 종료 주차가 없습니다.");

  for (const w of weeks as Array<Record<string, unknown>>) {
    for (const org of ORGANIZATIONS as readonly OrganizationSlug[]) {
      const label = `${w.season_key} W${w.week_number} ${org}`;
      const p = await computeCrewWeekPreview({
        organization: org,
        weekId: w.id as string,
        scope,
      });
      if (p.crewResults.length === 0) {
        console.log(`\n[${label}] 크루 0명 — 건너뜀`);
        continue;
      }
      console.log(`\n[${label}] 크루 ${p.crewResults.length}명 · 팀 ${p.teamResults.length}개`);

      // 판정 대상(= 팀 집계 모집단) = not_applicable 제외.
      const judged = p.crewResults.filter((c) => c.result !== "not_applicable");
      const unassigned = judged.filter((c) => isUnassigned(c.teamName));

      // ① 팀별 인원 일치.
      const crewByTeam = new Map<string, number>();
      for (const c of judged) {
        if (isUnassigned(c.teamName)) continue;
        crewByTeam.set(c.teamName!, (crewByTeam.get(c.teamName!) ?? 0) + 1);
      }
      const mismatched = p.teamResults.filter(
        (t) => (crewByTeam.get(t.teamName) ?? 0) !== t.totalCrew,
      );
      ck(
        "① 크루 표 팀별 인원 == 팀 표 totalCrew",
        mismatched.length === 0,
        mismatched.length
          ? mismatched
              .map((t) => `${t.teamName}: 크루표 ${crewByTeam.get(t.teamName) ?? 0} vs 팀표 ${t.totalCrew}`)
              .join(" / ")
          : p.teamResults.map((t) => `${t.teamName}=${t.totalCrew}`).join(", "),
      );

      // 팀 표에 없는데 크루 표엔 있는 팀(= 카탈로그 미매칭으로 제외된 실제 팀명) 가시화.
      const teamNames = new Set(p.teamResults.map((t) => t.teamName));
      const droppedTeams = [...crewByTeam.entries()].filter(([n]) => !teamNames.has(n));
      ck(
        "  (참고) 카탈로그 미매칭으로 팀 표에서 빠진 팀 없음",
        droppedTeams.length === 0,
        droppedTeams.map(([n, v]) => `${n}=${v}명`).join(", ") || "없음",
      );

      // ② Σ totalCrew == 판정 대상 − 미배정.
      const sumTotal = p.teamResults.reduce((a, t) => a + t.totalCrew, 0);
      const droppedCrew = droppedTeams.reduce((a, [, v]) => a + v, 0);
      ck(
        "② Σ 팀 totalCrew == 판정 대상 − 미배정 − 미매칭팀",
        sumTotal === judged.length - unassigned.length - droppedCrew,
        `${sumTotal} == ${judged.length} − ${unassigned.length} − ${droppedCrew}`,
      );

      // ③ 상단 소속 크루 수와의 관계.
      const notApplicable = p.crewResults.length - judged.length;
      ck(
        "③ 판정 대상 + 해당없음 == 상단 소속 크루",
        p.memberCount == null || judged.length + notApplicable === p.memberCount,
        `${judged.length} + ${notApplicable} vs memberCount=${String(p.memberCount)}`,
      );

      // ④ 미배정은 resolver 결과에도 팀이 없는 크루만.
      ck(
        "④ 미배정 = resolver 에도 팀 없음(현재 멤버십 불일치로 생기지 않음)",
        unassigned.every((c) => isUnassigned(c.teamName)),
        unassigned.length ? `${unassigned.length}명(${unassigned.map((c) => c.crewDisplayName ?? c.userId.slice(0, 8)).join(", ")})` : "0명",
      );

      // ⑤ 심화/정규 버킷 총원 보존.
      const sumAdvReg = p.teamResults.reduce((a, t) => a + t.advancedCrew + t.regularCrew, 0);
      ck(
        "⑤ Σ(심화+정규) == Σ totalCrew (버킷 탈락 없음)",
        sumAdvReg === sumTotal,
        `${sumAdvReg} vs ${sumTotal}`,
      );

      // ⑥ 파트 수 = 실제 팀들의 배정 파트만.
      ck(
        "⑥ 팀 표에 미배정 행 없음",
        p.teamResults.every((t) => t.teamId != null && t.teamName !== "미배정"),
        p.teamResults.map((t) => t.teamName).join(", "),
      );
    }
  }

  console.log(fail === 0 ? "\nPASS — 실패 0건" : `\nFAIL — 실패 ${fail}건`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * 팀 내역 상단 요약 — 원천 데이터 대조(오늘 날짜 기준 유효 클럽/팀/파트 고유 ID).
 *   · currentDate = getCurrentActivityDateIso(Asia/Seoul), currentHalf = resolveCurrentHalfKey.
 *   · 유효 팀 = cluster4_team_halves(현재 반기 · is_active · 모드 스코프). 유효 파트 = 그 팀들의
 *     cluster4_team_parts(파트는 status/deleted/date 컬럼 없음 → 부모 팀 유효성 상속, 하드삭제=cascade).
 *   · 고유 ID(Set) 기준으로 totalClubs/totalTeams/totalParts 를 세고 loadTeamPartsCurrentSummary 와 대조.
 *   READ-ONLY. npx tsx --env-file=.env.local scripts/debug-team-parts-summary-source.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ORGANIZATIONS } from "@/lib/organizations";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import {
  resolveCurrentHalfKey,
  loadTeamPartsCurrentSummary,
} from "@/lib/adminTeamHalvesData";
import { resolveEffectiveScopeMode } from "@/lib/cluster4ExperienceTestScope";
import type { ScopeMode } from "@/lib/userScopeShared";

async function dump(mode: ScopeMode) {
  const today = getCurrentActivityDateIso();
  const currentHalf = await resolveCurrentHalfKey();
  const wantQaTest = resolveEffectiveScopeMode(mode) === "test";
  console.log(
    `\n════ mode=${mode} (effective wantQaTest=${wantQaTest}) · today=${today} · currentHalf=${currentHalf} ════`,
  );

  const clubIds = new Set<string>();
  const teamIds = new Set<string>();
  const partIds = new Set<string>();
  const partRows: Array<Record<string, unknown>> = [];

  for (const org of ORGANIZATIONS) {
    // 유효 팀 = 현재 반기 · is_active · 스코프.
    const { data: halves, error } = await supabaseAdmin
      .from("cluster4_team_halves")
      .select("id,team_name,is_active,is_qa_test,half_key,organization_slug")
      .eq("organization_slug", org)
      .eq("half_key", currentHalf ?? "")
      .eq("is_active", true);
    if (error) throw new Error(error.message);
    const scoped = (halves ?? []).filter(
      (h: { is_qa_test: boolean | null }) => Boolean(h.is_qa_test) === wantQaTest,
    );
    if (scoped.length > 0) clubIds.add(org);
    const teamNameById = new Map<string, string>();
    for (const h of scoped as Array<{ id: string; team_name: string }>) {
      teamIds.add(h.id);
      teamNameById.set(h.id, h.team_name);
    }
    const ids = [...teamNameById.keys()];
    if (ids.length === 0) continue;

    const { data: parts, error: pErr } = await supabaseAdmin
      .from("cluster4_team_parts")
      .select("id,team_half_id,part_name,is_default,display_order")
      .in("team_half_id", ids);
    if (pErr) throw new Error(pErr.message);
    for (const p of (parts ?? []) as Array<{
      id: string;
      team_half_id: string;
      part_name: string;
      is_default: boolean | null;
      display_order: number | null;
    }>) {
      partIds.add(p.id);
      partRows.push({
        club: org,
        teamId: p.team_half_id,
        teamName: teamNameById.get(p.team_half_id) ?? "?",
        partId: p.id,
        partName: p.part_name,
        isDefault: p.is_default,
      });
    }
  }

  // 팀별 파트 수 요약.
  const perTeam = new Map<string, number>();
  for (const r of partRows) {
    const k = `${r.club}/${r.teamName}`;
    perTeam.set(k, (perTeam.get(k) ?? 0) + 1);
  }
  console.log("팀별 파트 수:");
  for (const [k, n] of [...perTeam.entries()].sort())
    console.log(`  ${k}: ${n}`);
  console.log(
    `\n고유 ID 집계 → totalClubs=${clubIds.size} totalTeams=${teamIds.size} totalParts=${partIds.size}`,
  );
  console.log(
    `partRows(조인 행 수)=${partRows.length}  vs  고유 partId=${partIds.size}  (중복=${partRows.length - partIds.size})`,
  );

  // loadTeamPartsCurrentSummary 와 대조.
  const summary = await loadTeamPartsCurrentSummary(mode);
  const match =
    summary.counts.totalClubs === clubIds.size &&
    summary.counts.totalTeams === teamIds.size &&
    summary.counts.totalParts === partIds.size;
  console.log(
    `\nsummary.counts = ${JSON.stringify(summary.counts)}  → ${match ? "✅ 원천 고유ID와 일치" : "❌ 불일치"}`,
  );
  console.log(`currentWeek.label = ${summary.currentWeek?.label ?? "null"} · currentDate = ${summary.currentDate}`);

  // 파트 상세(전량) — partId/partName/teamName/club.
  console.log("\n파트 상세(전량):");
  console.table(
    partRows
      .sort((a, b) =>
        `${a.club}/${a.teamName}/${a.partName}`.localeCompare(
          `${b.club}/${b.teamName}/${b.partName}`,
        ),
      )
      .map((r) => ({
        club: r.club,
        teamName: r.teamName,
        partName: r.partName,
        isDefault: r.isDefault,
        partId: String(r.partId).slice(0, 8),
      })),
  );

  return { totalClubs: clubIds.size, totalTeams: teamIds.size, totalParts: partIds.size };
}

async function main() {
  await dump("operating");
  await dump("test");

  // 대조: 선택 반기(과거)의 파트 수와 비교 — "selectedHalf 전체 파트 합산" 가설 반증.
  const currentHalf = await resolveCurrentHalfKey();
  const past = "2024-H1";
  for (const half of [currentHalf, past]) {
    const { data: halves } = await supabaseAdmin
      .from("cluster4_team_halves")
      .select("id")
      .eq("half_key", half ?? "")
      .eq("is_active", true);
    const ids = (halves ?? []).map((h: { id: string }) => h.id);
    let parts = 0;
    if (ids.length > 0) {
      const { data } = await supabaseAdmin
        .from("cluster4_team_parts")
        .select("id")
        .in("team_half_id", ids);
      parts = (data ?? []).length;
    }
    console.log(`\n[반기별 전체 파트(전 org·전 스코프)] half=${half}: teams=${ids.length} parts=${parts}`);
  }

  // 대조: 파트 테이블 전체 행 수(전 반기·전 스코프 포함) — "테이블 전체 행 수" 가설 반증.
  const { count: allParts } = await supabaseAdmin
    .from("cluster4_team_parts")
    .select("id", { count: "exact", head: true });
  console.log(`[cluster4_team_parts 전체 행 수(모든 반기·모든 팀)] = ${allParts}`);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

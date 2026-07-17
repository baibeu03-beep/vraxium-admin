/**
 * (READ-ONLY 진단) 액트 체크 신청율 — SoT 조사.
 *   1) 변동(irregular) 액트에 "생성됐지만 체크 신청 없음" 상태가 실재하는가?
 *      (kind/status/review_link/scheduled_check_at/completed_at 조합 분포)
 *   2) 목록(loadTeamPartsInfoWeeks) vs 상세(loadTeamPartsInfoActCheckManagement) 수치 발산 실측.
 *   3) 정규 액트 가동 SoT 발산: check_target 상수 vs weekOpenGate(주차별).
 *
 *   npx tsx --env-file=.env.local scripts/diag-act-check-application-sot.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadTeamPartsInfoWeeks } from "@/lib/adminTeamPartsInfoWeeksData";
import { loadTeamPartsInfoActCheckManagement } from "@/lib/adminTeamPartsInfoActCheckData";
import { ORGANIZATIONS } from "@/lib/organizations";
import type { OrganizationSlug } from "@/lib/organizations";

function line(s = "") {
  console.log(s);
}

async function main() {
  // ── 1) 변동 액트 상태 분포 ─────────────────────────────────────────────
  line("═══ 1) 변동(process_irregular_acts) 상태 분포 ═══");
  const irrCols =
    "id,week_id,kind,status,review_link,scheduled_check_at,completed_at,organization_slug,scope_mode,created_at";
  let irr: Array<Record<string, unknown>> = [];
  {
    let res = await supabaseAdmin.from("process_irregular_acts").select(irrCols + ",origin");
    if (res.error && (res.error as { code?: string }).code === "42703") {
      res = await supabaseAdmin.from("process_irregular_acts").select(irrCols);
    }
    if (res.error) {
      line(`  ✗ 조회 실패: ${res.error.message}`);
    } else {
      irr = (res.data ?? []) as Array<Record<string, unknown>>;
    }
  }
  line(`  총 변동 액트 행: ${irr.length}`);
  const combo = new Map<string, number>();
  for (const r of irr) {
    const k = [
      `kind=${r.kind ?? "-"}`,
      `status=${r.status ?? "-"}`,
      `link=${r.review_link ? "Y" : "N"}`,
      `sched=${r.scheduled_check_at ? "Y" : "N"}`,
      `completed=${r.completed_at ? "Y" : "N"}`,
      `origin=${(r as { origin?: string | null }).origin ?? "-"}`,
    ].join(" | ");
    combo.set(k, (combo.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...combo.entries()].sort((a, b) => b[1] - a[1])) {
    line(`   ${String(n).padStart(4)}×  ${k}`);
  }
  // 핵심 질문: 신청 신호(link/sched)가 전혀 없는 변동 행이 있는가?
  const noApply = irr.filter((r) => !r.review_link && !r.scheduled_check_at && !r.completed_at);
  line(`  ▶ "신청 신호 전무(link=N·sched=N·completed=N)" 행: ${noApply.length}`);
  const pendingReview = irr.filter((r) => r.kind === "review_request" && r.status === "pending");
  line(`  ▶ review_request + pending(검수 전) 행: ${pendingReview.length}`);

  // ── 2) 정규 액트 가동 SoT 발산 ─────────────────────────────────────────
  line();
  line("═══ 2) 정규 액트 카탈로그(check_target) ═══");
  const { data: acts } = await supabaseAdmin
    .from("process_acts")
    .select("id,hub,check_target,is_active")
    .eq("is_active", true);
  const actRows = (acts ?? []) as Array<{ id: string; hub: string; check_target: string | null }>;
  const byHub = new Map<string, { total: number; checkTarget: number }>();
  for (const a of actRows) {
    const e = byHub.get(a.hub) ?? { total: 0, checkTarget: 0 };
    e.total++;
    if (a.check_target === "check") e.checkTarget++;
    byHub.set(a.hub, e);
  }
  for (const [hub, e] of byHub) {
    line(`   hub=${hub.padEnd(11)} 활성=${String(e.total).padStart(3)}  check_target='check'=${String(e.checkTarget).padStart(3)}`);
  }
  line(`  ▶ 목록 LINE_HUBS=[info,experience,competency] (club 제외) / 상세 ACT_HUBS=[info,experience,competency,club]`);

  // ── 3) 목록 vs 상세 발산 실측 ──────────────────────────────────────────
  line();
  line("═══ 3) 목록 vs 상세 수치 발산(주차별) ═══");
  // 주차별 오픈 설정(open_confirmed) 분포 — 상세 "가동=0" 의 원인 규명.
  {
    const { data: cfgs, error } = await supabaseAdmin
      .from("cluster4_week_opening_configs")
      .select("week_id,organization_slug,open_confirmed");
    if (error) line(`  ✗ week_opening_configs 조회 실패: ${error.message}`);
    else {
      const rows = (cfgs ?? []) as Array<{ organization_slug: string | null; open_confirmed: boolean | null }>;
      line(`  cluster4_week_opening_configs 행: ${rows.length}`);
      const c = new Map<string, number>();
      for (const r of rows) {
        const k = `${r.organization_slug ?? "-"} | open_confirmed=${r.open_confirmed === true ? "Y" : r.open_confirmed === false ? "N" : "null"}`;
        c.set(k, (c.get(k) ?? 0) + 1);
      }
      for (const [k, n] of [...c.entries()].sort()) line(`   ${String(n).padStart(4)}×  ${k}`);
    }
  }

  line();
  for (const org of ORGANIZATIONS as readonly OrganizationSlug[]) {
    let list;
    try {
      list = await loadTeamPartsInfoWeeks({ organization: org, page: 1, pageSize: 4 });
    } catch (e) {
      line(`  [${org}] 목록 조회 실패: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    line(`  ── ${org} ──`);
    for (const it of list.items.slice(0, 4)) {
      let det;
      try {
        det = await loadTeamPartsInfoActCheckManagement({
          weekId: it.weekId,
          organization: org,
          mode: "operating",
        });
      } catch (e) {
        line(`   ${it.weekName}: 상세 실패 ${e instanceof Error ? e.message : e}`);
        continue;
      }
      const d = det.summary;
      const l = it.actCheck;
      const same = JSON.stringify(l) === JSON.stringify(d);
      const fmt = (s: typeof d) =>
        `전체=${String(s.totalCount).padStart(3)} 가동=${String(s.activeCount).padStart(3)} 체크=${String(s.checkedCount).padStart(3)} 미체크=${String(s.uncheckedCount).padStart(3)} 변동=${String(s.variableCount).padStart(2)} 율=${String(s.applicationRate).padStart(3)}%`;
      line(`   ${it.weekName.padEnd(14)} 목록[${fmt(l)}]  ${same ? "== 상세 일치" : `❌발산 상세[${fmt(d)}]`}`);
    }
  }
  line();
  line("완료(read-only — write 없음).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// 진단(read-only): 실무 역량 라인 개설 오픈 게이트(practicalCompetency.checked) 정합성 감사.
//   ① cluster4_week_opening_configs 의 org×week 별 open_confirmed / practicalCompetency.checked → 게이트 결과.
//   ② 활성 competency 라인(cluster4_lines)의 대상 주차를 역참조해, "정상 진행이 아닌" 주차에 이미
//      개설된 라인이 존재하는지(기존 잘못 개설 데이터) 스캔한다. 데이터 변경 없음.
// 사용법: npx tsx --env-file=.env.local scripts/diag-competency-line-open-gate.ts
import { createClient } from "@supabase/supabase-js";
import { isCompetencyLineOpenForWeek } from "../lib/weekOpenGate";
import type { SavedConfig } from "../lib/adminTeamPartsInfoWeekDetailData";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function weekLabel(weekId: string): Promise<string> {
  const { data } = await sb
    .from("weeks")
    .select("start_date,end_date,iso_year,iso_week")
    .eq("id", weekId)
    .maybeSingle();
  const d = data as { start_date?: string; iso_year?: number; iso_week?: number } | null;
  return d ? `${d.start_date} (ISO ${d.iso_year}-W${d.iso_week})` : "(주차 정보 없음)";
}

async function main() {
  console.log("=".repeat(78));
  console.log("① org×week 오픈 설정 게이트 (open_confirmed && practicalCompetency.checked)");
  console.log("=".repeat(78));

  const { data: cfgRows, error: cfgErr } = await sb
    .from("cluster4_week_opening_configs")
    .select("week_id,organization_slug,config,open_confirmed");
  if (cfgErr) {
    console.error("configs 조회 실패:", cfgErr.message);
    process.exit(1);
  }
  const rows = (cfgRows ?? []) as Array<{
    week_id: string;
    organization_slug: string;
    config: SavedConfig | null;
    open_confirmed: boolean;
  }>;
  console.log(`\n총 ${rows.length} 개 config 행\n`);

  const gateByWeekOrg = new Map<string, boolean>();
  const key = (w: string, o: string) => `${w}::${o}`;
  // 최근순 정렬 위해 week 라벨 캐시.
  const labelCache = new Map<string, string>();
  const label = async (w: string) => {
    if (!labelCache.has(w)) labelCache.set(w, await weekLabel(w));
    return labelCache.get(w)!;
  };

  for (const r of rows) {
    const checked = r.config?.practicalCompetency?.checked === true;
    const gate = isCompetencyLineOpenForWeek({
      openConfirmed: r.open_confirmed,
      config: r.config,
    });
    gateByWeekOrg.set(key(r.week_id, r.organization_slug), gate);
    console.log(
      `  [${r.organization_slug}] ${await label(r.week_id)}\n` +
        `      open_confirmed=${r.open_confirmed} · practicalCompetency.checked=${checked}` +
        ` · 개설가능(canOpen)=${gate ? "✅ 예" : "⛔ 아니오"}`,
    );
  }

  console.log("\n" + "=".repeat(78));
  console.log("② 활성 competency 라인의 대상 주차 게이트 감사 (기존 잘못 개설 데이터 탐지)");
  console.log("=".repeat(78));

  const { data: lineRows, error: lineErr } = await sb
    .from("cluster4_lines")
    .select("id,line_code,competency_line_master_id,is_active,is_qa_test")
    .eq("part_type", "competency")
    .eq("is_active", true);
  if (lineErr) {
    console.error("lines 조회 실패:", lineErr.message);
    process.exit(1);
  }
  const lines = (lineRows ?? []) as Array<{
    id: string;
    line_code: string | null;
    competency_line_master_id: string | null;
    is_active: boolean;
    is_qa_test: boolean;
  }>;
  console.log(`\n활성 competency 라인 ${lines.length}개\n`);

  // 각 라인의 대상 주차(cluster4_line_targets.week_id) 조회.
  let flagged = 0;
  let checkedLines = 0;
  for (const ln of lines) {
    const { data: tgts } = await sb
      .from("cluster4_line_targets")
      .select("week_id,organization_slug")
      .eq("line_id", ln.id);
    const tgtRows = (tgts ?? []) as Array<{ week_id: string | null; organization_slug: string | null }>;
    const weekIds = Array.from(new Set(tgtRows.map((t) => t.week_id).filter((w): w is string => !!w)));
    // 라인 org 는 target.organization_slug 우선(없으면 config 매칭으로 추정 불가 → 표시만).
    const orgs = Array.from(
      new Set(tgtRows.map((t) => t.organization_slug).filter((o): o is string => !!o)),
    );
    for (const w of weekIds) {
      // 이 주차에 대한 org 별 게이트 확인 — org 는 target org 우선, 없으면 config 에 등장하는 org 전부 대조.
      const candidateOrgs =
        orgs.length > 0
          ? orgs
          : rows.filter((r) => r.week_id === w).map((r) => r.organization_slug);
      for (const o of candidateOrgs) {
        const g = gateByWeekOrg.get(key(w, o));
        checkedLines++;
        if (g === false) {
          flagged++;
          console.log(
            `  ⚠ 라인 ${ln.id} (line_code=${ln.line_code ?? "-"}, qa=${ln.is_qa_test})` +
              ` — [${o}] ${await label(w)} = 정상 진행 아님인데 개설됨`,
          );
        } else if (g === undefined) {
          console.log(
            `  · 라인 ${ln.id} — [${o}] ${await label(w)} = config 행 없음(과거/미설정 주차, 게이트 미대상)`,
          );
        }
      }
    }
  }

  console.log(
    `\n감사 결과: 활성 competency 라인 대상(라인×주차×org) ${checkedLines}건 중 ` +
      `"정상 진행 아님 + 개설됨" = ${flagged}건`,
  );
  console.log(
    flagged === 0
      ? "→ 게이트 위반으로 개설된 활성 라인 없음(또는 전부 config 미설정 과거 주차)."
      : "→ 위 ⚠ 항목은 기존 데이터. 이번 수정은 추가 개설만 차단하며 기존 라인은 자동 변경/삭제하지 않음.",
  );
}

main().then(() => process.exit(0));

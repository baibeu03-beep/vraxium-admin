// 프로세스 체크 로그 범위(scope_type) 상태 프로브 — 마이그 적용 여부 + 폴백 파생 정합 확인.
//   run: npx tsx --env-file=.env.local scripts/probe-check-log-scope-state.ts
import { createClient } from "@supabase/supabase-js";
import {
  formatPartName,
  resolveLogScopeDisplay,
} from "@/lib/adminProcessCheckTypes";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });

async function colExists(table: string, col: string): Promise<boolean> {
  const { error } = await sb.from(table).select(col).limit(1);
  if (!error) return true;
  if (error.code === "42703" || error.code === "PGRST204" || error.code === "PGRST205") return false;
  console.log(`   (probe ${table}.${col} other error: ${error.code} ${error.message})`);
  return true;
}

async function main() {
  console.log("── 마이그 적용 여부 ──");
  const lgScope = await colExists("process_line_groups", "scope_type");
  const logScope = await colExists("process_check_logs", "scope_type");
  console.log(`  process_line_groups.scope_type : ${lgScope ? "적용됨" : "미적용(폴백)"}`);
  console.log(`  process_check_logs.scope_type  : ${logScope ? "적용됨" : "미적용(폴백)"}`);

  console.log("\n── 순수 formatter 검증(formatPartName) ──");
  const fcases: Array<[string, string]> = [
    ["푸드", "푸드 파트"],
    ["푸드 파트", "푸드 파트"],
    ["촛불", "촛불 파트"],
  ];
  for (const [inp, exp] of fcases) {
    const got = formatPartName(inp);
    console.log(`  ${got === exp ? "✓" : "✗"} formatPartName("${inp}") = "${got}" (기대 "${exp}")`);
  }

  console.log("\n── 순수 resolver 검증(resolveLogScopeDisplay) ──");
  const rcases: Array<[Parameters<typeof resolveLogScopeDisplay>[0], string | null, string, string]> = [
    ["TEAM", null, "team", "팀 총괄"],
    ["PART", "푸드", "part", "푸드 파트"],
    ["PART", null, "missing", "파트 미확인"],
    [null, null, "none", ""],
  ];
  for (const [st, pn, ekind, elabel] of rcases) {
    const r = resolveLogScopeDisplay(st, pn);
    const ok = r.kind === ekind && r.label === elabel;
    console.log(`  ${ok ? "✓" : "✗"} (${st}, ${pn ?? "null"}) → {${r.kind}, "${r.label}"} (기대 {${ekind}, "${elabel}"})`);
  }

  console.log("\n── 실제 experience 로그 샘플(최근 12건) ──");
  const sel = logScope
    ? "action,team_name,part_name,scope_type,line_group_name,act_name,created_at"
    : "action,team_name,part_name,line_group_name,act_name,created_at";
  const { data, error } = await sb
    .from("process_check_logs")
    .select(sel)
    .eq("hub", "experience")
    .order("created_at", { ascending: false })
    .limit(12);
  if (error) {
    console.log(`  (조회 실패: ${error.message})`);
  } else if (!data || data.length === 0) {
    console.log("  (experience 로그 없음)");
  } else {
    for (const row of data as Array<Record<string, unknown>>) {
      const team = (row.team_name as string | null) ?? null;
      const part = (row.part_name as string | null) ?? null;
      // 저장값 우선, 없으면 read 폴백(팀명 있으면 part 유무로 파생).
      const stored = (row.scope_type as string | null | undefined) ?? undefined;
      const scopeType =
        stored === "TEAM" || stored === "PART"
          ? stored
          : team
            ? part != null
              ? "PART"
              : "TEAM"
            : null;
      const disp = resolveLogScopeDisplay(scopeType as "TEAM" | "PART" | null, part);
      console.log(
        `  [${row.action}] team=${team ?? "-"} part=${part ?? "-"} scope=${stored ?? "(폴백)"}` +
          ` → ${team ? `${team} 팀 [${disp.label}]` : "(비팀)"}  | ${row.line_group_name} / ${row.act_name}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

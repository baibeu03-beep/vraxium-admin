/**
 * diag-oranke-info-lines-real.ts (READ-ONLY)
 * 오랑캐 2026-spring W1~W11 에 실제 저장된 실무 정보(part_type=info) 라인 조회.
 *   - cluster4_lines.week_id 기준(엑셀 import / 개설 저장본) + 그 주차 target 가진 라인.
 *   - 각 라인의 line_code / main_title / activity_type / is_active / oranke 가시성.
 * 실행: npx tsx --env-file=.env.local scripts/diag-oranke-info-lines-real.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { resolveLineScopeFromValues, isLineScopeVisibleForOrg } from "@/lib/lineScope";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const ORG = "oranke";

async function main() {
  const { data: weeks } = await sb
    .from("weeks").select("id,week_number,start_date,is_official_rest")
    .eq("season_key", "2026-spring").gte("week_number", 1).lte("week_number", 11).order("week_number");
  const weekRows = (weeks ?? []) as any[];
  const weekIds = weekRows.map((w) => w.id);
  const wnumById = new Map(weekRows.map((w) => [w.id, w.week_number]));

  // (a) 라인 자신의 week_id 가 W1~11 인 info 라인
  const { data: linesByWeek } = await sb
    .from("cluster4_lines")
    .select("id,line_code,main_title,activity_type_id,is_active,week_id")
    .eq("part_type", "info").in("week_id", weekIds);

  // (b) W1~11 주차에 target 을 가진 info 라인(line.week_id 가 null 인 import 라인 대비)
  const { data: tRows } = await sb
    .from("cluster4_line_targets")
    .select("line_id,week_id, cluster4_lines!inner(id,line_code,main_title,activity_type_id,is_active,part_type)")
    .in("week_id", weekIds).eq("cluster4_lines.part_type", "info");

  // 라인 → 주차 후보 집합
  const lineMeta = new Map<string, any>();
  const weeksByLine = new Map<string, Set<number>>();
  for (const l of (linesByWeek ?? []) as any[]) {
    lineMeta.set(l.id, l);
    const s = weeksByLine.get(l.id) ?? new Set<number>(); s.add(wnumById.get(l.week_id)!); weeksByLine.set(l.id, s);
  }
  for (const t of (tRows ?? []) as any[]) {
    const l = t.cluster4_lines; lineMeta.set(l.id, l);
    const s = weeksByLine.get(l.id) ?? new Set<number>(); s.add(wnumById.get(t.week_id)!); weeksByLine.set(l.id, s);
  }

  console.log(`[오랑캐 2026-spring W1~11 실제 info 라인] 총 ${lineMeta.size}개 (라인 단위)\n`);
  // 주차별 정리
  const byWeek = new Map<number, any[]>();
  for (const [lineId, l] of lineMeta) {
    const scope = resolveLineScopeFromValues({ partType: "info", lineCode: l.line_code });
    const visible = isLineScopeVisibleForOrg(scope, ORG as any, { allowUnknown: false });
    for (const wn of weeksByLine.get(lineId)!) {
      const arr = byWeek.get(wn) ?? []; arr.push({ ...l, scopeOrg: scope.org, visible }); byWeek.set(wn, arr);
    }
  }
  for (const w of weekRows) {
    const arr = (byWeek.get(w.week_number) ?? []).sort((a, b) => String(a.activity_type_id).localeCompare(String(b.activity_type_id)));
    console.log(`W${String(w.week_number).padStart(2)} ${w.start_date} rest=${w.is_official_rest}: ${arr.length}개`);
    for (const l of arr) {
      console.log(`    [${l.visible ? "oranke가시" : "숨김 org=" + l.scopeOrg}] act=${l.activity_type_id} active=${l.is_active} code=${l.line_code ?? "(null)"} | "${String(l.main_title).slice(0, 40)}" | id=${l.id}`);
    }
  }
  // oranke 가시 + active 만 요약
  const orankeVisible = [...lineMeta.entries()].filter(([id, l]) => {
    const scope = resolveLineScopeFromValues({ partType: "info", lineCode: l.line_code });
    return l.is_active && isLineScopeVisibleForOrg(scope, ORG as any, { allowUnknown: false });
  });
  console.log(`\n[요약] oranke 가시 + active info 라인: ${orankeVisible.length}개`);
}

main().catch((e) => { console.error("ERR", e); process.exit(1); });

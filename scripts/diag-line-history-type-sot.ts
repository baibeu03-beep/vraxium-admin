/**
 * 라인 강화 내역 "유형" SoT 대조(READ-ONLY).
 *
 *   npx tsx --env-file=.env.local scripts/diag-line-history-type-sot.ts
 *
 * 목적: /admin/lines/register 가 실제로 표시하는 실무 역량/경험 "유형"이 어디서 오는지
 *   실제 데이터 한 행 기준으로 나란히 보여준다. 어떤 것도 추론/하드코딩하지 않는다.
 *
 * 대조 경로(역량):
 *   cluster4_lines(part_type='competency').competency_line_master_id
 *   → cluster4_competency_line_masters.id (라인명/코드; category 컬럼 없음)
 *   → line_registrations(hub='competency', bridged_master_id = master.id).line_type  ← 유형 SoT
 *
 * 대조 경로(경험):
 *   cluster4_lines(part_type='experience').experience_line_master_id
 *   → cluster4_experience_line_masters.experience_category (System B 코드)
 *   → line_registrations(hub='experience', bridged_master_id = master.id).line_type (원장 '평가')
 *   표시 라벨은 EXPERIENCE_OVERALL_CATEGORIES(evaluation→'견문').
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function bridgeLineTypeByMasterIds(
  hub: "competency" | "experience",
  masterIds: string[],
): Promise<Map<string, { lineType: string | null; regLineName: string | null; regCode: string | null }>> {
  const map = new Map<string, { lineType: string | null; regLineName: string | null; regCode: string | null }>();
  if (masterIds.length === 0) return map;
  const { data, error } = await supabase
    .from("line_registrations")
    .select("bridged_master_id,line_type,line_name,line_code,hub")
    .eq("hub", hub)
    .in("bridged_master_id", masterIds);
  if (error) throw new Error(`line_registrations(${hub}): ${error.message}`);
  for (const r of (data ?? []) as Array<{
    bridged_master_id: string | null;
    line_type: string | null;
    line_name: string | null;
    line_code: string | null;
  }>) {
    if (r.bridged_master_id) {
      map.set(r.bridged_master_id, {
        lineType: r.line_type,
        regLineName: r.line_name,
        regCode: r.line_code,
      });
    }
  }
  return map;
}

async function main() {
  console.log("════════ 라인 강화 내역 유형 SoT 대조(READ-ONLY) ════════\n");

  // ── 1. 역량(competency) 실제 라인 몇 건 ──
  const { data: compLines, error: e1 } = await supabase
    .from("cluster4_lines")
    .select("id,line_code,competency_line_master_id")
    .eq("part_type", "competency")
    .not("competency_line_master_id", "is", null)
    .limit(8);
  if (e1) throw new Error(`cluster4_lines(competency): ${e1.message}`);

  const compMasterIds = Array.from(
    new Set((compLines ?? []).map((l) => l.competency_line_master_id as string)),
  );
  const { data: compMasters } = await supabase
    .from("cluster4_competency_line_masters")
    .select("id,line_code,line_name")
    .in("id", compMasterIds);
  const compMasterById = new Map((compMasters ?? []).map((m) => [m.id as string, m]));
  const compBridge = await bridgeLineTypeByMasterIds("competency", compMasterIds);

  console.log("── 실무 역량 ─────────────────────────────────────────────");
  for (const l of compLines ?? []) {
    const masterId = l.competency_line_master_id as string;
    const master = compMasterById.get(masterId);
    const reg = compBridge.get(masterId);
    console.log({
      lineId: l.id,
      lineCode_internal: l.line_code,
      competencyLineMasterId: masterId,
      masterLineName: master?.line_name ?? null,
      masterCategoryColumn: "(컬럼 없음)",
      "register(line_registrations).line_type = 유형 SoT": reg?.lineType ?? "(브리지 미존재)",
      registerLineName: reg?.regLineName ?? null,
      registerDisplayCode: reg?.regCode ?? null,
      "라인 강화 내역에 표시될 유형": reg?.lineType ?? "-",
    });
  }
  console.log(`\n역량 라인 ${compLines?.length ?? 0}건, 브리지 매칭 ${compBridge.size}건\n`);

  // 유형 분포(전체 competency registration)
  const { data: allCompReg } = await supabase
    .from("line_registrations")
    .select("line_type")
    .eq("hub", "competency");
  const dist = new Map<string, number>();
  for (const r of (allCompReg ?? []) as Array<{ line_type: string | null }>) {
    const k = r.line_type ?? "(null)";
    dist.set(k, (dist.get(k) ?? 0) + 1);
  }
  console.log("competency line_registrations.line_type 분포:", Object.fromEntries(dist));

  // ── 2. 경험(experience) 대조 ──
  const { data: expLines, error: e2 } = await supabase
    .from("cluster4_lines")
    .select("id,line_code,experience_line_master_id")
    .eq("part_type", "experience")
    .not("experience_line_master_id", "is", null)
    .limit(8);
  if (e2) throw new Error(`cluster4_lines(experience): ${e2.message}`);
  const expMasterIds = Array.from(
    new Set((expLines ?? []).map((l) => l.experience_line_master_id as string)),
  );
  const { data: expMasters } = await supabase
    .from("cluster4_experience_line_masters")
    .select("id,line_code,line_name,experience_category")
    .in("id", expMasterIds);
  const expMasterById = new Map((expMasters ?? []).map((m) => [m.id as string, m]));
  const expBridge = await bridgeLineTypeByMasterIds("experience", expMasterIds);

  const EXP_LABEL: Record<string, string> = {
    derivation: "도출",
    analysis: "분석",
    evaluation: "견문",
    extension: "확장",
    management: "관리",
  };

  console.log("\n── 실무 경험 ─────────────────────────────────────────────");
  for (const l of expLines ?? []) {
    const masterId = l.experience_line_master_id as string;
    const master = expMasterById.get(masterId) as
      | { line_name: string; experience_category: string | null }
      | undefined;
    const reg = expBridge.get(masterId);
    const cat = master?.experience_category ?? null;
    console.log({
      lineId: l.id,
      experienceLineMasterId: masterId,
      masterLineName: master?.line_name ?? null,
      "master.experience_category (System B)": cat,
      "register.line_type (원장, 평가)": reg?.lineType ?? "(브리지 미존재)",
      "표시 유형(EXPERIENCE_OVERALL_CATEGORIES)": cat ? EXP_LABEL[cat] ?? cat : "-",
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

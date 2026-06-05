/**
 * READ-ONLY 진단: 2026-spring(레거시 예정) 주차 라인/타깃/제출 분포 조사.
 *   npx tsx --env-file=.env.local scripts/diag-legacy-unified-line-probe.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function pageAll<T>(table: string, select: string, filter: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(select).order("id", { ascending: true }).range(from, from + 999);
    q = filter(q);
    let data: any = null;
    let error: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await q;
        data = res.data; error = res.error;
        if (!error) break;
      } catch (e) {
        error = e;
      }
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
    if (error) throw new Error(`${table}: ${error.message ?? error}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  // 1) weeks: 2026-spring 전부
  const { data: weeks, error: we } = await sb
    .from("weeks")
    .select("id,start_date,end_date,season_key,week_number,result_published_at,is_official_rest")
    .gte("start_date", "2026-03-02")
    .lte("start_date", "2026-06-28")
    .order("start_date");
  if (we) throw new Error(we.message);
  console.log("=== 2026-spring weeks ===");
  for (const w of weeks ?? []) {
    console.log(
      `${w.start_date} W${w.week_number} season=${w.season_key} published=${w.result_published_at ? "Y" : "n"} rest=${w.is_official_rest} id=${w.id}`,
    );
  }
  const weekIds = (weeks ?? []).map((w: any) => w.id);
  const weekById = new Map((weeks ?? []).map((w: any) => [w.id, w]));

  // 2) 테스터 식별
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const testerIds = new Set((markers ?? []).map((m: any) => m.user_id).filter(Boolean));
  console.log(`\n테스터 수(test_user_markers): ${testerIds.size}`);

  // 3) lines per week per part
  type LineRow = {
    id: string; week_id: string; part_type: string; main_title: string | null;
    line_code: string | null; is_active: boolean;
    experience_line_master_id: string | null; activity_type_id: string | null;
    competency_line_master_id: string | null; career_project_id: string | null;
    source_file_name: string | null;
  };
  const lines = await pageAll<LineRow>(
    "cluster4_lines",
    "id,week_id,part_type,main_title,line_code,is_active,experience_line_master_id,activity_type_id,competency_line_master_id,career_project_id,source_file_name",
    (q) => q.in("week_id", weekIds),
  );
  console.log(`\n라인 총수(spring): ${lines.length}`);

  // experience masters → slot order
  const expMasterIds = [...new Set(lines.map((l) => l.experience_line_master_id).filter(Boolean))] as string[];
  const slotByMaster = new Map<string, number>();
  const nameByMaster = new Map<string, string>();
  if (expMasterIds.length) {
    const { data: masters } = await sb
      .from("cluster4_experience_line_masters")
      .select("id,experience_slot_order,line_name,organization_slug")
      .in("id", expMasterIds);
    for (const m of (masters ?? []) as any[]) {
      slotByMaster.set(m.id, m.experience_slot_order);
      nameByMaster.set(m.id, `${m.line_name}(org=${m.organization_slug})`);
    }
  }

  // 4) targets + submissions
  type TargetRow = { id: string; line_id: string; week_id: string; target_user_id: string | null };
  const targets = await pageAll<TargetRow>(
    "cluster4_line_targets",
    "id,line_id,week_id,target_user_id",
    (q) => q.in("week_id", weekIds),
  );
  console.log(`타깃 총수(spring): ${targets.length}`);

  const targetIds = targets.map((t) => t.id);
  type SubRow = { id: string; line_target_id: string; user_id: string };
  const subs: SubRow[] = [];
  for (let i = 0; i < targetIds.length; i += 120) {
    const chunk = targetIds.slice(i, i + 120);
    const got = await pageAll<SubRow>(
      "cluster4_line_submissions",
      "id,line_target_id,user_id",
      (q) => q.in("line_target_id", chunk),
    );
    subs.push(...got);
  }
  console.log(`제출 총수(spring): ${subs.length}`);
  const subsByTarget = new Map<string, number>();
  for (const s of subs) subsByTarget.set(s.line_target_id, (subsByTarget.get(s.line_target_id) ?? 0) + 1);

  // evaluations
  type EvalRow = { line_target_id: string; user_id: string; rating: number | null };
  const evals: EvalRow[] = [];
  for (let i = 0; i < targetIds.length; i += 120) {
    const chunk = targetIds.slice(i, i + 120);
    const got = await pageAll<EvalRow>(
      "cluster4_experience_line_evaluations",
      "id,line_target_id,user_id,rating",
      (q) => q.in("line_target_id", chunk),
    );
    evals.push(...got);
  }
  console.log(`경험 평가 총수(spring): ${evals.length}`);

  // 5) 주차×파트 분포 (타깃을 테스터/실유저로 분리)
  const lineById = new Map(lines.map((l) => [l.id, l]));
  type Agg = { lines: Set<string>; testerTargets: number; realTargets: number; testerSubs: number; realSubs: number };
  const agg = new Map<string, Agg>(); // key = weekStart|part(또는 part:slotN)
  const subTargetSet = new Map<string, Set<string>>(); // target_id -> sub user ids? 단순 count로
  for (const s of subs) {
    if (!subTargetSet.has(s.line_target_id)) subTargetSet.set(s.line_target_id, new Set());
    subTargetSet.get(s.line_target_id)!.add(s.user_id);
  }
  for (const t of targets) {
    const line = lineById.get(t.line_id);
    if (!line) continue;
    const w = weekById.get(t.week_id) as any;
    let part = line.part_type;
    if (part === "experience" && line.experience_line_master_id) {
      part = `experience:slot${slotByMaster.get(line.experience_line_master_id) ?? "?"}`;
    }
    const key = `${w?.start_date}|${part}`;
    if (!agg.has(key)) agg.set(key, { lines: new Set(), testerTargets: 0, realTargets: 0, testerSubs: 0, realSubs: 0 });
    const a = agg.get(key)!;
    a.lines.add(line.id);
    const uid = t.target_user_id;
    const isTester = uid ? testerIds.has(uid) : false;
    if (isTester) a.testerTargets += 1; else a.realTargets += 1;
    const hasSub = (subsByTarget.get(t.id) ?? 0) > 0;
    if (hasSub) { if (isTester) a.testerSubs += 1; else a.realSubs += 1; }
  }
  console.log("\n=== 주차 × 파트 분포 (lines | 테스터타깃/제출 | 실유저타깃/제출) ===");
  const keys = [...agg.keys()].sort();
  for (const k of keys) {
    const a = agg.get(k)!;
    console.log(
      `${k.padEnd(34)} lines=${a.lines.size} tester=${a.testerTargets}/${a.testerSubs} real=${a.realTargets}/${a.realSubs}`,
    );
  }

  // 6) 실유저 타깃 상세: 어떤 유저가 어떤 파트에 데이터 갖고 있나
  const realUserParts = new Map<string, Map<string, number>>(); // uid -> part -> targets
  for (const t of targets) {
    const uid = t.target_user_id;
    if (!uid || testerIds.has(uid)) continue;
    const line = lineById.get(t.line_id);
    if (!line) continue;
    let part = line.part_type;
    if (part === "experience" && line.experience_line_master_id) {
      part = `experience:slot${slotByMaster.get(line.experience_line_master_id) ?? "?"}`;
    }
    if (!realUserParts.has(uid)) realUserParts.set(uid, new Map());
    const m = realUserParts.get(uid)!;
    m.set(part, (m.get(part) ?? 0) + 1);
  }
  console.log(`\n실유저(타깃 보유) 수: ${realUserParts.size}`);
  let shown = 0;
  for (const [uid, m] of realUserParts) {
    if (shown++ >= 12) break;
    console.log(`  ${uid}: ${[...m.entries()].map(([p, c]) => `${p}=${c}`).join(", ")}`);
  }

  // 7) 평가 rating 분포
  const ratingDist = new Map<number | null, number>();
  for (const e of evals) ratingDist.set(e.rating, (ratingDist.get(e.rating) ?? 0) + 1);
  console.log("\nrating 분포:", JSON.stringify([...ratingDist.entries()].sort()));

  // 8) experience 마스터 목록
  console.log("\n=== spring 에 등장한 experience 마스터 ===");
  for (const [id, name] of nameByMaster) console.log(`  slot${slotByMaster.get(id)} ${name} ${id}`);

  // 9) 테스터 1명 샘플: 주차별 보유 파트
  const sampleTester = [...testerIds][0];
  if (sampleTester) {
    console.log(`\n샘플 테스터 ${sampleTester} 주차별:`);
    const byWeek = new Map<string, string[]>();
    for (const t of targets) {
      if (t.target_user_id !== sampleTester) continue;
      const line = lineById.get(t.line_id)!;
      const w = weekById.get(t.week_id) as any;
      let part = line.part_type;
      if (part === "experience" && line.experience_line_master_id)
        part = `exp:s${slotByMaster.get(line.experience_line_master_id)}`;
      if (!byWeek.has(w.start_date)) byWeek.set(w.start_date, []);
      byWeek.get(w.start_date)!.push(part);
    }
    for (const [ws, parts] of [...byWeek.entries()].sort()) console.log(`  ${ws}: ${parts.sort().join(",")}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

/**
 * READ-ONLY: 레거시 통합(EXBS-UN*) 라인 대상 전수에서
 * "이력서 experienceCount(마감 기준·평점 무관)" vs "성공 주차 수(rating>=4)" 분해.
 * 패턴 '표시 5건 / 성공 2주차' 사용자 탐색용.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function pageAll<T>(table: string, select: string, mod: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await mod(sb.from(table).select(select).order("id")).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  // 통합 마스터의 라인들
  const { data: master } = await sb
    .from("cluster4_experience_line_masters")
    .select("id")
    .eq("line_code", "EXBS-UN")
    .maybeSingle();
  let masterId = (master as any)?.id;
  if (!masterId) {
    const { data: m2 } = await sb
      .from("cluster4_experience_line_masters")
      .select("id,line_code")
      .ilike("line_code", "%UN%");
    console.log("master candidates:", m2);
    masterId = (m2 as any[])?.[0]?.id;
  }
  const { data: lines } = await sb
    .from("cluster4_lines")
    .select("id,week_id")
    .eq("experience_line_master_id", masterId);
  const lineIds = (lines ?? []).map((l: any) => l.id);
  console.log(`통합 라인 수: ${lineIds.length}`);

  const targets = await pageAll<any>(
    "cluster4_line_targets",
    "id,target_user_id,week_id,line_id",
    (q) => q.eq("target_mode", "user").in("line_id", lineIds),
  );
  console.log(`통합 타깃 수: ${targets.length}`);

  const evals: any[] = [];
  const tids = targets.map((t) => t.id);
  for (let i = 0; i < tids.length; i += 100) {
    evals.push(
      ...(await pageAll<any>(
        "cluster4_experience_line_evaluations",
        "line_target_id,user_id,rating",
        (q) => q.in("line_target_id", tids.slice(i, i + 100)),
      )),
    );
  }
  const ratingByTarget = new Map(evals.map((e) => [e.line_target_id, e.rating]));

  type Acc = { total: number; success: number; fail: number; unrated: number };
  const byUser = new Map<string, Acc>();
  for (const t of targets) {
    const a = byUser.get(t.target_user_id) ?? { total: 0, success: 0, fail: 0, unrated: 0 };
    a.total++;
    const r = ratingByTarget.get(t.id);
    if (r == null) a.unrated++;
    else if (r >= 4) a.success++;
    else a.fail++;
    byUser.set(t.target_user_id, a);
  }

  // 분포 요약 + '5건/성공2' 패턴
  const hits: string[] = [];
  for (const [uid, a] of byUser) {
    if (a.total === 5 && a.success === 2) hits.push(uid);
  }
  console.log(`\n전체 사용자 ${byUser.size}명. total=5 & success=2 패턴: ${hits.length}명`);
  const { data: profs, error: pErr } = await sb
    .from("user_profiles")
    .select("user_id,name")
    .in("user_id", hits.length ? hits : ["00000000-0000-0000-0000-000000000000"]);
  if (pErr) console.log("profs err:", pErr.message);
  const nameById = new Map(((profs ?? []) as any[]).map((p) => [p.user_id, p.name]));
  const { data: tm } = await sb
    .from("test_user_markers")
    .select("user_id")
    .in("user_id", hits.length ? hits : ["00000000-0000-0000-0000-000000000000"]);
  const testers = new Set(((tm ?? []) as any[]).map((r) => r.user_id));
  for (const uid of hits) {
    const a = byUser.get(uid)!;
    console.log(
      `  ${uid} ${nameById.get(uid) ?? "(profile?)"}${testers.has(uid) ? " [tester]" : ""} total=${a.total} success=${a.success} fail=${a.fail} unrated=${a.unrated}`,
    );
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

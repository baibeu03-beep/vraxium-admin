/**
 * 진단(READ-ONLY): 라인 성공 보상 Point A·B 누락 가능 건수 추정.
 *   npx tsx --env-file=.env.local scripts/diag-line-payout-missing-estimate.ts
 *
 * 정의: "성공한 라인 대상자(마감 경과, user 타깃)" 중, 해당 라인 config(A 또는 B 설정됨)이 있으나
 *   process_point_awards(source='line', ref_id=line_id, user_id) 원장이 없는 (라인,유저) 쌍.
 *   강화 성공은 파생값이므로 여기서는 "마감 경과 + user 타깃" 을 성공 근사로 사용한다(평점 fail 제외는
 *   미반영 — 상한 추정치). 아무 것도 수정하지 않는다.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const EXP_MAP: Record<string, string> = { derivation: "derive", analysis: "analysis", evaluation: "research", extension: "expansion", management: "management" };

async function main() {
  const nowMs = Date.now();

  // 1) 활성 라인 전량(part_type/식별자/마감).
  const { data: lines } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id,part_type,line_code,activity_type_id,experience_line_master_id,competency_line_master_id,is_qa_test,submission_closes_at,is_active")
    .eq("is_active", true);
  const L = (lines ?? []) as Array<{
    id: string; part_type: string; line_code: string | null; activity_type_id: string | null;
    experience_line_master_id: string | null; competency_line_master_id: string | null;
    is_qa_test: boolean | null; submission_closes_at: string | null;
  }>;

  // config 존재 여부 캐시(A 또는 B 가 null 이 아니면 "지급 대상 config 있음").
  const { data: cfgRows } = await supabaseAdmin
    .from("cluster4_line_point_configs").select("organization_slug,hub,config_key,point_a,point_b");
  const cfgSet = new Set<string>();
  for (const c of (cfgRows ?? []) as Array<{ organization_slug: string; hub: string; config_key: string; point_a: number | null; point_b: number | null }>) {
    if (c.point_a !== null || c.point_b !== null) cfgSet.add(`${c.hub}:${c.config_key}`); // org 무시(존재만)
  }

  // 마스터 line_code / category 룩업(competency/experience config_key 도출).
  const compIds = L.filter((l) => l.part_type === "competency" && l.competency_line_master_id).map((l) => l.competency_line_master_id!) as string[];
  const expIds = L.filter((l) => l.part_type === "experience" && l.experience_line_master_id).map((l) => l.experience_line_master_id!) as string[];
  const compCode = new Map<string, string>();
  const expCat = new Map<string, string>();
  for (let i = 0; i < compIds.length; i += 200) {
    const { data } = await supabaseAdmin.from("cluster4_competency_line_masters").select("id,line_code").in("id", compIds.slice(i, i + 200));
    for (const r of (data ?? []) as Array<{ id: string; line_code: string | null }>) if (r.line_code) compCode.set(r.id, r.line_code);
  }
  for (let i = 0; i < expIds.length; i += 200) {
    const { data } = await supabaseAdmin.from("cluster4_experience_line_masters").select("id,experience_category").in("id", expIds.slice(i, i + 200));
    for (const r of (data ?? []) as Array<{ id: string; experience_category: string | null }>) if (r.experience_category) expCat.set(r.id, r.experience_category);
  }

  function configKeyFor(l: (typeof L)[number]): string | null {
    if (l.part_type === "info") return l.activity_type_id?.trim() || null;
    if (l.part_type === "career") return l.line_code?.trim() || null;
    if (l.part_type === "competency") return l.competency_line_master_id ? compCode.get(l.competency_line_master_id) ?? null : null;
    if (l.part_type === "experience") { const c = l.experience_line_master_id ? expCat.get(l.experience_line_master_id) : null; return c ? EXP_MAP[c] ?? null : null; }
    return null;
  }

  // 지급 대상 config 가 있는, 마감 경과 라인만 추림.
  const eligibleLines = L.filter((l) => {
    if (!l.submission_closes_at || new Date(l.submission_closes_at).getTime() >= nowMs) return false;
    const key = configKeyFor(l);
    if (!key) return false;
    return cfgSet.has(`${l.part_type}:${key}`);
  });
  const eligibleIds = eligibleLines.map((l) => l.id);

  // user 타깃 수(마감 경과 + config 있는 라인).
  let targetPairs = 0;
  const pairKeySet = new Set<string>();
  for (let i = 0; i < eligibleIds.length; i += 100) {
    const chunk = eligibleIds.slice(i, i + 100);
    const { data: tg } = await supabaseAdmin.from("cluster4_line_targets").select("line_id,target_user_id").eq("target_mode", "user").in("line_id", chunk);
    for (const t of (tg ?? []) as Array<{ line_id: string; target_user_id: string | null }>) {
      if (t.target_user_id) { targetPairs++; pairKeySet.add(`${t.line_id}:${t.target_user_id}`); }
    }
  }

  // 이미 지급된 line-source 원장 (라인,유저) 쌍.
  const paidSet = new Set<string>();
  for (let i = 0; i < eligibleIds.length; i += 100) {
    const chunk = eligibleIds.slice(i, i + 100);
    const { data: aw } = await supabaseAdmin.from("process_point_awards").select("ref_id,user_id").eq("source", "line").in("ref_id", chunk);
    for (const a of (aw ?? []) as Array<{ ref_id: string; user_id: string }>) paidSet.add(`${a.ref_id}:${a.user_id}`);
  }

  let missing = 0;
  for (const k of pairKeySet) if (!paidSet.has(k)) missing++;

  const byHub: Record<string, number> = {};
  for (const l of eligibleLines) byHub[l.part_type] = (byHub[l.part_type] ?? 0) + 1;

  console.log(JSON.stringify({
    activeLines: L.length,
    eligibleLines_pastDeadline_withConfig: eligibleLines.length,
    eligibleLinesByHub: byHub,
    userTargetPairs_onEligibleLines: targetPairs,
    distinctPairs: pairKeySet.size,
    alreadyPaidPairs: paidSet.size,
    estimatedMissingPayoutPairs: missing,
    note: "상한 추정 — 강화 성공(평점 fail/그레이드 D 제외)·org별 config 정확 매칭은 미반영. QA(is_qa_test) 라인 포함.",
  }, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });

/**
 * QA 시드 null-part 보정: 팀장(현재 membership part_name = null/빈문자)인 테스트 유저의
 *   QA 시드 UPH(source='qa_seed_test_history') 중 raw_part 가 문자열로 저장된 행을 **null 로 원복**한다.
 *
 * 배경: 직전 보정(reconcile)이 파트 미배정(팀장)을 "일반" 문자열로 잘못 저장 → 팀장이 일반 파트
 *   인원/셀로 집계되는 문제. 정책상 part_name=null 은 파트 미배정(팀장)이며 "일반"이 아니다.
 *
 * 범위: QA 시드 행(source=qa_seed_test_history) + 팀장(membership part null) 유저만.
 *   · 실제 membership part_name = '일반'(문자열) 유저는 대상 아님(그대로 유지).
 *   · 운영 UPH·실유저·team_halves·team_parts·uws 무접촉. 멱등·매니페스트 롤백.
 *
 *   미리보기: npx tsx --env-file=.env.local scripts/fix-qa-seed-null-part.ts
 *   적용:     ... --apply
 *   롤백:     ... --rollback
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const SRC = "qa_seed_test_history";
const MANIFEST = "claudedocs/fix-qa-seed-null-part.json";

type Mem = { team_name: string | null; part_name: string | null; is_current: boolean | null; updated_at: string | null };
function pickBest(rows: Mem[]): Mem | undefined {
  const rank = (m: Mem) => { const t = !!(m.team_name && m.team_name.trim()); if (m.is_current && t) return 0; if (t) return 1; if (m.is_current) return 2; return 3; };
  return [...rows].sort((a, b) => rank(a) - rank(b) || String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")))[0];
}

async function leaderUserIds(testIds: string[]): Promise<Set<string>> {
  const memByUser = new Map<string, Mem[]>();
  const CH = 40;
  for (let i = 0; i < testIds.length; i += CH) {
    const ids = testIds.slice(i, i + CH);
    const { data } = await supabaseAdmin.from("user_memberships").select("user_id,team_name,part_name,is_current,updated_at").in("user_id", ids);
    for (const m of (data ?? []) as any[]) (memByUser.get(m.user_id) ?? memByUser.set(m.user_id, []).get(m.user_id)!).push(m);
  }
  const leaders = new Set<string>();
  for (const uid of testIds) { const b = pickBest(memByUser.get(uid) ?? []); if (!((b?.part_name ?? "").trim())) leaders.add(uid); }
  return leaders;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const rollback = process.argv.includes("--rollback");

  if (rollback) {
    if (!existsSync(MANIFEST)) { console.log(`❌ 매니페스트 없음: ${MANIFEST}`); process.exit(1); }
    const man = JSON.parse(readFileSync(MANIFEST, "utf8")) as Array<{ id: string; old_raw_part: string | null }>;
    let n = 0;
    for (const r of man) { const { error } = await supabaseAdmin.from("user_position_histories").update({ raw_part: r.old_raw_part }).eq("id", r.id); if (error) { console.log(`❌ rollback @${r.id}: ${error.message}`); process.exit(1); } n++; }
    console.log(`✅ 롤백 ${n}행 원복(raw_part 재설정)`); process.exit(0);
  }

  const testIds = [...(await fetchTestUserMarkerIds())];
  const leaders = await leaderUserIds(testIds);
  console.log(`팀장(파트 미배정) 유저 = ${leaders.size}`);

  // qa_seed UPH 중 팀장 유저 & raw_part 가 non-null 인 행 = 잘못 저장된 대상.
  const target: Array<{ id: string; user_id: string; raw_part: string }> = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await supabaseAdmin.from("user_position_histories").select("id,user_id,raw_part").eq("source", SRC).range(from, from + 999);
    const b = (data ?? []) as any[]; for (const r of b) { if (leaders.has(r.user_id) && r.raw_part != null && String(r.raw_part).trim() !== "") target.push(r); }
    if (b.length < 1000) break;
  }
  const users = new Set(target.map((r) => r.user_id));
  const valDist: Record<string, number> = {};
  for (const r of target) valDist[r.raw_part] = (valDist[r.raw_part] || 0) + 1;
  console.log(`보정 대상(팀장 raw_part non-null) = ${target.length}행 (${users.size}명) · 현재값 분포=${JSON.stringify(valDist)}`);

  if (!apply) { console.log("\n(미리보기 — 적용하려면 --apply)"); process.exit(0); }
  if (target.length === 0) { console.log("✅ 변경 없음(이미 정합)."); process.exit(0); }

  writeFileSync(MANIFEST, JSON.stringify(target.map((r) => ({ id: r.id, old_raw_part: r.raw_part })), null, 0));
  let n = 0;
  for (const r of target) { const { error } = await supabaseAdmin.from("user_position_histories").update({ raw_part: null }).eq("id", r.id); if (error) { console.log(`❌ update @${r.id}: ${error.message}`); process.exit(1); } n++; }
  console.log(`✅ 보정 ${n}행 raw_part→null · 매니페스트=${MANIFEST}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });

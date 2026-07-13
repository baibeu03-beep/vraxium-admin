/**
 * QA 과거 시드 보정: 2025-H2·2026-H1 에 시드한 UPH(source='qa_seed_test_history')의
 *   raw_team/raw_part 를 **현재 user_memberships 배정(사용자 화면 SoT)** 에 맞춰 재정렬한다.
 *   → 과거(UPH)와 현재 반기(user_memberships 폴백)의 팀·파트 시간축을 일치시킨다.
 *
 * 최초 시드는 라운드로빈(임의) 배정이라 실제 배정과 82/91 불일치. 본 스크립트는 그 시드 행만
 *   in-place UPDATE 한다. 운영/실유저/2026-H2/team_halves/team_parts/uws 무접촉.
 *
 *   미리보기: npx tsx --env-file=.env.local scripts/reconcile-qa-test-team-history.ts
 *   적용:     ... --apply       (변경 전 값 매니페스트 저장 → 정확 롤백)
 *   롤백:     ... --rollback     (매니페스트로 원복)
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const SRC = "qa_seed_test_history";
const DEFAULT_PART = "일반";
const MANIFEST = "claudedocs/reconcile-qa-test-team-history.json";

type Mem = { team_name: string | null; part_name: string | null; is_current: boolean | null; updated_at: string | null };
function pickBest(rows: Mem[]): Mem | undefined {
  const rank = (m: Mem) => {
    const t = typeof m.team_name === "string" && m.team_name.trim() !== "";
    if (m.is_current && t) return 0; if (t) return 1; if (m.is_current) return 2; return 3;
  };
  return [...rows].sort((a, b) => rank(a) - rank(b) || String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")))[0];
}

async function resolveAssignments(testIds: string[]) {
  const memByUser = new Map<string, Mem[]>();
  const CH = 40;
  for (let i = 0; i < testIds.length; i += CH) {
    const ids = testIds.slice(i, i + CH);
    const { data } = await supabaseAdmin.from("user_memberships")
      .select("user_id,team_name,part_name,is_current,updated_at").in("user_id", ids);
    for (const m of (data ?? []) as any[]) (memByUser.get(m.user_id) ?? memByUser.set(m.user_id, []).get(m.user_id)!).push(m);
  }
  const { data: profs } = await supabaseAdmin.from("user_profiles")
    .select("user_id,current_team_name,current_part_name").in("user_id", testIds);
  const profByUser = new Map<string, any>(); for (const p of (profs ?? []) as any[]) profByUser.set(p.user_id, p);

  const assign = new Map<string, { team: string; part: string | null }>();
  for (const uid of testIds) {
    const best = pickBest(memByUser.get(uid) ?? []);
    const prof = profByUser.get(uid);
    const team = (best?.team_name ?? "").trim() || (prof?.current_team_name ?? "").trim();
    // 파트 = user_memberships.part_name 실제값(로더 SoT와 동일). 미배정(팀장)=null → "일반" 변환 금지.
    const part = (best?.part_name ?? "").trim() || null;
    if (team) assign.set(uid, { team, part });
  }
  return assign;
}

async function pagedSeedRows() {
  const rows: Array<{ id: string; user_id: string; raw_team: string; raw_part: string | null }> = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await supabaseAdmin.from("user_position_histories")
      .select("id,user_id,raw_team,raw_part").eq("source", SRC).range(from, from + 999);
    const b = (data ?? []) as any[]; rows.push(...b); if (b.length < 1000) break;
  }
  return rows;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const rollback = process.argv.includes("--rollback");

  if (rollback) {
    if (!existsSync(MANIFEST)) { console.log(`❌ 매니페스트 없음: ${MANIFEST}`); process.exit(1); }
    const man = JSON.parse(readFileSync(MANIFEST, "utf8")) as Array<{ id: string; old: { raw_team: string; raw_part: string | null } }>;
    let n = 0;
    for (let i = 0; i < man.length; i += 200) {
      for (const r of man.slice(i, i + 200)) {
        const { error } = await supabaseAdmin.from("user_position_histories").update({ raw_team: r.old.raw_team, raw_part: r.old.raw_part }).eq("id", r.id);
        if (error) { console.log(`❌ rollback @${r.id}: ${error.message}`); process.exit(1); } n++;
      }
    }
    console.log(`✅ 롤백 ${n}행 원복`); process.exit(0);
  }

  const testIds = [...(await fetchTestUserMarkerIds())];
  const assign = await resolveAssignments(testIds);
  const seedRows = await pagedSeedRows();

  // 변경 대상 계산. raw_part 는 null 허용(팀장=파트 미배정) — null 정규화 후 비교(멱등).
  const norm = (v: string | null | undefined) => ((v ?? "").trim() || null);
  const changes: Array<{ id: string; user_id: string; old: { raw_team: string; raw_part: string | null }; neu: { raw_team: string; raw_part: string | null } }> = [];
  const usersChanged = new Set<string>();
  for (const r of seedRows) {
    const a = assign.get(r.user_id); if (!a) continue;
    if (r.raw_team !== a.team || norm(r.raw_part) !== norm(a.part)) {
      changes.push({ id: r.id, user_id: r.user_id, old: { raw_team: r.raw_team, raw_part: r.raw_part }, neu: { raw_team: a.team, raw_part: a.part } });
      usersChanged.add(r.user_id);
    }
  }
  console.log(`시드 UPH 행=${seedRows.length} · 배정 유저=${assign.size}`);
  console.log(`보정 대상: ${changes.length}행 (${usersChanged.size}명)`);
  // 팀 이동 요약
  const teamMoves: Record<string, number> = {};
  const perUser = new Map<string, { from: string; to: string }>();
  for (const c of changes) if (!perUser.has(c.user_id)) perUser.set(c.user_id, { from: `${c.old.raw_team}/${c.old.raw_part}`, to: `${c.neu.raw_team}/${c.neu.raw_part}` });
  for (const { from, to } of perUser.values()) { const k = `${from} → ${to}`; teamMoves[k] = (teamMoves[k] || 0) + 1; }
  console.log("유저 배정 이동(상위 12):");
  Object.entries(teamMoves).sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([k, v]) => console.log(`  ${k}: ${v}명`));

  if (!apply) { console.log("\n(미리보기 — 적용하려면 --apply)"); process.exit(0); }
  if (changes.length === 0) { console.log("✅ 변경 없음(이미 정합)."); process.exit(0); }

  writeFileSync(MANIFEST, JSON.stringify(changes.map((c) => ({ id: c.id, old: c.old })), null, 0));
  let n = 0;
  for (const c of changes) {
    const { error } = await supabaseAdmin.from("user_position_histories").update({ raw_team: c.neu.raw_team, raw_part: c.neu.raw_part }).eq("id", c.id);
    if (error) { console.log(`❌ update @${c.id}: ${error.message}`); process.exit(1); } n++;
  }
  console.log(`✅ 보정 ${n}행 적용 · 매니페스트=${MANIFEST}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });

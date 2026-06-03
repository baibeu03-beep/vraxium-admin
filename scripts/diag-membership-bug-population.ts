/**
 * raw user_memberships/user_profiles 전수 스캔 — 고객앱 resolver 가 고치는 두 버그 패턴을 분류한다.
 *   npx tsx --env-file=.env.local scripts/diag-membership-bug-population.ts
 *
 * 패턴 A: is_current=true 행의 team_name 이 NULL 이지만, 같은 사용자에 team_name 보유 행이 있다.
 *         → 구 picker(is_current 우선)는 NULL 행을 골라 team 이 빈다.
 * 패턴 B: 모든 membership 행 team_name 이 NULL 이고(구 picker 도 NULL), profile.current_team_name 은 존재.
 *         → 규칙 5(profile 폴백)로만 복구 가능.
 * 패턴 C: 구 picker team ≠ 신 picker team (행 재선택으로 값이 바뀜).
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type MemRow = {
  user_id: string;
  team_name: string | null;
  part_name: string | null;
  is_current: boolean | null;
  updated_at: string | null;
};
const has = (s: string | null) => typeof s === "string" && s.trim() !== "";
function pickOld(rows: MemRow[]) {
  return [...rows].sort((a, b) => {
    const c = Number(Boolean(b.is_current)) - Number(Boolean(a.is_current));
    if (c !== 0) return c;
    return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
  })[0];
}
function rank(r: MemRow) {
  const cur = Boolean(r.is_current), team = has(r.team_name);
  return cur && team ? 0 : team ? 1 : cur ? 2 : 3;
}
function pickNew(rows: MemRow[]) {
  return [...rows].sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
  })[0];
}

async function main() {
  const { data: mems } = await supabaseAdmin
    .from("user_memberships")
    .select("user_id,team_name,part_name,is_current,updated_at");
  const byUser = new Map<string, MemRow[]>();
  for (const r of (mems ?? []) as MemRow[]) {
    const l = byUser.get(r.user_id) ?? [];
    l.push(r);
    byUser.set(r.user_id, l);
  }
  const { data: profs } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name,current_team_name,current_part_name");
  const prof = new Map<string, any>();
  for (const p of (profs ?? []) as any[]) prof.set(p.user_id, p);

  const A: string[] = [], B: string[] = [], C: string[] = [];
  for (const [uid, rows] of byUser) {
    const cur = rows.find((r) => Boolean(r.is_current));
    if (cur && !has(cur.team_name) && rows.some((r) => has(r.team_name))) A.push(uid);
    if (rows.every((r) => !has(r.team_name)) && has(prof.get(uid)?.current_team_name)) B.push(uid);
    if ((pickOld(rows)?.team_name ?? null) !== (pickNew(rows)?.team_name ?? null)) C.push(uid);
  }

  const name = (id: string) => prof.get(id)?.display_name ?? id.slice(0, 8);
  const show = (label: string, ids: string[]) => {
    console.log(`\n${label}: ${ids.length}명`);
    for (const id of ids.slice(0, 20)) console.log(`   - ${name(id)} (${id.slice(0, 8)})`);
  };
  console.log(`총 membership 보유 사용자 ${byUser.size}명.`);
  show("패턴 A (is_current=true·team=NULL + 다른 team 보유 행)", A);
  show("패턴 B (전 행 team NULL + profile.current_team_name 존재 → 규칙5)", B);
  show("패턴 C (구 picker team ≠ 신 picker team)", C);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
